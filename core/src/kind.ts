import type { Condition, Operand } from './condition/ast';

/** swap = a DEX hash lock (needs the secret), expiry = an ordinary payment with the core's own expiry, else a contract */
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

export function contractKind(c: Condition): ContractKind {
  let hash = false;
  let txTime = false;
  for (const o of operands(c)) {
    walk(o, (x) => {
      if (x.kind === 'hash') {
        hash = true;
      }
      //API AddExpires compares the claim's own time with the payment's time; the templates here use block time
      if (x.kind === 'source' && (x.source === 'caller.timestamp' || x.source === 'contract.timestamp')) {
        txTime = true;
      }
    });
  }
  return hash ? 'swap' : txTime ? 'expiry' : 'contract';
}
