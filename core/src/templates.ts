//Ready-made contracts. All deadlines use ledger.timestamp (block time): caller and contract timestamps are written by
//the sender of a transaction and can be backdated.
import { memoryOfHex, namedAddress } from '../../../wallet/src/lib/tritium';
import { and, compare, or, register, source, u256, u64, type Condition } from './condition/ast';

const addrName = 0xd9;

export const callerIs = (genesis: string): Condition => compare(source('caller.genesis'), '==', u256(memoryOfHex(genesis)));
const blockTime = (op: '<' | '>=', t: number): Condition => compare(source('ledger.timestamp'), op, u64(t));

function checkGenesis(label: string, g: string) {
  if (!/^[0-9a-f]{64}$/.test(g)) {
    throw new Error(`${label} must be a 64 digit genesis id`);
  }
}

function checkTime(label: string, t: number) {
  if (!Number.isInteger(t) || t <= 0) {
    throw new Error(`${label} must be a time in unix seconds`);
  }
}

//--- return if unclaimed ---

export interface ReturnIfUnclaimed {
  sender: string; //genesis hex
  recipient: string;
  deadline: number; //unix seconds
}

/** The recipient can claim before the deadline; after it only the sender can take the payment back */
export function returnIfUnclaimed(t: ReturnIfUnclaimed): Condition {
  checkGenesis('sender', t.sender);
  checkGenesis('recipient', t.recipient);
  checkTime('deadline', t.deadline);
  return or(and(callerIs(t.recipient), blockTime('<', t.deadline)), and(callerIs(t.sender), blockTime('>=', t.deadline)));
}

//--- time-lock ---

export interface TimeLock {
  sender: string;
  recipient: string;
  unlock: number; //the recipient can claim from this time on
  cancelable?: boolean; //the sender can take it back before the unlock time
  returnAfter?: number; //the sender can take it back from this time on (after unlock), if still unclaimed
}

export function timeLock(t: TimeLock): Condition {
  checkGenesis('sender', t.sender);
  checkGenesis('recipient', t.recipient);
  checkTime('unlock time', t.unlock);
  const ways: Condition[] = [and(callerIs(t.recipient), blockTime('>=', t.unlock))];
  if (t.cancelable) {
    ways.push(and(callerIs(t.sender), blockTime('<', t.unlock)));
  }
  if (t.returnAfter !== undefined) {
    checkTime('return time', t.returnAfter);
    if (t.returnAfter <= t.unlock) {
      throw new Error('the return time must be after the unlock time');
    }
    ways.push(and(callerIs(t.sender), blockTime('>=', t.returnAfter)));
  }
  return ways.length === 1 ? ways[0]! : or(...ways);
}

//--- escrow ---

//the arbiter's decision lives in a local name of the arbiter ("address" field): 0 = open, 1 = release, 2 = refund.
//The name's address is derived from the arbiter's genesis, so only the arbiter can create it; the owner check stops
//a decision written after the name was handed to someone else.
export const decisionField = 'address';
export const decision = { open: 0, release: 1, refund: 2 } as const;

export function decisionValue(d: number): Uint8Array {
  const b = new Uint8Array(32);
  b[0] = d;
  return b;
}

export function decisionName(id: string): string {
  if (!/^[a-z0-9]{4,32}$/.test(id)) {
    throw new Error('escrow id must be 4 to 32 lower case letters or digits');
  }
  return `escrow-${id}`;
}

/** Memory bytes of the arbiter's decision register for one escrow */
export function decisionAddress(arbiter: string, id: string): Uint8Array {
  return namedAddress(decisionName(id), memoryOfHex(arbiter), addrName);
}

export interface Escrow {
  sender: string;
  recipient: string;
  arbiter: string; //decides with the decision register; cannot claim the payment
  id: string; //names the decision register (escrow-<id>), unique per arbiter
  fallback?: number; //the sender can take it back from this time on when no decision came
}

export function escrow(t: Escrow): Condition {
  checkGenesis('sender', t.sender);
  checkGenesis('recipient', t.recipient);
  checkGenesis('arbiter', t.arbiter);
  const reg = decisionAddress(t.arbiter, t.id);
  const decided = (d: number): Condition[] => [compare(register(reg, 'owner'), '==', u256(memoryOfHex(t.arbiter))), compare(register(reg, { value: decisionField }), '==', u256(decisionValue(d)))];
  const ways: Condition[] = [and(callerIs(t.recipient), ...decided(decision.release)), and(callerIs(t.sender), ...decided(decision.refund))];
  if (t.fallback !== undefined) {
    checkTime('fallback time', t.fallback);
    ways.push(and(callerIs(t.sender), blockTime('>=', t.fallback)));
  }
  return or(...ways);
}
