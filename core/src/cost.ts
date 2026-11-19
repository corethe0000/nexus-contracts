//What checking a condition costs, as the core counts it at the claim (LLL-TAO 5.1.6 Operation/condition.cpp, every
//"nCost +=" there). Up to CONDITION_LIMIT_FREE it is free; above it the claim must carry a FEE contract for the rest
//(Operation/cost.cpp, Ledger/transaction.cpp "not enough fees supplied"). Private / hybrid chains charge nothing.
//The core evaluates every part (no short circuit), so every part counts. Values in the smallest NXS unit (1e-6).
import type { Condition, Operand } from './condition/ast';

export const conditionFreeLimit = 4096;

//a register field read by value: the cost depends on the type stored there, which the condition does not say.
//Our own fields ("address" of a name) are uint256 (32); anything else is taken as a long text so the fee is never short
const knownFieldCost: Record<string, number> = { address: 32 };
const unknownFieldCost = 1024;

const cost = {
  group: 128,
  uint64: 8,
  uint256: 32,
  owner: 4128,
  created: 5004,
  modified: 5004,
  type: 4097,
  state: 8192, //the size of the whole register state: unknown, taken large
  value: 4096,
  callerGenesis: 32,
  callerTimestamp: 8,
  contractGenesis: 32,
  contractTimestamp: 8,
  ledgerHeight: 8,
  ledgerTimestamp: 8,
  add: 64,
  sub: 64,
  mul: 128,
  div: 128,
  mod: 128,
  hash: 2048,
};

function operandCost(o: Operand): number {
  switch (o.kind) {
    case 'source':
      return {
        'caller.genesis': cost.callerGenesis,
        'caller.timestamp': cost.callerTimestamp,
        'contract.genesis': cost.contractGenesis,
        'contract.timestamp': cost.contractTimestamp,
        'ledger.timestamp': cost.ledgerTimestamp,
        'ledger.height': cost.ledgerHeight,
      }[o.source];
    case 'uint64':
      return cost.uint64;
    case 'uint256':
      return cost.uint256;
    case 'string':
      return new TextEncoder().encode(o.value).length;
    case 'register': {
      const field = typeof o.field === 'string' ? cost[o.field] : cost.value + (knownFieldCost[o.field.value] ?? unknownFieldCost);
      return cost.uint256 + field;
    }
    case 'hash':
      return operandCost(o.of) + cost.hash;
    case 'math':
      return operandCost(o.left) + operandCost(o.right) + { '+': cost.add, '-': cost.sub, '*': cost.mul, '/': cost.div, '%': cost.mod }[o.op];
  }
}

//groups are counted the way encode() writes them: explicit groups, and an AND / OR of several parts inside another
function conditionCost(c: Condition): number {
  switch (c.kind) {
    case 'compare':
      return operandCost(c.left) + operandCost(c.right);
    case 'group':
      return cost.group + conditionCost(c.item);
    case 'and':
    case 'or':
      return c.items.reduce((sum, i) => sum + ((i.kind === 'and' || i.kind === 'or') && i.items.length > 1 ? cost.group : 0) + conditionCost(i), 0);
  }
}

/** The whole cost of checking the condition once */
export function costOf(c: Condition): number {
  return conditionCost(c);
}

/** The fee a claim must carry for this condition on a chain that charges fees */
export function claimFee(c: Condition): bigint {
  return BigInt(Math.max(0, costOf(c) - conditionFreeLimit));
}
