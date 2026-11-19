import { expiryCondition, hexOfMemory } from '../../../wallet/src/lib/tritium';
import { slotAddress } from '../../../wallet/src/lib/htlc';
import type { Condition, Operand } from './condition/ast';
import { encode } from './condition/encode';

/** swap = a DEX hash lock, expiry = an ordinary payment with the core's own expiry, else a contract */
export type ContractKind = 'swap' | 'expiry' | 'contract';

function operands(c: Condition): Operand[] {
  switch (c.kind) {
    case 'compare':
      return [c.left, c.right];
    case 'group':
      return operands(c.item);
    default:
      return c.items.flatMap(operands);
  }
}

function walk(o: Operand, fn: (o: Operand) => void) {
  fn(o);
  if (o.kind === 'hash') {
    walk(o.of, fn);
  } else if (o.kind === 'math') {
    walk(o.left, fn);
    walk(o.right, fn);
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

//only the exact forms count: a contract written in the console that merely uses a hash or a transaction time
//must stay visible in this module
export function contractKind(c: Condition): ContractKind {
  const all: Operand[] = [];
  for (const o of operands(c)) {
    walk(o, (x) => all.push(x));
  }
  const geneses = all.filter((o): o is Extract<Operand, { kind: 'uint256' }> => o.kind === 'uint256').map((o) => hexOfMemory(o.bytes));
  const numbers = all.filter((o): o is Extract<Operand, { kind: 'uint64' }> => o.kind === 'uint64').map((o) => o.value);
  //reading drops a bracket around a single comparison (the "never expires" form has one)
  const forms = new Set([hex(encode(c)), hex(encode({ kind: 'group', item: c }))]);

  //API AddExpires: one genesis and one number of seconds (none for "never")
  for (const g of new Set(geneses)) {
    for (const n of [...new Set(numbers), 0n]) {
      if (/^[0-9a-f]{64}$/.test(g) && forms.has(hex(expiryCondition(g, Number(n))))) {
        return 'expiry';
      }
    }
  }

  //DEX lock: the hash of a profile's reveal slot ("nxdex" name) of a genesis named in the same condition
  const hashedSlots = all.filter((o) => o.kind === 'hash' && o.of.kind === 'register').map((o) => (o.kind === 'hash' && o.of.kind === 'register' ? hex(o.of.address) : ''));
  if (hashedSlots.length && geneses.some((g) => /^[0-9a-f]{64}$/.test(g) && hashedSlots.includes(hex(slotAddress(g))))) {
    return 'swap';
  }
  return 'contract';
}
