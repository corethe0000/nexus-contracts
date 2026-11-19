//The Nexus side of the module: the profile signed in here, people, sending a contract, claiming one, the arbiter's
//decisions and the lists of sent and incoming contracts. Transactions are built and signed in this page (the core's
//API can only add an expiry condition); username, password and PIN stay in memory only.
import { NexusNode, NodeError, type Credentials } from '../../../../dex/core/src/nexus/node';
import { nodeFor, inWallet } from '../../../../dex/app/src/lib/module';
import { network, refresh, type NexusAccount, type NexusNet } from '../../../../dex/app/src/lib/nexus';
import { checkCredentials, findGenesis, scanOwnRegisters } from '../../../../wallet/src/lib/profile-chain';
import { recentBlocks } from '../../../../wallet/src/lib/blocks';
import { conditionOf, parseSlot } from '../../../../wallet/src/lib/htlc';
import { addressOfMemory, creditContract, debitContract, feeContract, hexOfMemory, memoryOfAddress, memoryOfHex, nameContract, nameFee, namedAddress, nameWriteContract, parseTx } from '../../../../wallet/src/lib/tritium';
import { contractKind, decisionAddress, decisionName, decode, type Condition, type ContractKind } from '@nexus-contracts/core/src';

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
  const p = { username: s.username, genesis: s.genesis, accounts: [] as NexusAccount[], slotReady: false, signer: null as never, via: 'page' as const };
  await refresh(node, p);
  s.accounts = p.accounts;
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
  const t = text.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) {
    const genesis = t.toLowerCase();
    return { genesis, account: await defaultAccount(node, genesis) };
  }
  if (!t) {
    throw new Error('Enter a username');
  }
  const { genesis } = await findGenesis((m, p) => node.call(m, p), t, s.net.testnet || s.net.private);
  return { username: t, genesis, account: await defaultAccount(node, genesis) };
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

/** CREDIT of one contract into an own account: the recipient's account to claim, the sender's to take it back */
export async function claim(node: NexusNode, s: Session, c: ChainContract, into: string): Promise<string> {
  const state = await node.accountState(into);
  return node.submit(s.who, s.genesis, (ts) => [creditContract({ debitTxid: c.txid, contract: c.contract, to: { address: into, state }, from: c.from, amount: c.open }, ts)]);
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
    throw new Error('A decision register costs a 1 NXS name fee: no NXS account has it');
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
    throw new Error('This escrow id has no decision register yet');
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
async function tokenOf(node: NexusNode, account: string): Promise<{ token: string; decimals: number; ticker: string }> {
  const st = await node.accountState(account).catch(() => null);
  if (!st) {
    return { token: '0', decimals: 6, ticker: 'NXS' };
  }
  if (!tokenCache.has(st.token)) {
    const t = st.token === '0' ? null : await node.call<any>('register/get/any', { address: st.token }).catch(() => null);
    tokenCache.set(st.token, { decimals: st.decimals, ticker: st.token === '0' ? 'NXS' : String(t?.ticker ?? t?.name ?? 'token') });
  }
  return { token: st.token, ...tokenCache.get(st.token)! };
}

/** Every DEBIT with a condition in one transaction */
export async function readContracts(node: NexusNode, txid: string): Promise<ChainContract[]> {
  const [tx, raw] = await Promise.all([node.call<any>('ledger/get/transaction', { hash: txid, verbose: 'summary' }), node.call<{ data: string }>('ledger/get/transaction', { hash: txid, format: 'raw' })]);
  const parsed = parseTx(raw.data);
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
    const unit = 10 ** decimals;
    const amount = BigInt(Math.round(Number(c.amount ?? 0) * unit));
    const claimed = BigInt(Math.round(Number(c.claimed ?? 0) * unit));
    out.push({ txid, contract: c.id, time: tx.timestamp, sender: parsed.genesis, from, to: addressOf(c.to), token, ticker, amount, open: amount - claimed, decimals, condition, kind: condition ? contractKind(condition) : 'contract', conditionBytes: Uint8Array.from(cond) });
  }
  return out;
}

/** Contracts this profile sent, from its newest transactions */
export async function sentContracts(node: NexusNode, s: Session, limit = 100): Promise<ChainContract[]> {
  const list = await node.call<any[]>('ledger/list/transactions', { genesis: s.genesis, limit, verbose: 'summary' }).catch(() => []);
  const txids = list.filter((t) => (t.contracts ?? []).some((c: any) => c.OP === 'DEBIT')).map((t) => t.txid as string);
  const all = await Promise.all(txids.map((t) => readContracts(node, t).catch(() => [])));
  return all.flat();
}

/** Contracts to this profile's accounts in the recent blocks, plus ones added by their transaction id */
export async function incomingContracts(node: NexusNode, s: Session, known: string[]): Promise<ChainContract[]> {
  const mine = new Set(s.accounts.map((a) => a.address));
  const txids = new Set(known);
  for (const b of await recentBlocks((m, p) => node.call(m, p), node.url).catch(() => [])) {
    for (const tx of b.tx ?? []) {
      if ((tx.contracts ?? []).some((c: any) => c.OP === 'DEBIT' && mine.has(addressOf(c.to)))) {
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
  const scan = await scanOwnRegisters((m, p) => node.call(m, p), s.genesis);
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
export async function accountFor(node: NexusNode, p: Person, token: string): Promise<string | undefined> {
  if (token === '0' && p.account) {
    return p.account;
  }
  const scan = await scanOwnRegisters((m, q) => node.call(m, q), p.genesis);
  for (const r of scan.registers.filter((x) => x.type === 'ACCOUNT')) {
    const s = await node.accountState(r.address).catch(() => null);
    if (s && s.token === token && s.owner === p.genesis) {
      return r.address;
    }
  }
  return undefined;
}
