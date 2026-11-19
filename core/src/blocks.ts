//The builder's model: ways to claim (OR), each a list of blocks (AND). Converts both ways with the condition, so the
//block builder and the code console edit the same contract. Anything the blocks cannot show stays a "code" block
//with its text, so no condition is ever lost by switching views.
import { hexOfMemory, memoryOfHex } from '../../../wallet/src/lib/tritium';
import { and, compare, or, register, source, u256, u64, type Condition, type Operand } from './condition/ast';
import { parse, print } from './condition/text';
import { decisionAddress, decisionField, decisionValue } from './templates';
import { codeBoxAddress, codeBoxField, codeHash, codeParts, newCode } from './code';

export type Block =
  | { kind: 'who'; genesis: string } //this user claims
  | { kind: 'before'; time: number } //block time is before
  | { kind: 'from'; time: number } //block time is at least
  | { kind: 'decision'; arbiter: string; id: string; value: number } //arbiter's decision register holds value
  | { kind: 'secret'; genesis: string; hash: string; code?: string } //genesis's code box holds the code of hash (hex); code only in this page
  | { kind: 'code'; text: string }; //any other part, as console text

export type Way = Block[];

export const blockKinds: Block['kind'][] = ['who', 'before', 'from', 'decision', 'secret', 'code'];

export function newBlock(kind: Block['kind'], now = Math.floor(Date.now() / 1000)): Block {
  switch (kind) {
    case 'who':
      return { kind, genesis: '' };
    case 'before':
    case 'from':
      return { kind, time: now + 7 * 86400 };
    case 'decision':
      return { kind, arbiter: '', id: '', value: 1 };
    case 'secret': {
      const code = newCode();
      return { kind, genesis: '', hash: hex(codeHash(code)), code };
    }
    case 'code':
      return { kind, text: 'ledger.height > 0' };
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

//--- blocks to condition ---

function blockParts(b: Block): Condition[] {
  switch (b.kind) {
    case 'who':
      if (!/^[0-9a-f]{64}$/.test(b.genesis)) {
        throw new Error('pick who may claim');
      }
      return [compare(source('caller.genesis'), '==', u256(memoryOfHex(b.genesis)))];
    case 'before':
      return [compare(source('ledger.timestamp'), '<', u64(b.time))];
    case 'from':
      return [compare(source('ledger.timestamp'), '>=', u64(b.time))];
    case 'decision': {
      if (!/^[0-9a-f]{64}$/.test(b.arbiter)) {
        throw new Error('pick the arbiter');
      }
      const reg = decisionAddress(b.arbiter, b.id);
      return [compare(register(reg, 'owner'), '==', u256(memoryOfHex(b.arbiter))), compare(register(reg, { value: decisionField }), '==', u256(decisionValue(b.value)))];
    }
    case 'secret':
      if (!/^[0-9a-f]{64}$/.test(b.genesis)) {
        throw new Error('pick whose code box holds the code');
      }
      if (!/^[0-9a-f]{64}$/.test(b.hash)) {
        throw new Error('make a code');
      }
      return codeParts(b.genesis, unhex(b.hash));
    case 'code': {
      const c = parse(b.text);
      return c.kind === 'and' ? c.items : [c];
    }
  }
}

export function toCondition(ways: Way[]): Condition {
  const list = ways.filter((w) => w.length > 0);
  if (list.length === 0) {
    throw new Error('add at least one way to claim');
  }
  const conds = list.map((w) => {
    const parts = w.flatMap(blockParts);
    return parts.length === 1 ? parts[0]! : and(...parts);
  });
  return conds.length === 1 ? conds[0]! : or(...conds);
}

//--- condition to blocks ---

const isSource = (o: Operand, s: string) => o.kind === 'source' && o.source === s;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function simpleBlock(c: Condition): Block | null {
  if (c.kind !== 'compare') {
    return null;
  }
  if (isSource(c.left, 'caller.genesis') && c.op === '==' && c.right.kind === 'uint256') {
    return { kind: 'who', genesis: hexOfMemory(c.right.bytes) };
  }
  if (isSource(c.left, 'ledger.timestamp') && c.right.kind === 'uint64' && (c.op === '<' || c.op === '>=')) {
    return { kind: c.op === '<' ? 'before' : 'from', time: Number(c.right.value) };
  }
  return null;
}

//owner == arbiter followed by value("address") == n on the same register, for a register that matches escrow-<id>
//is only known when the id is known, so the pair is kept with the address and checked when the id is filled in
function decisionPair(a: Condition, b: Condition, ids: Map<string, { arbiter: string; id: string }>): Block | null {
  if (a.kind !== 'compare' || b.kind !== 'compare' || a.left.kind !== 'register' || b.left.kind !== 'register') {
    return null;
  }
  if (a.left.field !== 'owner' || typeof b.left.field !== 'object' || b.left.field.value !== decisionField) {
    return null;
  }
  if (!sameBytes(a.left.address, b.left.address) || a.right.kind !== 'uint256' || b.right.kind !== 'uint256') {
    return null;
  }
  const known = ids.get(hexOfMemory(a.left.address));
  const arbiter = hexOfMemory(a.right.bytes);
  if (!known || known.arbiter !== arbiter) {
    return null;
  }
  const v = b.right.bytes;
  if (v.slice(1).some((x) => x !== 0) || !sameBytes(v, decisionValue(v[0]!))) {
    return null;
  }
  return { kind: 'decision', arbiter, id: known.id, value: v[0]! };
}

//owner == G and sk256(value("address")) == H on G's own code box
function secretPair(a: Condition, b: Condition): Block | null {
  if (a.kind !== 'compare' || b.kind !== 'compare' || a.left.kind !== 'register' || a.left.field !== 'owner' || a.right.kind !== 'uint256' || a.op !== '==' || b.op !== '==') {
    return null;
  }
  const h = b.left;
  if (h.kind !== 'hash' || h.alg !== 'sk256' || h.of.kind !== 'register' || typeof h.of.field !== 'object' || h.of.field.value !== codeBoxField || b.right.kind !== 'uint256') {
    return null;
  }
  const genesis = hexOfMemory(a.right.bytes);
  if (!sameBytes(a.left.address, h.of.address) || !sameBytes(a.left.address, codeBoxAddress(genesis))) {
    return null;
  }
  return { kind: 'secret', genesis, hash: hex(b.right.bytes) };
}

/** Escrow ids the builder knows (from templates or earlier blocks), to show decision registers as blocks */
export function decisionIds(list: { arbiter: string; id: string }[]): Map<string, { arbiter: string; id: string }> {
  return new Map(list.filter((x) => /^[0-9a-f]{64}$/.test(x.arbiter) && x.id).map((x) => [hexOfMemory(decisionAddress(x.arbiter, x.id)), x]));
}

export function toWays(c: Condition, ids = new Map<string, { arbiter: string; id: string }>()): Way[] {
  const ways = c.kind === 'or' ? c.items : [c];
  return ways.map((w) => {
    const parts = w.kind === 'and' ? w.items : w.kind === 'group' ? [w.item] : [w];
    const out: Block[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const next = parts[i + 1];
      const pair = next ? (decisionPair(p, next, ids) ?? secretPair(p, next)) : null;
      if (pair) {
        out.push(pair);
        i++;
        continue;
      }
      out.push(simpleBlock(p) ?? { kind: 'code', text: print(p) });
    }
    return out;
  });
}

/** Builder state for a new, empty contract */
export const emptyWays = (): Way[] => [[]];
