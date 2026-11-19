import type { Condition, Operand, RegisterField, Source } from './ast';
import { compareCodes, mathCodes, OP, type CompareOp, type MathOp } from './opcodes';

const sourceCodes: Record<Source, number> = {
  'caller.genesis': OP.callerGenesis,
  'caller.timestamp': OP.callerTimestamp,
  'contract.genesis': OP.contractGenesis,
  'contract.timestamp': OP.contractTimestamp,
  'ledger.timestamp': OP.ledgerTimestamp,
  'ledger.height': OP.ledgerHeight,
};

const fieldCodes = {
  owner: OP.registerOwner,
  created: OP.registerCreated,
  modified: OP.registerModified,
  type: OP.registerType,
  state: OP.registerState,
} as const;

class Out {
  private b: number[] = [];
  u8(v: number) {
    this.b.push(v & 0xff);
    return this;
  }
  u64(v: bigint) {
    if (v < 0n || v >= 1n << 64n) {
      throw new Error(`number out of range: ${v}`);
    }
    for (let i = 0; i < 8; i++) {
      this.b.push(Number((v >> BigInt(8 * i)) & 0xffn));
    }
    return this;
  }
  raw(bytes: Uint8Array) {
    for (const x of bytes) {
      this.b.push(x);
    }
    return this;
  }
  //CompactSize length as the core's serialize.h writes it
  compact(n: number) {
    if (n < 253) {
      return this.u8(n);
    }
    if (n <= 0xffff) {
      return this.u8(253).u8(n).u8(n >> 8);
    }
    throw new Error('string too long');
  }
  bytes() {
    return Uint8Array.from(this.b);
  }
}

function operand(o: Operand, w: Out): void {
  switch (o.kind) {
    case 'source':
      w.u8(sourceCodes[o.source]);
      return;
    case 'uint64':
      w.u8(OP.uint64).u64(o.value);
      return;
    case 'uint256':
      if (o.bytes.length !== 32) {
        throw new Error('a uint256 value must be 32 bytes');
      }
      w.u8(OP.uint256).raw(o.bytes);
      return;
    case 'string': {
      const s = new TextEncoder().encode(o.value);
      w.u8(OP.string).compact(s.length).raw(s);
      return;
    }
    case 'register':
      if (o.address.length !== 32) {
        throw new Error('a register address must be 32 bytes');
      }
      w.u8(OP.uint256).raw(o.address);
      if (typeof o.field === 'string') {
        w.u8(fieldCodes[o.field]);
      } else {
        const name = new TextEncoder().encode(o.field.value);
        if (name.length === 0 || name.length > 252) {
          throw new Error('register field name must be 1 to 252 bytes');
        }
        w.u8(OP.registerValue).u8(name.length).raw(name);
      }
      return;
    case 'hash':
      operand(o.of, w);
      w.u8(o.alg === 'sk256' ? OP.sk256 : OP.sk512);
      return;
    case 'math':
      if (o.right.kind === 'math' || o.right.kind === 'hash') {
        throw new Error('only a plain value can stand right of + - * / %');
      }
      operand(o.left, w);
      w.u8(mathCodes[o.op]);
      operand(o.right, w);
      return;
  }
}

function condition(c: Condition, w: Out): void {
  switch (c.kind) {
    case 'compare':
      operand(c.left, w);
      w.u8(compareCodes[c.op]);
      operand(c.right, w);
      return;
    case 'group':
      w.u8(OP.group);
      condition(c.item, w);
      w.u8(OP.ungroup);
      return;
    case 'and':
    case 'or': {
      if (c.items.length === 0) {
        throw new Error(`empty ${c.kind.toUpperCase()}`);
      }
      //a nested AND/OR goes into a group so the core evaluates it as one part
      c.items.forEach((item, i) => {
        if (i > 0) {
          w.u8(c.kind === 'and' ? OP.and : OP.or);
        }
        if ((item.kind === 'and' || item.kind === 'or') && item.items.length > 1) {
          condition({ kind: 'group', item }, w);
        } else {
          condition(item, w);
        }
      });
      return;
    }
  }
}

/** Condition structure to the byte form the core stores after a contract's operation */
export function encode(c: Condition): Uint8Array {
  const w = new Out();
  condition(c, w);
  return w.bytes();
}

//--- decode ---

const sourceByCode = new Map(Object.entries(sourceCodes).map(([k, v]) => [v, k as Source]));
const fieldByCode = new Map(Object.entries(fieldCodes).map(([k, v]) => [v as number, k as RegisterField]));
const compareByCode = new Map(Object.entries(compareCodes).map(([k, v]) => [v, k as CompareOp]));
const mathByCode = new Map(Object.entries(mathCodes).map(([k, v]) => [v, k as MathOp]));

class In {
  pos = 0;
  constructor(private b: Uint8Array) {}
  done() {
    return this.pos >= this.b.length;
  }
  peek(): number | undefined {
    return this.b[this.pos];
  }
  u8(): number {
    const v = this.b[this.pos];
    if (v === undefined) {
      throw new Error('condition ends too early');
    }
    this.pos++;
    return v;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.b.length) {
      throw new Error('condition ends too early');
    }
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u64(): bigint {
    let v = 0n;
    const b = this.take(8);
    for (let i = 7; i >= 0; i--) {
      v = (v << 8n) | BigInt(b[i]!);
    }
    return v;
  }
  compact(): number {
    const n = this.u8();
    if (n < 253) {
      return n;
    }
    if (n === 253) {
      return this.u8() | (this.u8() << 8);
    }
    throw new Error('string too long');
  }
}

function readValue(r: In): Operand {
  const code = r.u8();
  const src = sourceByCode.get(code);
  if (src) {
    return { kind: 'source', source: src };
  }
  if (code === OP.uint64) {
    return { kind: 'uint64', value: r.u64() };
  }
  if (code === OP.uint256) {
    const bytes = r.take(32);
    const next = r.peek();
    const field = next === undefined ? undefined : fieldByCode.get(next);
    if (field) {
      r.u8();
      return { kind: 'register', address: bytes, field };
    }
    if (next === OP.registerValue) {
      r.u8();
      const len = r.u8();
      return { kind: 'register', address: bytes, field: { value: new TextDecoder().decode(r.take(len)) } };
    }
    return { kind: 'uint256', bytes };
  }
  if (code === OP.string) {
    return { kind: 'string', value: new TextDecoder().decode(r.take(r.compact())) };
  }
  throw new Error(`unsupported value code 0x${code.toString(16)} at byte ${r.pos - 1}`);
}

function readOperand(r: In): Operand {
  let o = readValue(r);
  for (;;) {
    const next = r.peek();
    if (next === OP.sk256 || next === OP.sk512) {
      r.u8();
      o = { kind: 'hash', alg: next === OP.sk256 ? 'sk256' : 'sk512', of: o };
      continue;
    }
    const m = next === undefined ? undefined : mathByCode.get(next);
    if (m) {
      r.u8();
      o = { kind: 'math', op: m, left: o, right: readValue(r) };
      continue;
    }
    return o;
  }
}

function readTerm(r: In): Condition {
  if (r.peek() === OP.group) {
    r.u8();
    const inner = readExpr(r);
    if (r.u8() !== OP.ungroup) {
      throw new Error('group not closed');
    }
    return inner;
  }
  const left = readOperand(r);
  const code = r.u8();
  const op = compareByCode.get(code);
  if (!op) {
    throw new Error(`expected a comparison at byte ${r.pos - 1}`);
  }
  return { kind: 'compare', op, left, right: readOperand(r) };
}

//condition.cpp refuses AND and OR mixed inside one group, so a level is all AND or all OR
function readExpr(r: In): Condition {
  const first = readTerm(r);
  let kind: 'and' | 'or' | undefined;
  const items = [first];
  while (!r.done() && (r.peek() === OP.and || r.peek() === OP.or)) {
    const k = r.u8() === OP.and ? 'and' : 'or';
    if (kind && kind !== k) {
      throw new Error('AND and OR mixed without a group (the core refuses this)');
    }
    kind = k;
    items.push(readTerm(r));
  }
  return kind ? { kind, items } : first;
}

/** Byte form back to the structure (only the parts this module writes) */
export function decode(bytes: Uint8Array): Condition {
  const r = new In(bytes);
  const c = readExpr(r);
  if (!r.done()) {
    throw new Error(`unexpected byte 0x${r.peek()!.toString(16)} at ${r.pos}`);
  }
  return c;
}
