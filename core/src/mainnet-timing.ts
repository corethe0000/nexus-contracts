//Validates the time-based templates on real mainnet (return-if-unclaimed, time-lock): the deadline conditions read
//ledger.timestamp, and unlike the private chain, mainnet makes blocks on its own (~50s) so a short deadline simply
//passes. Claims carry the module's fee when the condition is over the free limit (these are usually under it).
//Config as mainnet-fee.ts. S = sender, B = recipient.
//  tsx core/src/mainnet-timing.ts /tmp/mainnet-fee.json
import { readFileSync } from 'node:fs';
import { creditContract, debitContract, feeContract, memoryOfAddress, type AccountState } from '../../../wallet/src/lib/tritium';
import { NexusNode, type Credentials } from '../../../dex/core/src/nexus/node';
import { encode } from './condition/encode';
import { claimFee } from './cost';
import { returnIfUnclaimed, timeLock } from './templates';
import type { Condition } from './condition/ast';

type U = Credentials & { account: string };
const cfg = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const node = new NexusNode(cfg.url, cfg.auth);
const S: U = cfg.users.S, B: U = cfg.users.B;
const amount = BigInt(Math.round(0.1 * 1e6));
const results: Record<string, string> = {};
const log = (...a: unknown[]) => console.log(...a);
const outcome = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e) => String((e as Error).message).replace(/.*REJECTED: /, '').slice(0, 60));

//credit one locked contract into `into`, adding the module's fee when the condition charges one
async function claimInto(who: U, gen: string, lockTx: string, contract: number, cond: Condition, into: string) {
  const fee = claimFee(cond);
  const st = await node.accountState(into);
  return node.submit(who, gen, (ts) => {
    const list = [creditContract({ debitTxid: lockTx, contract, to: { address: into, state: st }, from: S.account, amount }, ts)];
    if (fee > 0n) list.push(feeContract(memoryOfAddress(into), { ...st, balance: st.balance + amount, modified: ts }, fee, ts));
    return list;
  }).then((tx) => node.waitConfirmed(tx));
}

async function check(label: string, p: Promise<unknown>, want: boolean) {
  const r = await outcome(p);
  results[label] = r;
  log(`${want ? 'want OK ' : 'want NO '} ${label}: ${r}`);
}

async function main() {
  const s0 = await node.accountState(S.account);
  const b0 = await node.accountState(B.account);
  const Sg = s0.owner, Bg = b0.owner;
  const now = Math.max(Math.floor(Date.now() / 1000), (await node.tip()).timestamp);
  const unlock = now + 120;
  const c0 = returnIfUnclaimed({ sender: Sg, recipient: Bg, deadline: now + 3600 });
  const c1 = timeLock({ sender: Sg, recipient: Bg, unlock });
  const conds = [c0, c1];

  const lockTx = await node.submit(S, Sg, (ts) => {
    let state: AccountState = s0;
    return conds.map((c) => {
      const out = debitContract({ from: { address: S.account, state }, to: B.account, amount, condition: encode(c) }, ts);
      state = { ...state, balance: state.balance - amount, modified: ts };
      return out;
    });
  });
  await node.waitConfirmed(lockTx);
  log('locked 2 contracts:', lockTx.slice(0, 12), `(return-if-unclaimed, time-lock unlock in 120s)`);

  //return-if-unclaimed: sender cannot take it back before the deadline, recipient can claim in time
  await check('return-if-unclaimed: sender takes back early', claimInto(S, Sg, lockTx, 0, c0, S.account), false);
  await check('return-if-unclaimed: recipient claims in time', claimInto(B, Bg, lockTx, 0, c0, B.account), true);

  //time-lock: recipient cannot claim before unlock
  await check('time-lock: recipient claims before unlock', claimInto(B, Bg, lockTx, 1, c1, B.account), false);
  //mainnet makes its own blocks; wait until the tip passes the unlock time
  while ((await node.tip()).timestamp < unlock + 2) {
    await new Promise((r) => setTimeout(r, 10000));
  }
  await check('time-lock: recipient claims after unlock', claimInto(B, Bg, lockTx, 1, c1, B.account), true);

  const pass = results['return-if-unclaimed: sender takes back early'] !== 'ACCEPTED'
    && results['return-if-unclaimed: recipient claims in time'] === 'ACCEPTED'
    && results['time-lock: recipient claims before unlock'] !== 'ACCEPTED'
    && results['time-lock: recipient claims after unlock'] === 'ACCEPTED';
  log('\n' + JSON.stringify(results, null, 1));
  log(pass ? 'TIMING TEMPLATES VERIFIED on mainnet' : 'CHECK the results above');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('FAILED', e); process.exit(2); });
