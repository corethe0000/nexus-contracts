//Approvals by several people (2 of 3) on the private chain (nexus-dev, nexus-private on 7080), about 4 minutes:
//NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/live-approvals.int.test.ts
//Profiles: alice, bob, arbiter (arbiterpass1 / 5555), approver1 and approver2 (<name>pass / 6666).
import { describe, expect, it } from 'vitest';
import { addressOfMemory, creditContract, debitContract, nameContract, nameWriteContract, type AccountState } from '../../../wallet/src/lib/tritium';
import { parseSlot } from '../../../wallet/src/lib/htlc';
import { findGenesis } from '../../../wallet/src/lib/profile-chain';
import { NexusNode, type Credentials } from '../../../dex/core/src/nexus/node';
import { encode } from './condition/encode';
import { approvals, decision, decisionAddress, decisionName, decisionValue } from './templates';

const url = process.env.NEXUS_NODE;
type User = Credentials & { account?: string; genesis?: string };
const alice: User = { username: 'alice', password: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' };
const bob: User = { username: 'bob', password: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' };
const approvers: User[] = [
  { username: 'arbiter', password: 'arbiterpass1', pin: '5555' },
  { username: 'approver1', password: 'approver1pass', pin: '6666' },
  { username: 'approver2', password: 'approver2pass', pin: '6666' },
];
const amount = 2n;
const outcome = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e) => String(e.message).replace(/.*REJECTED: /, ''));

describe.skipIf(!url)('approvals by several people on chain', () => {
  const node = new NexusNode(url!);

  it('2 of 3: one approval is not enough, two release; two refusals refund', async () => {
    for (const a of approvers) {
      a.genesis = (await findGenesis((m, p) => node.call(m, p), a.username, true)).genesis;
    }
    const a0 = await node.accountState(alice.account!);
    const b0 = await node.accountState(bob.account!);
    const A = a0.owner;
    const B = b0.owner;
    const run = Math.random().toString(36).slice(2, 8);
    const ids = { release: `ar${run}`, refund: `af${run}` };

    //each approver's decision registers first: a condition that reads a missing register fails every way
    await Promise.all(approvers.map((a) => node.submit(a, a.genesis!, (ts) => Object.values(ids).map((id) => nameContract(a.genesis!, decisionName(id), new Uint8Array(32), false, ts))).then((tx) => node.waitConfirmed(tx))));

    const g = approvers.map((a) => a.genesis!);
    const conds = [approvals({ sender: A, recipient: B, approvers: g, required: 2, id: ids.release }), approvals({ sender: A, recipient: B, approvers: g, required: 2, id: ids.refund })];
    const lockTx = await node.submit(alice, A, (ts) => {
      let state: AccountState = a0;
      return conds.map((c) => {
        const out = debitContract({ from: { address: alice.account!, state }, to: bob.account!, amount, condition: encode(c) }, ts);
        state = { ...state, balance: state.balance - amount, modified: ts };
        return out;
      });
    });
    await node.waitConfirmed(lockTx);
    console.log('lock', lockTx, 'condition bytes', encode(conds[0]!).length);

    const credit = async (who: User, contract: number, into: string) => {
      const st = await node.accountState(into);
      return node.submit(who, (await node.accountState(into)).owner, (ts) => [creditContract({ debitTxid: lockTx, contract, to: { address: into, state: st }, from: alice.account!, amount }, ts)]).then((tx) => node.waitConfirmed(tx));
    };
    const decide = async (a: User, id: string, d: number) => {
      const slot = parseSlot(await node.call('register/get/any', { address: addressOfMemory(decisionAddress(a.genesis!, id)) }));
      return node.submit(a, a.genesis!, (ts) => [nameWriteContract(a.genesis!, decisionName(id), { created: slot.created, modified: slot.modified, address: slot.value }, decisionValue(d), ts)]).then((tx) => node.waitConfirmed(tx));
    };
    const results: Record<string, string> = {};
    const check = async (label: string, p: Promise<unknown>, accepted: boolean) => {
      const r = await outcome(p);
      results[label] = r;
      console.log(`${label}: ${r}`);
      expect(r === 'ACCEPTED', label).toBe(accepted);
    };

    //contract 0: release needs two
    await decide(approvers[0]!, ids.release, decision.release);
    await check('one release: bob claims', credit(bob, 0, bob.account!), false);
    await decide(approvers[2]!, ids.release, decision.release);
    await check('two releases: alice takes back', credit(alice, 0, alice.account!), false);
    await check('two releases: bob claims', credit(bob, 0, bob.account!), true);

    //contract 1: one refund and one release decide nothing; a second refund does
    await decide(approvers[0]!, ids.refund, decision.refund);
    await decide(approvers[1]!, ids.refund, decision.release);
    await check('one refund, one release: alice takes back', credit(alice, 1, alice.account!), false);
    await check('one refund, one release: bob claims', credit(bob, 1, bob.account!), false);
    await decide(approvers[2]!, ids.refund, decision.refund);
    await check('two refunds: bob claims', credit(bob, 1, bob.account!), false);
    await check('two refunds: alice takes back', credit(alice, 1, alice.account!), true);

    expect((await node.accountState(bob.account!)).balance - b0.balance).toBe(amount);
    expect(a0.balance - (await node.accountState(alice.account!)).balance).toBe(amount);
    console.log(JSON.stringify(results, null, 1));
  }, 1200000);
});
