//The Nexus side of the module: the profile signed in here, people, sending a contract, claiming one, the arbiter's
//decisions and the lists of sent and incoming contracts. Transactions are built and signed in this page (the core's
//API can only add an expiry condition); username, password and PIN stay in memory only.
import { NexusNode, NodeError, type Credentials } from '../../../../dex/core/src/nexus/node';
import { nodeFor, inWallet } from '../../../../dex/app/src/lib/module';
import { network, refresh, type NexusAccount, type NexusNet } from '../../../../dex/app/src/lib/nexus';
import { checkCredentials, findGenesis, scanOwnRegisters, type RegisterScan } from '../../../../wallet/src/lib/profile-chain';
import { recentBlocks } from '../../../../wallet/src/lib/blocks';
import { conditionOf, parseSlot } from '../../../../wallet/src/lib/htlc';
import { addressOfMemory, creditContract, debitContract, feeContract, hexOfMemory, memoryOfAddress, memoryOfHex, nameContract, nameFee, namedAddress, nameWriteContract, parseTx } from '../../../../wallet/src/lib/tritium';
import { t } from './i18n';
import { claimFee, codeBoxAddress, codeBoxName, codeSecret, contractKind, decisionAddress, decisionName, decode, type Condition, type ContractKind } from '@nexus-contracts/core/src';

export type { NexusAccount };

const addrName = 0xd9;

export function makeNode(): NexusNode {
  return inWallet() ? nodeFor('wallet') : new NexusNode(import.meta.env.VITE_NEXUS_NODE ?? '/nexus');
}

export interface Session {
  username: string;
  genesis: string;
  who: Credentials;
  accounts: NexusAccount[];
  net: NexusNet;
  scan?: RegisterScan; //own registers found so far, so later reads only go through what is new
}

export async function signIn(node: NexusNode, username: string, password: string, pin: string): Promise<Session> {
  const name = username.trim();
  const net = await network(node);
  const { genesis, auth } = await findGenesis((m, p) => node.call(m, p), name, net.testnet || net.private);
  await checkCredentials(name, password, pin, auth);
  const s: Session = { username: name, genesis, who: { username: name, password, pin }, accounts: [], net };
  await reloadAccounts(node, s);
  return s;
}

export async function reloadAccounts(node: NexusNode, s: Session): Promise<void> {
  const p = { username: s.username, genesis: s.genesis, accounts: [] as NexusAccount[], slotReady: false, signer: null as never, via: 'page' as const, scan: s.scan };
  await refresh(node, p);
  //an account read that failed this time (busy node) drops out of the list: keep the one known before
  const found = new Set(p.accounts.map((a) => a.address));
  const own = new Set((p.scan?.registers ?? []).map((r) => r.address));
  s.accounts = [...p.accounts, ...s.accounts.filter((a) => !found.has(a.address) && own.has(a.address))];
  s.scan = p.scan;
}

//names cost a fee on mainnet and testnet, none on hybrid / private chains
export const nameFeeOn = (net: NexusNet) => (net.private || net.hybrid ? 0n : nameFee);

//--- people ---

export interface Person {
  username?: string;
  genesis: string;
  account?: string; //their "default" NXS account, where a payment goes
}

/** A username or a 64 digit genesis id */
export async function findPerson(node: NexusNode, s: Session, text: string): Promise<Person> {
  const q = text.trim();
  if (/^[0-9a-f]{64}$/i.test(q)) {
    const genesis = q.toLowerCase();
    return { genesis, account: await defaultAccount(node, genesis) };
  }
  if (!q) {
    throw new Error(t('Enter a username'));
  }
  const { genesis } = await findGenesis((m, p) => node.call(m, p), q, s.net.testnet || s.net.private);
  return { username: q, genesis, account: await defaultAccount(node, genesis) };
}

async function defaultAccount(node: NexusNode, genesis: string): Promise<string | undefined> {
  const r = await node.call<any>('register/get/any', { address: addressOfMemory(namedAddress('default', memoryOfHex(genesis), addrName)) }).catch(() => null);
  const a = r?.register;
  return typeof a === 'string' && a.length > 40 ? a : undefined;
}

//--- sending and claiming ---

export async function sendContract(node: NexusNode, s: Session, p: { from: string; to: string; amount: bigint; condition: Uint8Array }): Promise<string> {
  const state = await node.accountState(p.from);
  return node.submit(s.who, s.genesis, (ts) => [debitContract({ from: { address: p.from, state }, to: p.to, amount: p.amount, condition: p.condition }, ts)]);
}

/** Several payments with their own rules in one transaction (vesting, milestones), each on the balance the last left */
export async function sendContracts(node: NexusNode, s: Session, p: { from: string; to: string; parts: { amount: bigint; condition: Uint8Array }[] }): Promise<string> {
  if (p.parts.length < 1 || p.parts.length > 50) {
    throw new Error(t('1 to 50 parts'));
  }
  const first = await node.accountState(p.from);
  return node.submit(s.who, s.genesis, (ts) => {
    let state = first;
    return p.parts.map((part) => {
      const out = debitContract({ from: { address: p.from, state }, to: p.to, amount: part.amount, condition: part.condition }, ts);
      state = { ...state, balance: state.balance - part.amount, modified: ts };
      return out;
    });
  });
}

/** CREDIT of one contract into an own account: the recipient's account to claim, the sender's to take it back */
//conditions that read registers cost more than the free limit: on a chain with fees the claim pays the rest
export const feeForCondition = (net: NexusNet, c: Condition | null) => (net.private || net.hybrid || !c ? 0n : claimFee(c));
export const claimFeeOn = (net: NexusNet, c: ChainContract) => feeForCondition(net, c.condition);

export async function claim(node: NexusNode, s: Session, c: ChainContract, into: string): Promise<string> {
  const fee = claimFeeOn(s.net, c);
  const payer = fee > 0n ? nxsPayer(s, fee) : undefined;
  if (fee > 0n && !payer) {
    throw new Error(t('This claim needs a network fee of {fee} NXS and none of your NXS accounts has it', { fee: (Number(fee) / 1e6).toString() }));
  }
  const state = await node.accountState(into);
  const payerState = payer && payer !== into ? await node.accountState(payer) : undefined;
  return node.submit(s.who, s.genesis, (ts) => {
    const list = [creditContract({ debitTxid: c.txid, contract: c.contract, to: { address: into, state }, from: c.from, amount: c.open }, ts)];
    if (payer) {
      //paying from the account that just received: the fee works on its state after the credit
      const feeState = payer === into ? { ...state, balance: state.balance + c.open, modified: ts } : payerState!;
      list.push(feeContract(memoryOfAddress(payer), feeState, fee, ts));
    }
    return list;
  });
}

//--- the arbiter's decision registers (escrow) ---

export interface DecisionState {
  exists: boolean;
  owner?: string;
  value?: number; //0 open, 1 release, 2 refund, other = not a decision
  created?: number;
  modified?: number;
  raw?: Uint8Array;
}

export async function decisionState(node: NexusNode, arbiter: string, id: string): Promise<DecisionState> {
  const r = await node.call<any>('register/get/any', { address: addressOfMemory(decisionAddress(arbiter, id)) }).catch((e) => {
    if (e instanceof NodeError) {
      return null;
    }
    throw e;
  });
  if (!r) {
    return { exists: false };
  }
  const slot = parseSlot(r);
  const v = slot.value;
  const value = v.slice(1).every((x) => x === 0) ? v[0]! : -1;
  return { exists: true, owner: String(r.owner ?? ''), value, created: slot.created, modified: slot.modified, raw: v };
}

function nxsPayer(s: Session, fee: bigint): string | undefined {
  return s.accounts.find((a) => a.token === '0' && a.address !== a.token && a.balance >= fee)?.address;
}

export async function createDecision(node: NexusNode, s: Session, id: string): Promise<string> {
  const name = decisionName(id);
  const fee = nameFeeOn(s.net);
  const payer = fee > 0n ? nxsPayer(s, fee) : undefined;
  if (fee > 0n && !payer) {
    throw new Error(t('A decision register costs a 1 NXS name fee: no NXS account has it'));
  }
  const state = payer ? await node.accountState(payer) : undefined;
  return node.submit(s.who, s.genesis, (ts) => {
    const list = [nameContract(s.genesis, name, new Uint8Array(32), false, ts)];
    if (payer && state) {
      list.push(feeContract(memoryOfAddress(payer), state, fee, ts));
    }
    return list;
  });
}

export async function setDecision(node: NexusNode, s: Session, id: string, value: number): Promise<string> {
  const d = await decisionState(node, s.genesis, id);
  if (!d.exists) {
    throw new Error(t('This escrow id has no decision register yet'));
  }
  const v = new Uint8Array(32);
  v[0] = value;
  return node.submit(s.who, s.genesis, (ts) => [nameWriteContract(s.genesis, decisionName(id), { created: d.created!, modified: d.modified!, address: d.raw! }, v, ts)]);
}

//--- contracts on chain ---

export interface ChainContract {
  txid: string;
  contract: number;
  time: number; //transaction time
  sender: string; //genesis
  from: string; //account it came from
  to: string; //account it pays
  token: string;
  ticker: string;
  amount: bigint; //base units
  open: bigint; //not claimed yet
  decimals: number;
  condition: Condition | null; //null = a form this module does not read
  kind: ContractKind;
  conditionBytes: Uint8Array;
}

const addressOf = (v: unknown) => (typeof v === 'object' && v ? (v as { address?: string }).address : (v as string | undefined)) ?? '';

const tokenCache = new Map<string, { decimals: number; ticker: string }>();
const accountTokens = new Map<string, { token: string; decimals: number; ticker: string }>();
//the node prints a DEBIT's condition in its summaries: only those with one are contracts
const hasCondition = (c: any) => c.OP === 'DEBIT' && String(c.conditions ?? '').trim() !== '';
async function tokenOf(node: NexusNode, account: string): Promise<{ token: string; decimals: number; ticker: string }> {
  //an account never changes its token: one read per account. No guessing: wrong decimals would scale the amount
  const known = accountTokens.get(account);
  if (known) {
    return known;
  }
  const st = await node.accountState(account);
  if (!tokenCache.has(st.token)) {
    const t = st.token === '0' ? null : await node.call<any>('register/get/any', { address: st.token }).catch(() => null);
    tokenCache.set(st.token, { decimals: st.decimals, ticker: st.token === '0' ? 'NXS' : String(t?.ticker ?? t?.name ?? 'token') });
  }
  const out = { token: st.token, ...tokenCache.get(st.token)! };
  accountTokens.set(account, out);
  return out;
}

//a contract is vec(operation) vec(condition) vec(register); DEBIT = op byte, from 32, to 32, amount u64 LE
function debitAmount(contract: Uint8Array): bigint {
  const first = contract[0]!;
  const start = first < 253 ? 1 : 3;
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(contract[start + 65 + i]!);
  }
  return v;
}

function decimalToBase(v: unknown, decimals: number): bigint {
  const t = typeof v === 'number' ? v.toFixed(decimals) : String(v ?? '0');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t.trim());
  if (!m) {
    return 0n;
  }
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

/** Every DEBIT with a condition in one transaction */
//a transaction's bytes never change: read once. Its summary carries what is still open, so it is read fresh
//(or taken from a list read just now)
const rawCache = new Map<string, ReturnType<typeof parseTx>>();

export async function readContracts(node: NexusNode, txid: string, summary?: any): Promise<ChainContract[]> {
  const cached = rawCache.get(txid);
  const [tx, parsed] = await Promise.all([
    summary ?? node.call<any>('ledger/get/transaction', { hash: txid, verbose: 'summary' }),
    cached ?? node.call<{ data: string }>('ledger/get/transaction', { hash: txid, format: 'raw' }).then((r) => parseTx(r.data)),
  ]);
  if (!cached) {
    rawCache.set(txid, parsed);
  }
  const out: ChainContract[] = [];
  for (const c of tx.contracts ?? []) {
    if (c.OP !== 'DEBIT') {
      continue;
    }
    const bytes = parsed.contractBytes[c.id as number];
    const cond = bytes ? conditionOf(bytes) : new Uint8Array(0);
    if (cond.length === 0) {
      continue;
    }
    let condition: Condition | null = null;
    try {
      condition = decode(cond);
    } catch {
      condition = null;
    }
    const from = addressOf(c.from);
    const { token, decimals, ticker } = await tokenOf(node, from);
    //the exact amount from the DEBIT itself; the node's decimal "claimed" goes through text, not float math
    const amount = bytes ? debitAmount(bytes) : decimalToBase(c.amount, decimals);
    const claimedRaw = decimalToBase(c.claimed ?? 0, decimals);
    const claimed = claimedRaw > amount ? amount : claimedRaw;
    out.push({ txid, contract: c.id, time: tx.timestamp, sender: parsed.genesis, from, to: addressOf(c.to), token, ticker, amount, open: amount - claimed, decimals, condition, kind: condition ? contractKind(condition) : 'contract', conditionBytes: Uint8Array.from(cond) });
  }
  return out;
}

/** Contracts this profile sent, from its newest transactions */
export async function sentContracts(node: NexusNode, s: Session, limit = 100): Promise<ChainContract[]> {
  const list = await node.call<any[]>('ledger/list/transactions', { genesis: s.genesis, limit, verbose: 'summary' }).catch(() => []);
  const withRules = list.filter((t) => (t.contracts ?? []).some(hasCondition));
  const all = await Promise.all(withRules.map((t) => readContracts(node, t.txid, t).catch(() => [])));
  return all.flat();
}

/** Contracts to this profile's accounts in the recent blocks, plus ones added by their transaction id */
export async function incomingContracts(node: NexusNode, s: Session, known: string[]): Promise<ChainContract[]> {
  const mine = new Set(s.accounts.map((a) => a.address));
  const txids = new Set(known);
  for (const b of await recentBlocks((m, p) => node.call(m, p), node.url).catch(() => [])) {
    for (const tx of b.tx ?? []) {
      if ((tx.contracts ?? []).some((c: any) => hasCondition(c) && mine.has(addressOf(c.to)))) {
        txids.add(tx.txid);
      }
    }
  }
  const all = await Promise.all([...txids].map((t) => readContracts(node, t).catch(() => [])));
  return all.flat().filter((c) => mine.has(c.to) && c.sender !== s.genesis);
}

export async function blockTime(node: NexusNode): Promise<number> {
  return (await node.tip()).timestamp;
}

//--- escrow ids from the chain ---

//an escrow condition names its decision register only by address; the register itself carries its name
//(escrow-<id>), and the address must come out the same from the arbiter in the condition and that id
function ownerChecks(c: Condition, out: Map<string, string>) {
  if (c.kind === 'compare') {
    if (c.left.kind === 'register' && c.left.field === 'owner' && c.right.kind === 'uint256') {
      out.set(addressOfMemory(c.left.address), hexOfMemory(c.right.bytes));
    }
    return;
  }
  for (const i of c.kind === 'group' ? [c.item] : c.items) {
    ownerChecks(i, out);
  }
}

const escrowCache = new Map<string, { arbiter: string; id: string } | null>();

export async function discoverEscrows(node: NexusNode, contracts: ChainContract[]): Promise<{ arbiter: string; id: string }[]> {
  const refs = new Map<string, string>();
  for (const c of contracts) {
    if (c.condition) {
      ownerChecks(c.condition, refs);
    }
  }
  const out: { arbiter: string; id: string }[] = [];
  for (const [address, arbiter] of refs) {
    const key = `${address}/${arbiter}`;
    if (!escrowCache.has(key)) {
      const r = await node.call<any>('register/get/any', { address }).catch(() => null);
      const id = typeof r?.name === 'string' && r.name.startsWith('escrow-') ? r.name.slice(7) : '';
      let found: { arbiter: string; id: string } | null = null;
      try {
        found = id && addressOfMemory(decisionAddress(arbiter, id)) === address ? { arbiter, id } : null;
      } catch {
        found = null;
      }
      escrowCache.set(key, found);
    }
    const f = escrowCache.get(key);
    if (f) {
      out.push(f);
    }
  }
  return out;
}

/** The escrow ids this profile is arbiter of: its own escrow-<id> names */
export async function myEscrowIds(node: NexusNode, s: Session): Promise<string[]> {
  const scan = await scanOwnRegisters((m, p) => node.call(m, p), s.genesis, s.scan);
  s.scan = scan;
  const names = scan.registers.filter((r) => r.type === 'NAME' || r.name?.startsWith('escrow-'));
  const ids: string[] = [];
  for (const r of names) {
    const name = r.name ?? (await node.call<any>('register/get/any', { address: r.address }).catch(() => null))?.name;
    if (typeof name === 'string' && name.startsWith('escrow-')) {
      ids.push(name.slice(7));
    }
  }
  return ids;
}

/** The person's account in a token ('0' = NXS): their "default" first for NXS, else the first one found */
//found once per person and token: it reads the person's whole sigchain
const accountForCache = new Map<string, string | undefined>();

export async function accountFor(node: NexusNode, p: Person, token: string): Promise<string | undefined> {
  if (token === '0' && p.account) {
    return p.account;
  }
  const key = `${p.genesis}/${token}`;
  if (accountForCache.has(key)) {
    return accountForCache.get(key);
  }
  const found = await findAccountFor(node, p, token);
  if (found) {
    accountForCache.set(key, found);
  }
  return found;
}

async function findAccountFor(node: NexusNode, p: Person, token: string): Promise<string | undefined> {
  const scan = await scanOwnRegisters((m, q) => node.call(m, q), p.genesis);
  for (const r of scan.registers.filter((x) => x.type === 'ACCOUNT')) {
    const s = await node.accountState(r.address).catch(() => null);
    if (s && s.token === token && s.owner === p.genesis) {
      return r.address;
    }
  }
  return undefined;
}

/** Contracts in the recent blocks (and the given transactions) that read one of this arbiter's decision registers */
export async function contractsForEscrows(node: NexusNode, arbiter: string, ids: string[], known: string[] = []): Promise<Map<string, ChainContract[]>> {
  const byAddress = new Map<string, string>();
  for (const id of ids) {
    try {
      byAddress.set(addressOfMemory(decisionAddress(arbiter, id)), id);
    } catch {
      //an id that is not valid has no register
    }
  }
  const out = new Map<string, ChainContract[]>();
  if (!byAddress.size) {
    return out;
  }
  const txids = new Set(known);
  for (const b of await recentBlocks((m, p) => node.call(m, p), node.url).catch(() => [])) {
    for (const tx of b.tx ?? []) {
      //the node prints each condition: only payments that name the arbiter need a closer look
      if ((tx.contracts ?? []).some((c: any) => c.OP === 'DEBIT' && String(c.conditions ?? '').toLowerCase().includes(arbiter))) {
        txids.add(tx.txid);
      }
    }
  }
  for (const txid of txids) {
    for (const c of await readContracts(node, txid).catch(() => [] as ChainContract[])) {
      if (!c.condition) {
        continue;
      }
      const refs = new Map<string, string>();
      ownerChecks(c.condition, refs);
      for (const [address, who] of refs) {
        const id = byAddress.get(address);
        if (id && who === arbiter) {
          out.set(id, [...(out.get(id) ?? []), c]);
        }
      }
    }
  }
  return out;
}

//--- code boxes (release with a code) ---

export async function codeBoxState(node: NexusNode, genesis: string): Promise<{ exists: boolean; owner?: string; created?: number; modified?: number; value?: Uint8Array }> {
  const r = await node.call<any>('register/get/any', { address: addressOfMemory(codeBoxAddress(genesis)) }).catch((e) => {
    if (e instanceof NodeError) {
      return null;
    }
    throw e;
  });
  if (!r) {
    return { exists: false };
  }
  const slot = parseSlot(r);
  return { exists: true, owner: String(r.owner ?? ''), created: slot.created, modified: slot.modified, value: slot.value };
}

/** One time: the code box that payments released with a code are claimed through (a name: 1 NXS fee on mainnet) */
export async function createCodeBox(node: NexusNode, s: Session): Promise<string> {
  const fee = nameFeeOn(s.net);
  const payer = fee > 0n ? nxsPayer(s, fee) : undefined;
  if (fee > 0n && !payer) {
    throw new Error(t('The code box is a name: it costs a 1 NXS fee and no NXS account has it'));
  }
  const state = payer ? await node.accountState(payer) : undefined;
  return node.submit(s.who, s.genesis, (ts) => {
    const list = [nameContract(s.genesis, codeBoxName, new Uint8Array(32), false, ts)];
    if (payer && state) {
      list.push(feeContract(memoryOfAddress(payer), state, fee, ts));
    }
    return list;
  });
}

/** Claim with a code: the chain reads the box as of the last block, so the code goes in first, the claim after */
export async function claimWithCode(node: NexusNode, s: Session, c: ChainContract, code: string, step: (text: string) => void): Promise<string> {
  const secret = codeSecret(code);
  const box = await codeBoxState(node, s.genesis);
  if (!box.exists) {
    throw new Error(t('Set up your code box first'));
  }
  const same = box.value && box.value.length === secret.length && box.value.every((b, i) => b === secret[i]);
  if (!same) {
    step(t('Writing the code into your code box...'));
    const w = await node.submit(s.who, s.genesis, (ts) => [nameWriteContract(s.genesis, codeBoxName, { created: box.created!, modified: box.modified!, address: box.value! }, secret, ts)]);
    step(t('Code written, waiting for the next block before claiming...'));
    await node.waitConfirmed(w, 1, 600000);
  }
  step(t('Claiming...'));
  return claim(node, s, c, c.to);
}
