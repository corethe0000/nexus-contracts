//Verifies the CLAIM FEE on real mainnet (the one thing the private/hybrid chain never charges): run a real escrow
//between three funded accounts and show the claim is REJECTED without a fee and ACCEPTED with the fee the module
//computes (claimFee). Config JSON (argv[2]): { url, auth:{user,password}, users:{ S, R, B } } where each user is
//{ username, password, pin, account }. S = sender/funder, R = arbiter, B = recipient.
//  tsx core/src/mainnet-fee.ts /tmp/mainnet-fee.json
import { readFileSync } from 'node:fs';
import { creditContract, debitContract, feeContract, memoryOfAddress, nameContract, nameWriteContract, addressOfMemory, type AccountState } from '../../../wallet/src/lib/tritium';
import { parseSlot } from '../../../wallet/src/lib/htlc';
import { NexusNode, type Credentials } from '../../../dex/core/src/nexus/node';
import { encode } from './condition/encode';
import { costOf, claimFee } from './cost';
import { decision, decisionAddress, decisionName, decisionValue, escrow } from './templates';

type U = Credentials & { account: string };
const cfg = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const node = new NexusNode(cfg.url, cfg.auth);
const S: U = cfg.users.S, R: U = cfg.users.R, B: U = cfg.users.B;
const nxs = (n: number) => BigInt(Math.round(n * 1e6));
const fmt = (b: bigint) => (Number(b) / 1e6).toFixed(6);
const log = (...a: unknown[]) => console.log(...a);

async function confirm(txid: string, what: string) {
  await node.waitConfirmed(txid);
  log(`  confirmed ${what}: ${txid.slice(0, 12)}`);
}
//a plain send with no condition, then the recipient credits it (free): gives an account some NXS to work with
async function fund(to: U, amount: bigint) {
  const sSt = await node.accountState(S.account);
  const tx = await node.submit(S, sSt.owner, (ts) => [debitContract({ from: { address: S.account, state: sSt }, to: to.account, amount }, ts)]);
  await confirm(tx, `fund debit ${fmt(amount)} -> ${to.username}`);
  const tSt = await node.accountState(to.account);
  const cr = await node.submit(to, tSt.owner, (ts) => [creditContract({ debitTxid: tx, contract: 0, to: { address: to.account, state: tSt }, from: S.account, amount }, ts)]);
  await confirm(cr, `${to.username} credits the funding`);
}

async function main() {
  const s0 = await node.accountState(S.account);
  const r0 = await node.accountState(R.account);
  const b0 = await node.accountState(B.account);
  log('start balances  S', fmt(s0.balance), ' R', fmt(r0.balance), ' B', fmt(b0.balance));
  const Sg = s0.owner, Rg = r0.owner, Bg = b0.owner;
  const id = 'fee' + Math.random().toString(36).slice(2, 7);
  const escrowAmt = nxs(0.3);

  //1. fund the arbiter (needs 1 NXS name fee) and the recipient (needs gas for the claim fee)
  if (r0.balance < nxs(1.2)) await fund(R, nxs(2));
  if (b0.balance < nxs(0.1)) await fund(B, nxs(0.2));

  //2. arbiter creates the decision register and sets it to RELEASE (name fee 1 NXS, paid by the arbiter)
  const rSt = await node.accountState(R.account);
  const nameFee = nxs(1);
  const mk = await node.submit(R, Rg, (ts) => [nameContract(Rg, decisionName(id), new Uint8Array(32), false, ts), feeContract(memoryOfAddress(R.account), rSt, nameFee, ts)]);
  await confirm(mk, `arbiter creates decision ${id}`);
  const slot = parseSlot(await node.call('register/get/any', { address: addressOfMemory(decisionAddress(Rg, id)) }));
  const setTx = await node.submit(R, Rg, (ts) => [nameWriteContract(Rg, decisionName(id), { created: slot.created, modified: slot.modified, address: slot.value }, decisionValue(decision.release), ts)]);
  await confirm(setTx, 'arbiter sets it to RELEASE');

  //3. sender locks the escrow to the recipient, conditioned on the arbiter's decision
  const cond = escrow({ sender: Sg, recipient: Bg, arbiter: Rg, id });
  const cost = costOf(cond), fee = claimFee(cond);
  log(`escrow condition cost = ${cost} (free limit 4096) -> module claim fee = ${fmt(fee)} NXS`);
  const sSt = await node.accountState(S.account);
  const lock = await node.submit(S, Sg, (ts) => [debitContract({ from: { address: S.account, state: sSt }, to: B.account, amount: escrowAmt, condition: encode(cond) }, ts)]);
  await confirm(lock, `sender locks ${fmt(escrowAmt)} NXS escrow`);

  //4a. NEGATIVE: recipient claims with NO fee -> the chain must reject it
  const bNo = await node.accountState(B.account);
  let noFeeErr = '';
  try {
    const bad = await node.submit(B, Bg, (ts) => [creditContract({ debitTxid: lock, contract: 0, to: { address: B.account, state: bNo }, from: S.account, amount: escrowAmt }, ts)]);
    await node.waitConfirmed(bad);
    noFeeErr = 'ACCEPTED (unexpected: no fee was required)';
  } catch (e) {
    noFeeErr = (e as Error).message;
  }
  log(`claim WITHOUT fee -> ${noFeeErr}`);

  //4b. POSITIVE: recipient claims WITH the module's fee -> accepted; fee paid from the just-credited amount
  const bYes = await node.accountState(B.account);
  const feeState: AccountState = { ...bYes, balance: bYes.balance + escrowAmt, modified: 0 };
  const good = await node.submit(B, Bg, (ts) => [
    creditContract({ debitTxid: lock, contract: 0, to: { address: B.account, state: bYes }, from: S.account, amount: escrowAmt }, ts),
    feeContract(memoryOfAddress(B.account), { ...feeState, modified: ts }, fee, ts),
  ]);
  await confirm(good, 'recipient claims WITH the fee');

  const b1 = await node.accountState(B.account);
  const gained = b1.balance - bYes.balance;
  log(`recipient balance ${fmt(bYes.balance)} -> ${fmt(b1.balance)}  (gained ${fmt(gained)}, escrow ${fmt(escrowAmt)} minus fee ${fmt(escrowAmt - gained)})`);

  const feeCharged = escrowAmt - gained;
  const pass = noFeeErr.toLowerCase().includes('fee') && feeCharged === fee;
  log(`\nRESULT: claim rejected without fee = ${noFeeErr.toLowerCase().includes('fee')}; fee charged = ${fmt(feeCharged)} NXS; matches module claimFee ${fmt(fee)} = ${feeCharged === fee}`);
  log(pass ? 'FEE VERIFIED on mainnet' : 'CHECK the numbers above');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('FAILED', e); process.exit(2); });
