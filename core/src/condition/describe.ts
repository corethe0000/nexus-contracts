import { addressOfMemory, hexOfMemory } from '../../../../wallet/src/lib/tritium';
import type { Condition, Operand } from './ast';
import type { CompareOp } from './opcodes';
import { decision, decisionField } from '../templates';
import { codeBoxAddress, codeBoxField } from '../code';

/** Names to show for known values: genesis hex (as the node prints it) or register address (base58) */
export type Labels = Record<string, string>;

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s);

function when(seconds: bigint): string {
  if (seconds > 8640000000000n) {
    return `time ${seconds}`;
  }
  return new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace(/:00\.000Z$/, ' UTC').replace(/\.000Z$/, ' UTC');
}

//every phrase goes through t (the module's translations); {name} placeholders are filled here by default
export type Translate = (text: string, vars?: Record<string, string>) => string;
//marks a phrase that is looked up later (from a map) so tools/i18n.mjs finds it
const phrase = (s: string) => s;
const plain: Translate = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m) : text);

function value(o: Operand, x: Ctx): string {
  const t = x.t;
  switch (o.kind) {
    case 'source':
      return t(
        {
          'caller.genesis': phrase('the claimer'),
          'caller.timestamp': phrase('the time the claimer wrote in the claim'),
          'contract.genesis': phrase('the sender'),
          'contract.timestamp': phrase('the time the sender wrote in the contract'),
          'ledger.timestamp': phrase('the block time'),
          'ledger.height': phrase('the block height'),
        }[o.source],
      );
    case 'uint64':
      return o.value.toString();
    case 'uint256': {
      const hex = hexOfMemory(o.bytes);
      return x.labels[hex] ?? t('user {id}', { id: short(hex) });
    }
    case 'string':
      return `"${o.value}"`;
    case 'register': {
      const a = addressOfMemory(o.address);
      const name = x.labels[a] ?? t('register {id}', { id: short(a) });
      if (o.field === 'owner') {
        return t('the owner of {name}', { name });
      }
      return typeof o.field === 'string' ? t('the {field} of {name}', { field: o.field, name }) : t('the field "{field}" of {name}', { field: o.field.value, name });
    }
    case 'hash':
      return t('the {alg} hash of {value}', { alg: o.alg, value: value(o.of, x) });
    case 'math':
      return `${value(o.left, x)} ${o.op} ${value(o.right, x)}`;
  }
}

const words: Record<CompareOp, string> = {
  '==': phrase('if {a} is {b}'),
  '!=': phrase('if {a} is not {b}'),
  '<': phrase('if {a} is below {b}'),
  '>': phrase('if {a} is above {b}'),
  '<=': phrase('if {a} is at most {b}'),
  '>=': phrase('if {a} is at least {b}'),
  contains: phrase('if {a} contains {b}'),
};

export interface DescribeOptions {
  labels?: Labels;
  sender?: string; //genesis of who sent the payment: their way reads "can take it back"
  me?: string; //genesis of who reads it: "the recipient or you" when that is the sender
  time?: (seconds: number) => string; //how times are written (default UTC)
  t?: Translate;
}

interface Ctx {
  labels: Labels;
  sender?: string;
  me?: string;
  time: (seconds: number) => string;
  t: Translate;
}

function isWho(c: Condition): c is Extract<Condition, { kind: 'compare' }> & { right: Extract<Operand, { kind: 'uint256' }> } {
  return c.kind === 'compare' && c.op === '==' && c.left.kind === 'source' && c.left.source === 'caller.genesis' && c.right.kind === 'uint256';
}

function part(c: Condition, x: Ctx): string {
  const t = x.t;
  switch (c.kind) {
    case 'compare': {
      const { left, right, op } = c;
      if (left.kind === 'source' && left.source === 'caller.genesis' && right.kind === 'uint256') {
        return op === '==' ? t('if {who} claims', { who: value(right, x) }) : t('if anyone but {who} claims', { who: value(right, x) });
      }
      if (left.kind === 'source' && left.source === 'ledger.timestamp' && right.kind === 'uint64') {
        const time = x.time(Number(right.value));
        const timeText = { '<': phrase('before {time}'), '<=': phrase('until {time}'), '>=': phrase('from {time}'), '>': phrase('after {time}') }[op as '<'];
        return timeText ? t(timeText, { time }) : t(words[op], { a: t('the block time'), b: time });
      }
      return t(words[op], { a: value(left, x), b: value(right, x) });
    }
    case 'group':
      return part(c.item, x);
    case 'and':
      return c.items.map((i) => part(i, x)).join(t(' and '));
    case 'or':
      return `(${c.items.map((i) => part(i, x)).join(t(', or '))})`;
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
  return x.t(v[0] === decision.release ? phrase('once {arbiter} decides release') : phrase('once {arbiter} decides refund'), { arbiter: value(a.right, x) });
}

//the code box check: owner == G and sk256(G's code box value) == H
function codePhrase(a: Condition, b: Condition | undefined, x: Ctx): string | null {
  if (!b || a.kind !== 'compare' || b.kind !== 'compare' || a.left.kind !== 'register' || a.left.field !== 'owner' || a.right.kind !== 'uint256') {
    return null;
  }
  const h = b.left;
  if (h.kind !== 'hash' || h.of.kind !== 'register' || typeof h.of.field !== 'object' || h.of.field.value !== codeBoxField) {
    return null;
  }
  const g = hexOfMemory(a.right.bytes);
  if (addressOfMemory(a.left.address) !== addressOfMemory(h.of.address) || addressOfMemory(a.left.address) !== addressOfMemory(codeBoxAddress(g))) {
    return null;
  }
  return x.t('with the code the sender gives');
}

function parts(list: Condition[], x: Ctx): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = decisionPhrase(list[i]!, list[i + 1], x) ?? codePhrase(list[i]!, list[i + 1], x);
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
  const t = x.t;
  const all = w.kind === 'and' ? w.items : w.kind === 'group' ? [w.item] : [w];
  const who = all.filter(isWho);
  const rest = parts(
    all.filter((p) => !isWho(p) || who.length !== 1),
    x,
  );
  const conditions = rest.join(t(' and '));
  if (who.length !== 1) {
    //a claim goes into the claimer's own account: without a who part only the recipient or the sender can use it
    const senderIsMe = !!x.sender && (x.sender === x.me || x.labels[x.sender] === 'You');
    const subject = who.length === 0 ? (senderIsMe ? t('The recipient or you') : t('The recipient or the sender')) : t('Anyone it allows');
    return rest.length ? t('{who} can claim {conditions}', { who: subject, conditions }) : t('{who} can claim', { who: subject });
  }
  const g = hexOfMemory(who[0]!.right.bytes);
  //the reader gets own sentences: "you" changes the verb in many languages
  if (x.me && g === x.me) {
    if (g === x.sender) {
      return rest.length ? t('You can take it back {conditions}', { conditions }) : t('You can take it back');
    }
    return rest.length ? t('You can claim {conditions}', { conditions }) : t('You can claim');
  }
  const name = value(who[0]!.right, x);
  if (g === x.sender) {
    return rest.length ? t('{who} can take it back {conditions}', { who: name, conditions }) : t('{who} can take it back', { who: name });
  }
  return rest.length ? t('{who} can claim {conditions}', { who: name, conditions }) : t('{who} can claim', { who: name });
}

/** One line per way the contract can be claimed */
export function describe(c: Condition, opts: DescribeOptions | Labels = {}): string[] {
  const o: DescribeOptions = 'labels' in opts || 'sender' in opts || 'time' in opts || 't' in opts ? (opts as DescribeOptions) : { labels: opts as Labels };
  const x: Ctx = { labels: o.labels ?? {}, sender: o.sender, me: o.me, time: o.time ?? ((s) => when(BigInt(s))), t: o.t ?? plain };
  const ways = c.kind === 'or' ? c.items : [c];
  return ways.map((w) => {
    const s = sentence(w, x);
    return s.charAt(0).toUpperCase() + s.slice(1);
  });
}
