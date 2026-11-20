import { describe, expect, it } from 'vitest';
import {
  returnIfUnclaimed,
  timeLock,
  escrow,
  codeRelease,
  codeHash,
  newCode,
} from '@nexus-contracts/core/src';
import { contractStatus, decisionKey } from './status';
import type { ChainContract, DecisionState } from './chain';
import type { Condition } from '@nexus-contracts/core/src';

const alice = 'a1'.repeat(32); // sender
const bob = 'b2'.repeat(32); // recipient
const carol = 'c3'.repeat(32); // arbiter
const bobAccount = '8bobaccount';
const now = 1_790_000_000;

const mk = (
  condition: Condition,
  over: Partial<ChainContract> = {},
): ChainContract => ({
  txid: '01'.repeat(64),
  contract: 0,
  time: now - 100,
  sender: alice,
  from: '8alice',
  to: bobAccount,
  token: '0',
  ticker: 'NXS',
  amount: 100000n,
  open: 100000n,
  decimals: 6,
  condition,
  kind: 'custom',
  ...over,
});

const bobOwns = new Set([bobAccount]);
const nobody = new Set<string>();
const noEscrows: { arbiter: string; id: string }[] = [];
const noDecisions = new Map<string, DecisionState>();

describe('contractStatus', () => {
  it('return-if-unclaimed: recipient can claim before the deadline', () => {
    const c = mk(
      returnIfUnclaimed({
        sender: alice,
        recipient: bob,
        deadline: now + 3600,
      }),
    );
    const s = contractStatus(c, bob, now, noDecisions, noEscrows, bobOwns);
    expect(s.canClaim).toBe(true);
    expect(s.needsCode).toBe(false);
    expect(s.closed).toBe(false);
  });

  it('return-if-unclaimed: after the deadline the recipient cannot claim, and it is not left waiting', () => {
    const c = mk(
      returnIfUnclaimed({ sender: alice, recipient: bob, deadline: now - 10 }),
    );
    const s = contractStatus(c, bob, now, noDecisions, noEscrows, bobOwns);
    expect(s.canClaim).toBe(false);
    expect(s.waiting).toEqual([]); // an ended way is not something to wait for
  });

  it('return-if-unclaimed: the sender can take it back after the deadline', () => {
    const c = mk(
      returnIfUnclaimed({ sender: alice, recipient: bob, deadline: now - 10 }),
    );
    const s = contractStatus(c, alice, now, noDecisions, noEscrows, nobody);
    expect(s.canClaim).toBe(true);
  });

  it('time-lock: the recipient must wait until the unlock time', () => {
    const c = mk(
      timeLock({ sender: alice, recipient: bob, unlock: now + 3600 }),
    );
    const s = contractStatus(c, bob, now, noDecisions, noEscrows, bobOwns);
    expect(s.canClaim).toBe(false);
    expect(s.waiting.length).toBe(1);
    const after = contractStatus(
      c,
      bob,
      now + 4000,
      noDecisions,
      noEscrows,
      bobOwns,
    );
    expect(after.canClaim).toBe(true);
  });

  it('escrow: the recipient claims once the arbiter releases, and a missing register makes it broken', () => {
    const ids = [{ arbiter: carol, id: 'order42' }];
    const c = mk(
      escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42' }),
    );

    const released = new Map<string, DecisionState>([
      [decisionKey(carol, 'order42'), { exists: true, owner: carol, value: 1 }],
    ]);
    expect(contractStatus(c, bob, now, released, ids, bobOwns).canClaim).toBe(
      true,
    );

    const noDecisionYet = new Map<string, DecisionState>([
      [decisionKey(carol, 'order42'), { exists: true, owner: carol, value: 0 }],
    ]);
    const open = contractStatus(c, bob, now, noDecisionYet, ids, bobOwns);
    expect(open.canClaim).toBe(false);
    expect(open.broken).toBe(false);

    const missing = new Map<string, DecisionState>([
      [decisionKey(carol, 'order42'), { exists: false }],
    ]);
    const s = contractStatus(c, bob, now, missing, ids, bobOwns);
    expect(s.broken).toBe(true);
    expect(s.canClaim).toBe(false);
  });

  it('release with a code: the recipient is told a code is needed, not that it is claimable', () => {
    const c = mk(
      codeRelease({
        sender: alice,
        recipient: bob,
        hash: codeHash(newCode()),
        takeBackFrom: now + 3600,
      }),
    );
    const s = contractStatus(c, bob, now, noDecisions, noEscrows, bobOwns);
    expect(s.needsCode).toBe(true);
    expect(s.canClaim).toBe(false);
  });

  it('a finished contract (nothing left) is closed and not claimable', () => {
    const c = mk(
      returnIfUnclaimed({
        sender: alice,
        recipient: bob,
        deadline: now + 3600,
      }),
      { open: 0n },
    );
    const s = contractStatus(c, bob, now, noDecisions, noEscrows, bobOwns);
    expect(s.closed).toBe(true);
    expect(s.canClaim).toBe(false);
  });

  it('someone who is neither the recipient-account owner nor the sender cannot claim', () => {
    const c = mk(
      returnIfUnclaimed({
        sender: alice,
        recipient: bob,
        deadline: now + 3600,
      }),
    );
    const s = contractStatus(c, carol, now, noDecisions, noEscrows, nobody);
    expect(s.canClaim).toBe(false);
  });
});
