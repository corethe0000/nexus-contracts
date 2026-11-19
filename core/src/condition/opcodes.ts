//Nexus condition opcodes, LLL-TAO 5.1.6 src/TAO/Operation/include/enum.h
export const OP = {
  //literal types (type byte, then the value)
  uint8: 0x70,
  uint16: 0x71,
  uint32: 0x72,
  uint64: 0x73,
  uint256: 0x74,
  uint512: 0x75,
  uint1024: 0x76,
  string: 0x77,
  bytes: 0x78,

  //comparisons
  equals: 0x80,
  lessThan: 0x81,
  greaterThan: 0x82,
  notEquals: 0x83,
  contains: 0x84,
  lessEquals: 0x85,
  greaterEquals: 0x86,

  //math, applied to the operand on the left
  add: 0x90,
  sub: 0x91,
  div: 0x92,
  mul: 0x93,
  mod: 0x94,

  //logic
  and: 0xa0,
  or: 0xa1,
  group: 0xa2,
  ungroup: 0xa3,

  //register reads, after a uint256 register address
  registerCreated: 0xb0,
  registerModified: 0xb1,
  registerOwner: 0xb2,
  registerType: 0xb3,
  registerState: 0xb4,
  registerValue: 0xb5,

  //the transaction that claims (caller) and the contract being claimed
  callerGenesis: 0xc0,
  callerTimestamp: 0xc1,
  contractGenesis: 0xca,
  contractTimestamp: 0xcb,

  //chain state at validation
  ledgerHeight: 0xd0,
  ledgerSupply: 0xd1,
  ledgerTimestamp: 0xd2,

  //hash of the operand on the left
  sk256: 0xe0,
  sk512: 0xe1,
} as const;

export type CompareOp = '==' | '!=' | '<' | '>' | '<=' | '>=' | 'contains';
export type MathOp = '+' | '-' | '*' | '/' | '%';

export const compareCodes: Record<CompareOp, number> = {
  '==': OP.equals,
  '!=': OP.notEquals,
  '<': OP.lessThan,
  '>': OP.greaterThan,
  '<=': OP.lessEquals,
  '>=': OP.greaterEquals,
  contains: OP.contains,
};

export const mathCodes: Record<MathOp, number> = {
  '+': OP.add,
  '-': OP.sub,
  '*': OP.mul,
  '/': OP.div,
  '%': OP.mod,
};
