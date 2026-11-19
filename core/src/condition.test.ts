import { describe as suite, expect, it } from 'vitest';
import { expiryCondition, hexOfMemory, memoryOfHex, addressOfMemory } from '../../../wallet/src/lib/tritium';
import { lockCondition } from '../../../wallet/src/lib/htlc';
import { and, compare, or, register, source, u256, u64, type Condition } from './condition/ast';
import { decode, encode } from './condition/encode';
import { parse, print, ParseError } from './condition/text';
import { describe } from './condition/describe';
import { approvals, decisionAddress, escrow, returnIfUnclaimed, timeLock } from './templates';
import { decisionIds, toCondition, toWays } from './blocks';
import { contractKind } from './kind';
import { codeHash, codeRelease, newCode } from './code';
import { claimFee, costOf } from './cost';

const alice = 'a1'.repeat(32);
const bob = 'b2'.repeat(32);
const carol = 'c3'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

suite('encoder matches conditions already used on chain', () => {
  it('wallet expiryCondition (API AddExpires)', () => {
    const me = u256(memoryOfHex(alice));
    const half = (who: '!=' | '==', cmp: '>' | '<') =>
      and(compare(source('caller.genesis'), who, me), compare({ kind: 'math', op: '+', left: source('contract.timestamp'), right: u64(604800) }, cmp, source('caller.timestamp')));
    expect(hex(encode(or(half('!=', '>'), half('==', '<'))))).toBe(hex(expiryCondition(alice, 604800)));
    expect(hex(encode({ kind: 'group', item: compare(source('caller.genesis'), '!=', me) }))).toBe(hex(expiryCondition(alice, 0)));
  });

  it('DEX hash lock (htlc lockCondition)', () => {
    const terms = { recipient: bob, sender: alice, hashlock: new Uint8Array(32).fill(7), deadline: 1790000000 };
    const bytes = lockCondition(terms);
    const back = decode(bytes);
    expect(hex(encode(back))).toBe(hex(bytes));
    expect(print(back)).toContain('sk256(register(');
  });
});

suite('round trips', () => {
  const cases: [string, Condition][] = [
    ['return if unclaimed', returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 })],
    ['time-lock', timeLock({ sender: alice, recipient: bob, unlock: 1790000000 })],
    ['time-lock with cancel and return', timeLock({ sender: alice, recipient: bob, unlock: 1790000000, cancelable: true, returnAfter: 1800000000 })],
    ['escrow', escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42' })],
    ['escrow with fallback', escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42', fallback: 1800000000 })],
  ];
  for (const [name, c] of cases) {
    it(name, () => {
      const bytes = encode(c);
      expect(hex(encode(decode(bytes)))).toBe(hex(bytes));
      const text = print(c);
      expect(hex(encode(parse(text)))).toBe(hex(bytes));
    });
  }
});

suite('console text', () => {
  it('reads typed text with dates, lower case logic and comments', () => {
    const typed = `// pay bob, back to alice after new year
      (caller.genesis == 0x${alice} and ledger.timestamp >= date(2027-01-01T00:00Z))
      or (caller.genesis == 0x${bob} and ledger.timestamp < date(2027-01-01T00:00Z))`;
    const c = parse(typed);
    expect(c.kind).toBe('or');
    expect(print(c)).toContain('date(2027-01-01T00:00Z)');
  });

  it('prints one way per line', () => {
    const text = print(returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 }));
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[1]!.startsWith('OR ')).toBe(true);
  });

  it('reads register addresses in base58 and hex', () => {
    const reg = decisionAddress(carol, 'order42');
    const a = parse(`register(${addressOfMemory(reg)}).owner == 0x${carol}`);
    const b = parse(`register(0x${hexOfMemory(reg)}).owner == 0x${carol}`);
    expect(hex(encode(a))).toBe(hex(encode(b)));
    expect(hex(encode(a))).toBe(hex(encode(compare(register(reg, 'owner'), '==', u256(memoryOfHex(carol))))));
  });

  it('refuses AND and OR mixed on one level, like the core', () => {
    expect(() => parse('ledger.height > 1 AND ledger.height < 5 OR ledger.height == 9')).toThrow(/same level/);
  });

  it('gives the position of an error', () => {
    try {
      parse('ledger.height >> 5');
      throw new Error('no error');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).pos).toBe(15);
    }
  });

  it('refuses bad values', () => {
    expect(() => parse('caller.genesis == 0x1234')).toThrow(/64 hex/);
    expect(() => parse('ledger.timestamp > date(soon)')).toThrow(/not a date/);
    expect(() => parse('register(0x00).value == 1')).toThrow(/register address/);
  });
});

suite('plain words', () => {
  it('describes each way to claim', () => {
    const lines = describe(returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 }), { [alice]: 'Alice', [bob]: 'Bob' });
    expect(lines).toEqual(['Bob can claim before 2026-09-21 14:13:20 UTC', 'Alice can claim from 2026-09-21 14:13:20 UTC']);
    const asSender = describe(returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 }), { labels: { [alice]: 'You', [bob]: 'Bob' }, sender: alice, time: () => 'then' });
    expect(asSender).toEqual(['Bob can claim before then', 'You can take it back from then']);
  });

  it('says who decides an escrow', () => {
    const lines = describe(escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42', fallback: 1800000000 }), { labels: { [carol]: 'Carol', [bob]: 'Bob', [alice]: 'You' }, sender: alice, time: () => 'then' });
    expect(lines).toEqual(['Bob can claim once Carol decides release', 'You can take it back once Carol decides refund', 'You can take it back from then']);
  });
});

suite('template checks', () => {
  it('refuses bad input', () => {
    expect(() => returnIfUnclaimed({ sender: 'x', recipient: bob, deadline: 1 })).toThrow(/sender/);
    expect(() => timeLock({ sender: alice, recipient: bob, unlock: 1790000000, returnAfter: 1700000000 })).toThrow(/after the unlock/);
    expect(() => escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'Bad Id' })).toThrow(/escrow id/);
  });
});

suite('builder blocks', () => {
  it('turns every template into blocks and back to the same bytes', () => {
    const ids = decisionIds([{ arbiter: carol, id: 'order42' }]);
    for (const c of [
      returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 }),
      timeLock({ sender: alice, recipient: bob, unlock: 1790000000, cancelable: true, returnAfter: 1800000000 }),
      escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42', fallback: 1800000000 }),
    ]) {
      const ways = toWays(c, ids);
      expect(ways.flat().some((b) => b.kind === 'code')).toBe(false);
      expect(hex(encode(toCondition(ways)))).toBe(hex(encode(c)));
    }
  });

  it('keeps unknown parts as code blocks without losing them', () => {
    const c = parse(`(caller.genesis == 0x${bob} AND ledger.height > 5000) OR contract.genesis == 0x${alice}`);
    const ways = toWays(c);
    expect(ways[0]!.map((b) => b.kind)).toEqual(['who', 'code']);
    expect(ways[1]![0]!.kind).toBe('code');
    expect(hex(encode(toCondition(ways)))).toBe(hex(encode(c)));
  });

  it('shows an escrow decision as code when the id is not known', () => {
    const ways = toWays(escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42' }));
    expect(ways[0]!.filter((b) => b.kind === 'code')).toHaveLength(2);
  });

  it('refuses an empty contract and missing people', () => {
    expect(() => toCondition([[]])).toThrow(/at least one way/);
    expect(() => toCondition([[{ kind: 'who', genesis: '' }]])).toThrow(/who may claim/);
  });
});

suite('kinds', () => {
  it('tells contracts from swap locks and ordinary payments', () => {
    expect(contractKind(returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 }))).toBe('contract');
    expect(contractKind(escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42' }))).toBe('contract');
    expect(contractKind(decode(expiryCondition(alice, 604800)))).toBe('expiry');
    expect(contractKind(decode(lockCondition({ recipient: bob, sender: alice, hashlock: new Uint8Array(32), deadline: 1790000000 })))).toBe('swap');
  });
});

suite('review fixes', () => {
  it('prints and describes a time beyond the date range without crashing', () => {
    const c = parse('ledger.timestamp < 99999999999999');
    expect(print(c)).toContain('99999999999999');
    expect(describe(c)[0]).toContain('99999999999999');
    expect(hex(encode(parse(print(c))))).toBe(hex(encode(c)));
  });

  it('refuses math or a hash right of math, which the chain would read differently', () => {
    expect(() => parse('ledger.height > 10 + (2 * 3)')).toThrow(/plain value/);
    expect(() => parse(`caller.genesis == 0x${alice} + sk256(ledger.height)`)).toThrow(/plain value/);
    expect(hex(encode(parse('ledger.height > 10 + 2 * 3')))).toBe(hex(encode(parse('ledger.height > 10 + 2 * 3'))));
  });

  it('reports the real error inside brackets', () => {
    expect(() => parse('(caller.genesis == 0x12 AND ledger.height > 1)')).toThrow(/64 hex/);
    expect(() => parse('(ledger.height > 1 AND ledger.height > 2 OR ledger.height > 3)')).toThrow(/same level/);
  });

  it('reads console times without a zone as UTC', () => {
    const a = parse('ledger.timestamp < date(2027-01-01T00:00)');
    const b = parse('ledger.timestamp < date(2027-01-01T00:00Z)');
    const c = parse('ledger.timestamp < date(2027-01-01T01:00+01:00)');
    expect(hex(encode(a))).toBe(hex(encode(b)));
    expect(hex(encode(c))).toBe(hex(encode(b)));
  });

  it('keeps custom contracts that use a hash or a transaction time visible', () => {
    expect(contractKind(parse('ledger.timestamp >= contract.timestamp + 86400'))).toBe('contract');
    expect(contractKind(parse(`sk256(register(0x${carol}).value("address")) == 0x${bob}`))).toBe('contract');
    expect(contractKind(decode(expiryCondition(alice, 0)))).toBe('expiry');
  });
});

suite('wording', () => {
  it('names who can use a way without a who part', () => {
    const c = parse('ledger.height > 1');
    expect(describe(c)[0]).toBe('The recipient or the sender can claim if the block height is above 1');
    expect(describe(c, { labels: { [alice]: 'You' }, sender: alice })[0]).toBe('The recipient or you can claim if the block height is above 1');
  });
});

suite('release with a code', () => {
  it('makes readable codes that survive typing differences', () => {
    const c = newCode();
    expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hex(codeHash(c))).toBe(hex(codeHash(c.toLowerCase().replace(/-/g, ' '))));
    expect(hex(codeHash(c))).not.toBe(hex(codeHash(newCode())));
  });

  it('round trips through bytes, text and blocks, and reads in plain words', () => {
    const code = 'ABCD-EFGH-JKLM-NPQR';
    const c = codeRelease({ sender: alice, recipient: bob, hash: codeHash(code), takeBackFrom: 1790000000 });
    const bytes = encode(c);
    expect(hex(encode(decode(bytes)))).toBe(hex(bytes));
    expect(hex(encode(parse(print(c))))).toBe(hex(bytes));
    const ways = toWays(c);
    expect(ways[0]!.map((b) => b.kind)).toEqual(['who', 'secret']);
    expect(hex(encode(toCondition(ways)))).toBe(hex(bytes));
    expect(describe(c, { labels: { [alice]: 'You', [bob]: 'Bob' }, sender: alice, time: () => 'then' })).toEqual(['Bob can claim with the code the sender gives', 'You can take it back from then']);
    expect(contractKind(c)).toBe('contract');
  });
});

suite('claim cost and fee', () => {
  it('counts like the core: a plain deadline contract is free', () => {
    //two groups 2*128, each way: caller.genesis 32 + uint256 32, ledger.timestamp 8 + uint64 8
    const c = returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 });
    expect(costOf(c)).toBe(416);
    expect(claimFee(c)).toBe(0n);
  });

  it('an escrow reads two registers per way and needs a fee', () => {
    //each way: who 64, owner (32 + 4128 + 32), address value (32 + 4096 + 32 + 32); plus two groups
    const c = escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42' });
    expect(costOf(c)).toBe(2 * (64 + 4192 + 4192) + 256);
    expect(claimFee(c)).toBe(BigInt(2 * (64 + 4192 + 4192) + 256 - 4096));
  });

  it('a code release adds the hash', () => {
    const c = codeRelease({ sender: alice, recipient: bob, hash: codeHash('ABCD-EFGH-JKLM'), takeBackFrom: 1800000000 });
    //way 1: who 64 + owner 4192 + sk256(value) (4160 + 2048) + uint256 32; way 2: 80; two groups
    expect(costOf(c)).toBe(64 + 4192 + 4160 + 2048 + 32 + 80 + 256);
  });
});

suite('approvals by several people', () => {
  const dave = 'd4'.repeat(32);
  const erin = 'e5'.repeat(32);
  it('2 of 3: three ways to release, two refusals (any pair) to refund', () => {
    const c = approvals({ sender: alice, recipient: bob, approvers: [carol, dave, erin], required: 2, id: 'deal7' });
    expect(c.kind === 'or' && c.items.length).toBe(3 + 3);
    const ways = toWays(c, decisionIds([carol, dave, erin].map((a) => ({ arbiter: a, id: 'deal7' }))));
    expect(ways.flat().some((b) => b.kind === 'code')).toBe(false);
    expect(hex(encode(toCondition(ways)))).toBe(hex(encode(c)));
    const words = describe(c, { labels: { [alice]: 'You', [bob]: 'Bob', [carol]: 'Carol', [dave]: 'Dave', [erin]: 'Erin' }, sender: alice, me: alice });
    expect(words[0]).toBe('Bob can claim once Carol decides release and once Dave decides release');
    expect(words[3]).toBe('You can take it back once Carol decides refund and once Dave decides refund');
  });

  it('1 of 2 needs both refusals to refund, and refuses bad setups', () => {
    const c = approvals({ sender: alice, recipient: bob, approvers: [carol, dave], required: 1, id: 'deal7', fallback: 1800000000 });
    expect(c.kind === 'or' && c.items.length).toBe(2 + 1 + 1);
    expect(() => approvals({ sender: alice, recipient: bob, approvers: [carol, carol], required: 1, id: 'deal7' })).toThrow(/only once/);
    expect(() => approvals({ sender: alice, recipient: bob, approvers: [carol, bob], required: 1, id: 'deal7' })).toThrow(/other people/);
    expect(() => approvals({ sender: alice, recipient: bob, approvers: [carol, dave], required: 3, id: 'deal7' })).toThrow(/between 1/);
  });

  it('3 of 5 stays within one transaction and shows its claim fee', () => {
    const five = ['c1', 'c2', 'c3', 'c4', 'c5'].map((x) => x.repeat(32));
    const c = approvals({ sender: alice, recipient: bob, approvers: five, required: 3, id: 'deal7' });
    expect(c.kind === 'or' && c.items.length).toBe(10 + 10);
    expect(encode(c).length).toBeLessThan(10000);
    expect(Number(claimFee(c))).toBeGreaterThan(400000);
  });
});
