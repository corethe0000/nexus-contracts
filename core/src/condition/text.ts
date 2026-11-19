//Text form of a condition (the console). Example:
//  (caller.genesis == 0xa1b2... AND ledger.timestamp < date(2026-12-01T12:00Z))
//  OR (caller.genesis == 0xc3d4... AND ledger.timestamp >= date(2026-12-01T12:00Z))
//0x... = 256 bit value as the node prints it (genesis ids), register(<address>).owner / .value("name") reads a
//register, sk256(x) / sk512(x) hashes, numbers and date(...) are 64 bit. AND/OR are written in capitals or lower
//case; a level holds only AND or only OR, as in the core.
import { addressOfMemory, hexOfMemory, memoryOfAddress, memoryOfHex } from '../../../../wallet/src/lib/tritium';
import type { Condition, Operand, RegisterField, Source } from './ast';
import type { CompareOp, MathOp } from './opcodes';

const sources: Source[] = ['caller.genesis', 'caller.timestamp', 'contract.genesis', 'contract.timestamp', 'ledger.timestamp', 'ledger.height'];
const timeSources = new Set<Source>(['caller.timestamp', 'contract.timestamp', 'ledger.timestamp']);
const fields = ['owner', 'created', 'modified', 'type', 'state'] as const;
const compares: CompareOp[] = ['==', '!=', '<=', '>=', '<', '>', 'contains'];
const maths: MathOp[] = ['+', '-', '*', '/', '%'];

//--- print ---

function dateText(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().replace(/:00\.000Z$/, 'Z').replace(/\.000Z$/, 'Z');
}

function isTime(o: Operand): boolean {
  return o.kind === 'source' && timeSources.has(o.source);
}

function printOperand(o: Operand, asDate = false): string {
  switch (o.kind) {
    case 'source':
      return o.source;
    case 'uint64':
      return asDate ? `date(${dateText(o.value)})` : o.value.toString();
    case 'uint256':
      return `0x${hexOfMemory(o.bytes)}`;
    case 'string':
      return JSON.stringify(o.value);
    case 'register': {
      const f = typeof o.field === 'string' ? o.field : `value(${JSON.stringify(o.field.value)})`;
      return `register(${addressOfMemory(o.address)}).${f}`;
    }
    case 'hash':
      return `${o.alg}(${printOperand(o.of)})`;
    case 'math':
      return `${printOperand(o.left)} ${o.op} ${printOperand(o.right, isTime(o.left))}`;
  }
}

function printCondition(c: Condition, depth: number, multiline: boolean): string {
  switch (c.kind) {
    case 'compare': {
      const dated = isTime(c.left) || isTime(c.right);
      return `${printOperand(c.left, dated)} ${c.op} ${printOperand(c.right, dated)}`;
    }
    case 'group':
      return `(${printCondition(c.item, depth + 1, false)})`;
    case 'and':
    case 'or': {
      const parts = c.items.map((i) => (i.kind === 'and' || i.kind === 'or' ? `(${printCondition(i, depth + 1, false)})` : printCondition(i, depth + 1, false)));
      const sep = c.kind === 'and' ? ' AND ' : ' OR ';
      return multiline && depth === 0 ? parts.join(`\n${sep.trim()} `) : parts.join(sep);
    }
  }
}

/** Condition to console text, one top level part per line */
export function print(c: Condition): string {
  return printCondition(c, 0, true);
}

//--- parse ---

export class ParseError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

type Tok = { t: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s+|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|date\([^)]*\)|register\(\s*[^)\s]*\s*\)|0x[0-9a-fA-F]+|[A-Za-z_][\w.]*|\d+|==|!=|<=|>=|[<>()+\-*/%.]/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      throw new ParseError(`unexpected "${src[pos]}"`, pos);
    }
    const t = m[0];
    if (!/^\s/.test(t) && !t.startsWith('//')) {
      out.push({ t, pos });
    }
    pos = re.lastIndex;
  }
  return out;
}

class Parser {
  i = 0;
  constructor(
    private toks: Tok[],
    private end: number,
  ) {}
  peek(): string | undefined {
    return this.toks[this.i]?.t;
  }
  pos(): number {
    return this.toks[this.i]?.pos ?? this.end;
  }
  next(): string {
    const t = this.toks[this.i];
    if (!t) {
      throw new ParseError('the condition ends too early', this.end);
    }
    this.i++;
    return t.t;
  }
  expect(t: string) {
    const p = this.pos();
    const got = this.next();
    if (got !== t) {
      throw new ParseError(`expected "${t}" but found "${got}"`, p);
    }
  }
  logic(): 'and' | 'or' | undefined {
    const t = this.peek()?.toLowerCase();
    return t === 'and' || t === 'or' ? t : undefined;
  }

  expr(): Condition {
    const first = this.term();
    const items = [first];
    let kind: 'and' | 'or' | undefined;
    for (let k = this.logic(); k; k = this.logic()) {
      const p = this.pos();
      this.next();
      if (kind && kind !== k) {
        throw new ParseError('AND and OR on the same level: put one side in brackets', p);
      }
      kind = k;
      items.push(this.term());
    }
    return kind ? { kind, items } : first;
  }

  //a bracket opens a group of conditions unless it only wraps a value (checked by a trial parse)
  term(): Condition {
    if (this.peek() === '(') {
      const save = this.i;
      try {
        this.next();
        const inner = this.expr();
        this.expect(')');
        if (!this.isCompare(this.peek()) && !maths.includes(this.peek() as MathOp)) {
          return inner;
        }
      } catch {
        //not a condition group
      }
      this.i = save;
    }
    const left = this.operand();
    const p = this.pos();
    const op = this.next();
    if (!this.isCompare(op)) {
      throw new ParseError(`expected a comparison (==, !=, <, >, <=, >=, contains) but found "${op}"`, p);
    }
    return { kind: 'compare', op: op as CompareOp, left, right: this.operand() };
  }

  isCompare(t: string | undefined): boolean {
    return t !== undefined && compares.includes(t as CompareOp);
  }

  operand(): Operand {
    let o = this.value();
    while (maths.includes(this.peek() as MathOp)) {
      const op = this.next() as MathOp;
      o = { kind: 'math', op, left: o, right: this.value() };
    }
    return o;
  }

  value(): Operand {
    const p = this.pos();
    const t = this.next();
    if (t === '(') {
      const o = this.operand();
      this.expect(')');
      return o;
    }
    if ((sources as string[]).includes(t)) {
      return { kind: 'source', source: t as Source };
    }
    if (/^\d+$/.test(t)) {
      const v = BigInt(t);
      if (v >= 1n << 64n) {
        throw new ParseError('number is larger than 64 bits', p);
      }
      return { kind: 'uint64', value: v };
    }
    if (t.startsWith('date(')) {
      const inner = t.slice(5, -1).trim();
      const ms = /^\d+$/.test(inner) ? Number(inner) * 1000 : Date.parse(inner);
      if (!Number.isFinite(ms)) {
        throw new ParseError(`not a date: ${inner}`, p);
      }
      return { kind: 'uint64', value: BigInt(Math.floor(ms / 1000)) };
    }
    if (t.startsWith('0x')) {
      if (t.length !== 66) {
        throw new ParseError('a 0x value must have 64 hex digits', p);
      }
      return { kind: 'uint256', bytes: memoryOfHex(t.slice(2).toLowerCase()) };
    }
    if (t.startsWith('"')) {
      const s = JSON.parse(t) as string;
      if (!s) {
        throw new ParseError('empty text is not allowed', p);
      }
      return { kind: 'string', value: s };
    }
    if (t === 'sk256' || t === 'sk512') {
      this.expect('(');
      const of = this.operand();
      this.expect(')');
      return { kind: 'hash', alg: t, of };
    }
    if (t.startsWith('register(')) {
      const a = t.slice(9, -1).trim();
      let address: Uint8Array;
      try {
        address = a.startsWith('0x') && a.length === 66 ? memoryOfHex(a.slice(2).toLowerCase()) : memoryOfAddress(a);
      } catch {
        throw new ParseError(`not a register address: ${a || '(empty)'}`, p);
      }
      return { kind: 'register', address, field: this.field() };
    }
    throw new ParseError(`unknown value "${t}"`, p);
  }

  field(): RegisterField {
    this.expect('.');
    const p = this.pos();
    const t = this.next();
    if ((fields as readonly string[]).includes(t)) {
      return t as (typeof fields)[number];
    }
    if (t === 'value') {
      this.expect('(');
      const np = this.pos();
      const n = this.next();
      if (!n.startsWith('"')) {
        throw new ParseError('value needs a field name in quotes, e.g. value("address")', np);
      }
      this.expect(')');
      return { value: JSON.parse(n) as string };
    }
    throw new ParseError(`unknown register field "${t}" (owner, created, modified, type, state, value("name"))`, p);
  }
}

/** Console text to a condition; throws ParseError with the character position */
export function parse(src: string): Condition {
  const toks = tokenize(src);
  if (toks.length === 0) {
    throw new ParseError('the condition is empty', 0);
  }
  const p = new Parser(toks, src.length);
  const c = p.expr();
  if (p.peek() !== undefined) {
    throw new ParseError(`unexpected "${p.peek()}"`, p.pos());
  }
  return c;
}
