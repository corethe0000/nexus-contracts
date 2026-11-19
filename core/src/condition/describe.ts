import { addressOfMemory, hexOfMemory } from '../../../../wallet/src/lib/tritium';
import type { Condition, Operand } from './ast';
import type { CompareOp } from './opcodes';
import { decision, decisionField } from '../templates';

/** Names to show for known values: genesis hex (as the node prints it) or register address (base58) */
export type Labels = Record<string, string>;

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s);

function when(seconds: bigint): string {
  if (seconds > 8640000000000n) {
    return `time ${seconds}`;
  }
  return new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace(/:00\.000Z$/, ' UTC').replace(/\.000Z$/, ' UTC');
}

function value(o: Operand, labels: Labels): string {
  switch (o.kind) {
    case 'source':
      return {
        'caller.genesis': 'the claimer',
        'caller.timestamp': 'the time the claimer wrote in the claim',
        'contract.genesis': 'the sender',
        'contract.timestamp': 'the time the sender wrote in the contract',
        'ledger.timestamp': 'the block time',
        'ledger.height': 'the block height',
      }[o.source];
    case 'uint64':
      return o.value.toString();
    case 'uint256': {
      const hex = hexOfMemory(o.bytes);
      return labels[hex] ?? `user ${short(hex)}`;
    }
    case 'string':
      return `"${o.value}"`;
    case 'register': {
      const a = addressOfMemory(o.address);
      const name = labels[a] ?? `register ${short(a)}`;
      const f = typeof o.field === 'string' ? o.field : `field "${o.field.value}"`;
      return f === 'owner' ? `the owner of ${name}` : `the ${f} of ${name}`;
    }
    case 'hash':
      return `the ${o.alg} hash of ${value(o.of, labels)}`;
    case 'math':
      return `${value(o.left, labels)} ${o.op} ${value(o.right, labels)}`;
  }
}

const words: Record<CompareOp, string> = {
  '==': 'is',
  '!=': 'is not',
  '<': 'is below',
  '>': 'is above',
  '<=': 'is at most',
  '>=': 'is at least',
  contains: 'contains',
};

export interface DescribeOptions {
  labels?: Labels;
  sender?: string; //genesis of who sent the payment: their way reads "can take it back"
  time?: (seconds: number) => string; //how times are written (default UTC)
}

interface Ctx {
  labels: Labels;
  sender?: string;
  time: (seconds: number) => string;
}

function isWho(c: Condition): c is Extract<Condition, { kind: 'compare' }> & { right: Extract<Operand, { kind: 'uint256' }> } {
  return c.kind === 'compare' && c.op === '==' && c.left.kind === 'source' && c.left.source === 'caller.genesis' && c.right.kind === 'uint256';
}

function part(c: Condition, x: Ctx): string {
  switch (c.kind) {
    case 'compare': {
      const { left, right, op } = c;
      if (left.kind === 'source' && left.source === 'caller.genesis' && right.kind === 'uint256') {
        return op === '==' ? `if ${value(right, x.labels)} claims` : `if anyone but ${value(right, x.labels)} claims`;
      }
      if (left.kind === 'source' && left.source === 'ledger.timestamp' && right.kind === 'uint64') {
        const t = x.time(Number(right.value));
        return { '<': `before ${t}`, '<=': `until ${t}`, '>=': `from ${t}`, '>': `after ${t}` }[op as '<'] ?? `if the block time ${words[op]} ${t}`;
      }
      return `if ${value(left, x.labels)} ${words[op]} ${value(right, x.labels)}`;
    }
    case 'group':
      return part(c.item, x);
    case 'and':
      return c.items.map((i) => part(i, x)).join(' and ');
    case 'or':
      return `(${c.items.map((i) => part(i, x)).join(', or ')})`;
  }
}

//an escrow decision: owner == arbiter, then the register's "address" field == 1 (release) or 2 (refund)
function decisionPhrase(a: Condition, b: Condition | undefined, x: Ctx): string | null {
  if (!b || a.kind !== 'compare' || b.kind !== 'compare' || a.left.kind !== 'register' || b.left.kind !== 'register') {
    return null;
  }
  if (a.left.field !== 'owner' || typeof b.left.field !== 'object' || b.left.field.value !== decisionField || a.right.kind !== 'uint256' || b.right.kind !== 'uint256') {
    return null;
  }
  if (addressOfMemory(a.left.address) !== addressOfMemory(b.left.address) || a.op !== '==' || b.op !== '==') {
    return null;
  }
  const v = b.right.bytes;
  if (v.slice(1).some((n) => n !== 0) || (v[0] !== decision.release && v[0] !== decision.refund)) {
    return null;
  }
  return `once ${value(a.right, x.labels)} decides ${v[0] === decision.release ? 'release' : 'refund'}`;
}

function parts(list: Condition[], x: Ctx): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = decisionPhrase(list[i]!, list[i + 1], x);
    if (d) {
      out.push(d);
      i++;
    } else {
      out.push(part(list[i]!, x));
    }
  }
  return out;
}

//"Bob can claim before ...", "You can take it back from ...": the who part becomes the subject
function sentence(w: Condition, x: Ctx): string {
  const all = w.kind === 'and' ? w.items : w.kind === 'group' ? [w.item] : [w];
  const who = all.filter(isWho);
  const rest = parts(
    all.filter((p) => !isWho(p) || who.length !== 1),
    x,
  );
  if (who.length !== 1) {
    //a claim goes into the claimer's own account: without a who part only the recipient or the sender can use it
    const subject = who.length === 0 ? `The recipient or ${x.sender && x.labels[x.sender] === 'You' ? 'you' : 'the sender'}` : 'Anyone it allows';
    return `${subject} can claim${rest.length ? ` ${rest.join(' and ')}` : ''}`;
  }
  const g = hexOfMemory(who[0]!.right.bytes);
  const name = value(who[0]!.right, x.labels);
  const verb = g === x.sender ? 'can take it back' : 'can claim';
  return `${name} ${verb}${rest.length ? ` ${rest.join(' and ')}` : ''}`;
}

/** One line per way the contract can be claimed */
export function describe(c: Condition, opts: DescribeOptions | Labels = {}): string[] {
  const o: DescribeOptions = 'labels' in opts || 'sender' in opts || 'time' in opts ? (opts as DescribeOptions) : { labels: opts as Labels };
  const x: Ctx = { labels: o.labels ?? {}, sender: o.sender, time: o.time ?? ((t) => when(BigInt(t))) };
  const ways = c.kind === 'or' ? c.items : [c];
  return ways.map((w) => {
    const s = sentence(w, x);
    return s.charAt(0).toUpperCase() + s.slice(1);
  });
}
