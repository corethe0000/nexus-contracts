import type { CompareOp, MathOp } from './opcodes';

/** Value the core can read while it checks a claim */
export type Source =
  | 'caller.genesis' //sigchain of whoever claims (or takes back)
  | 'caller.timestamp' //time written in the claiming transaction, can be backdated
  | 'contract.genesis' //sigchain that made the contract
  | 'contract.timestamp' //time written in the contract's transaction
  | 'ledger.timestamp' //time of the best block, the trustworthy clock
  | 'ledger.height';

export type RegisterField =
  | 'owner'
  | 'created'
  | 'modified'
  | 'type'
  | 'state'
  | { value: string };

export type Operand =
  | { kind: 'source'; source: Source }
  | { kind: 'uint64'; value: bigint }
  | { kind: 'uint256'; bytes: Uint8Array } //memory order, 32 bytes
  | { kind: 'string'; value: string }
  | { kind: 'register'; address: Uint8Array; field: RegisterField }
  | { kind: 'hash'; alg: 'sk256' | 'sk512'; of: Operand }
  | { kind: 'math'; op: MathOp; left: Operand; right: Operand };

export type Condition =
  | { kind: 'compare'; op: CompareOp; left: Operand; right: Operand }
  | { kind: 'and'; items: Condition[] }
  | { kind: 'or'; items: Condition[] }
  | { kind: 'group'; item: Condition };

//small builders so templates and tests read like the condition itself
export const source = (s: Source): Operand => ({ kind: 'source', source: s });
export const u64 = (value: bigint | number): Operand => ({ kind: 'uint64', value: BigInt(value) });
export const u256 = (bytes: Uint8Array): Operand => ({ kind: 'uint256', bytes });
export const register = (address: Uint8Array, field: RegisterField): Operand => ({ kind: 'register', address, field });
export const compare = (left: Operand, op: CompareOp, right: Operand): Condition => ({ kind: 'compare', op, left, right });
export const and = (...items: Condition[]): Condition => ({ kind: 'and', items });
export const or = (...items: Condition[]): Condition => ({ kind: 'or', items });
