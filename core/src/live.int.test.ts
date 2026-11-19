//The three templates on the private chain (nexus-dev, nexus-private on 7080), about 6 minutes:
//NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/live.int.test.ts
//Profiles alice, bob (DEX test users) and arbiter (arbiterpass1 / 5555) must exist there.
import { describe, expect, it } from 'vitest';
import { addressOfMemory, creditContract, debitContract, nameContract, nameWriteContract, type AccountState } from '../../../wallet/src/lib/tritium';
import { parseSlot } from '../../../wallet/src/lib/htlc';
import { NexusNode, type Credentials } from '../../../dex/core/src/nexus/node';
import { encode } from './condition/encode';
import { decision, decisionAddress, decisionName, decisionValue, escrow, returnIfUnclaimed, timeLock } from './templates';
import type { Condition } from './condition/ast';

const url = process.env.NEXUS_NODE;
type User = Credentials & { account?: string };
const alice: User = { username: 'alice', password: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' };
const bob: User = { username: 'bob', password: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' };
const arbiter: User & { genesis: string } = { username: 'arbiter', password: 'arbiterpass1', pin: '5555', genesis: 'b78ba39bf7d23fb4aca32e4717ec5346a9a42f947da06d8d9bd32b196c05c112' };
const amount = 2n;
const short = 150;

const outcome = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e) => String(e.message));
const sleepUntil = async (t: number) => {
  const ms = (t + 5 - Math.floor(Date.now() / 1000)) * 1000;
  if (ms > 0) {
    await new Promise((r) => setTimeout(r, ms));
  }
};

describe.skipIf(!url)('contract templates on chain', () => {
  const node = new NexusNode(url!);

  it('return if unclaimed, time-lock and escrow claim only as their conditions say', async () => {
    const a0 = await node.accountState(alice.account!);
    const b0 = await node.accountState(bob.account!);
    const A = a0.owner;
    const B = b0.owner;
    const R = arbiter.genesis;
    const run = Math.random().toString(36).slice(2, 8);
    const ids = { release: `r${run}`, refund: `f${run}`, open: `o${run}` };

    //the arbiter's decision registers must exist before the lock: a condition that reads a missing register fails
    const names = await node.submit(arbiter, R, (ts) => Object.values(ids).map((id) => nameContract(R, decisionName(id), new Uint8Array(32), false, ts)));
    await node.waitConfirmed(names);
    console.log('decision registers', names);

    const now = Math.max(Math.floor(Date.now() / 1000), (await node.tip()).timestamp);
    const conditions: Condition[] = [
      returnIfUnclaimed({ sender: A, recipient: B, deadline: now + 3600 }), //0 bob claims in time
      returnIfUnclaimed({ sender: A, recipient: B, deadline: now + short }), //1 unclaimed, alice takes it back
      timeLock({ sender: A, recipient: B, unlock: now + short }), //2 bob claims after unlock
      timeLock({ sender: A, recipient: B, unlock: now + 3600, cancelable: true }), //3 alice cancels before unlock
      escrow({ sender: A, recipient: B, arbiter: R, id: ids.release }), //4 arbiter releases to bob
      escrow({ sender: A, recipient: B, arbiter: R, id: ids.refund }), //5 arbiter refunds alice
      escrow({ sender: A, recipient: B, arbiter: R, id: ids.open, fallback: now + short }), //6 no decision, fallback
    ];
    const lockTx = await node.submit(alice, A, (ts) => {
      let state: AccountState = a0;
      return conditions.map((c) => {
        const out = debitContract({ from: { address: alice.account!, state }, to: bob.account!, amount, condition: encode(c) }, ts);
        state = { ...state, balance: state.balance - amount, modified: ts };
        return out;
      });
    });
    await node.waitConfirmed(lockTx);
    console.log('lock', lockTx);

    const claim = async (contract: number) => {
      const b = await node.accountState(bob.account!);
      return node.submit(bob, B, (ts) => [credit(lockTx, contract, bob.account!, b, alice.account!, ts)]);
    };
    const takeBack = async (contract: number) => {
      const a = await node.accountState(alice.account!);
      return node.submit(alice, A, (ts) => [credit(lockTx, contract, alice.account!, a, alice.account!, ts)]);
    };
    const decide = async (id: string, d: number) => {
      const reg = decisionAddress(R, id);
      const slot = parseSlot(await node.call('register/get/any', { address: addressOfMemory(reg) }));
      const tx = await node.submit(arbiter, R, (ts) => [nameWriteContract(R, decisionName(id), { created: slot.created, modified: slot.modified, address: slot.value }, decisionValue(d), ts)]);
      await node.waitConfirmed(tx);
    };
    const results: Record<string, string> = {};
    const check = async (label: string, p: Promise<unknown>, accepted: boolean) => {
      const r = await outcome(p.then((tx) => node.waitConfirmed(tx as string)));
      results[label] = r;
      console.log(`${label}: ${r}`);
      if (accepted) {
        expect(r, label).toBe('ACCEPTED');
      } else {
        expect(r, label).not.toBe('ACCEPTED');
      }
    };

    //before any deadline
    await check('0 return-if-unclaimed: alice takes back early', takeBack(0), false);
    await check('0 return-if-unclaimed: bob claims in time', claim(0), true);
    await check('1 return-if-unclaimed: alice takes back before deadline', takeBack(1), false);
    await check('2 time-lock: bob claims before unlock', claim(2), false);
    await check('3 time-lock cancelable: bob claims before unlock', claim(3), false);
    await check('3 time-lock cancelable: alice cancels before unlock', takeBack(3), true);
    await check('4 escrow: bob claims with no decision', claim(4), false);
    await decide(ids.release, decision.release);
    await check('4 escrow released: alice takes back', takeBack(4), false);
    await check('4 escrow released: bob claims', claim(4), true);
    await decide(ids.refund, decision.refund);
    await check('5 escrow refunded: bob claims', claim(5), false);
    await check('5 escrow refunded: alice takes back', takeBack(5), true);
    await check('6 escrow open: alice takes back before fallback', takeBack(6), false);

    //after the short deadlines (block time)
    //a private chain makes a block only when a transaction comes, and the condition reads the best block's time:
    //the arbiter registers one more name after the deadline so a new block carries a later time
    await sleepUntil(now + short);
    if ((await node.tip()).timestamp < now + short) {
      await node.waitConfirmed(await node.submit(arbiter, R, (ts) => [nameContract(R, decisionName(`n${run}`), new Uint8Array(32), false, ts)]));
    }
    expect((await node.tip()).timestamp).toBeGreaterThanOrEqual(now + short);
    await check('1 return-if-unclaimed: bob claims after deadline', claim(1), false);
    await check('1 return-if-unclaimed: alice takes back after deadline', takeBack(1), true);
    await check('2 time-lock: bob claims after unlock', claim(2), true);
    await check('6 escrow open: bob claims after fallback', claim(6), false);
    await check('6 escrow open: alice takes back after fallback', takeBack(6), true);

    //every contract ended where its case said: bob got 0, 2, 4; alice got 1, 3, 5, 6 back
    const a1 = await node.accountState(alice.account!);
    const b1 = await node.accountState(bob.account!);
    expect(b1.balance - b0.balance).toBe(3n * amount);
    expect(a0.balance - a1.balance).toBe(3n * amount);
    console.log(JSON.stringify(results, null, 1));
  }, 1200000);
});

//CREDIT of one lock contract into an account (the sender's own account = take back, core AddVoid form)
function credit(lockTxid: string, contract: number, to: string, state: AccountState, from: string, ts: number): Uint8Array {
  return creditContract({ debitTxid: lockTxid, contract, to: { address: to, state }, from, amount }, ts);
}
