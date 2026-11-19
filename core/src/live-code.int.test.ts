//"Release with a code" on the private chain (nexus-dev, nexus-private on 7080), about 4 minutes:
//NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/live-code.int.test.ts
import { describe, expect, it } from 'vitest';
import { addressOfMemory, creditContract, debitContract, nameContract, nameWriteContract, type AccountState } from '../../../wallet/src/lib/tritium';
import { parseSlot } from '../../../wallet/src/lib/htlc';
import { NexusNode, type Credentials } from '../../../dex/core/src/nexus/node';
import { encode } from './condition/encode';
import { codeBoxAddress, codeBoxName, codeHash, codeRelease, codeSecret, newCode } from './code';
import { decisionName } from './templates';

const url = process.env.NEXUS_NODE;
type User = Credentials & { account: string };
const alice: User = { username: 'alice', password: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' };
const bob: User = { username: 'bob', password: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' };
const arbiter = { username: 'arbiter', password: 'arbiterpass1', pin: '5555', genesis: 'b78ba39bf7d23fb4aca32e4717ec5346a9a42f947da06d8d9bd32b196c05c112' };
const amount = 2n;
const short = 150;
const outcome = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e) => String(e.message).replace(/.*REJECTED: /, ''));

describe.skipIf(!url)('release with a code on chain', () => {
  const node = new NexusNode(url!);

  it('claims only with the right code, takes back after the date', async () => {
    const a0 = await node.accountState(alice.account);
    const b0 = await node.accountState(bob.account);
    const A = a0.owner;
    const B = b0.owner;
    const box = addressOfMemory(codeBoxAddress(B));
    const readBox = async () => parseSlot(await node.call('register/get/any', { address: box }));
    if (!(await node.call('register/get/any', { address: box }).catch(() => null))) {
      await node.waitConfirmed(await node.submit(bob, B, (ts) => [nameContract(B, codeBoxName, new Uint8Array(32), false, ts)]));
      console.log('created bob code box');
    }

    const codes = [newCode(), newCode()];
    const now = Math.max(Math.floor(Date.now() / 1000), (await node.tip()).timestamp);
    const conds = [codeRelease({ sender: A, recipient: B, hash: codeHash(codes[0]!), takeBackFrom: now + 3600 }), codeRelease({ sender: A, recipient: B, hash: codeHash(codes[1]!), takeBackFrom: now + short })];
    const lockTx = await node.submit(alice, A, (ts) => {
      let state: AccountState = a0;
      return conds.map((c) => {
        const out = debitContract({ from: { address: alice.account, state }, to: bob.account, amount, condition: encode(c) }, ts);
        state = { ...state, balance: state.balance - amount, modified: ts };
        return out;
      });
    });
    await node.waitConfirmed(lockTx);
    console.log('lock', lockTx);

    const credit = (who: User, g: string, contract: number, into: string, state: AccountState, ts: number) => creditContract({ debitTxid: lockTx, contract, to: { address: into, state }, from: alice.account, amount }, ts);
    //write a code into bob's box and claim, in one transaction
    const writeAndClaim = async (code: string, contract: number) => {
      const slot = await readBox();
      const b = await node.accountState(bob.account);
      return node.submit(bob, B, (ts) => [nameWriteContract(B, codeBoxName, { created: slot.created, modified: slot.modified, address: slot.value }, codeSecret(code), ts), credit(bob, B, contract, bob.account, b, ts)]).then((tx) => node.waitConfirmed(tx));
    };
    const results: Record<string, string> = {};
    const check = async (label: string, p: Promise<unknown>, accepted: boolean) => {
      const r = await outcome(p);
      results[label] = r;
      console.log(`${label}: ${r}`);
      if (accepted) {
        expect(r, label).toBe('ACCEPTED');
      } else {
        expect(r, label).not.toBe('ACCEPTED');
      }
    };

    await check('bob claims with a wrong code', writeAndClaim(newCode(), 0), false);
    const aNow = await node.accountState(alice.account);
    await check('alice takes back before the date', node.submit(alice, A, (ts) => [credit(alice, A, 0, alice.account, aNow, ts)]).then((tx) => node.waitConfirmed(tx)), false);
    const one = await outcome(writeAndClaim(codes[0]!, 0));
    console.log('bob writes the right code and claims in one transaction:', one);
    if (one !== 'ACCEPTED') {
      //two steps: write, then claim once it is in a block
      const slot = await readBox();
      await node.waitConfirmed(await node.submit(bob, B, (ts) => [nameWriteContract(B, codeBoxName, { created: slot.created, modified: slot.modified, address: slot.value }, codeSecret(codes[0]!), ts)]));
      const b = await node.accountState(bob.account);
      await check('bob claims after writing the code', node.submit(bob, B, (ts) => [credit(bob, B, 0, bob.account, b, ts)]).then((tx) => node.waitConfirmed(tx)), true);
    }
    results['right code, one transaction'] = one;

    //contract 1: never claimed (bob's box holds code 0), alice takes it back after the date
    const bNow = await node.accountState(bob.account);
    await check('bob claims contract 1 with the box holding the other code', node.submit(bob, B, (ts) => [credit(bob, B, 1, bob.account, bNow, ts)]).then((tx) => node.waitConfirmed(tx)), false);
    const wait = (now + short + 5 - Math.floor(Date.now() / 1000)) * 1000;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    if ((await node.tip()).timestamp < now + short) {
      await node.waitConfirmed(await node.submit(arbiter, arbiter.genesis, (ts) => [nameContract(arbiter.genesis, decisionName(`c${Math.random().toString(36).slice(2, 8)}`), new Uint8Array(32), false, ts)]));
    }
    const a2 = await node.accountState(alice.account);
    await check('alice takes back contract 1 after the date', node.submit(alice, A, (ts) => [credit(alice, A, 1, alice.account, a2, ts)]).then((tx) => node.waitConfirmed(tx)), true);

    expect((await node.accountState(bob.account)).balance - b0.balance).toBe(amount);
    expect(a0.balance - (await node.accountState(alice.account)).balance).toBe(amount);
    console.log(JSON.stringify(results, null, 1));
  }, 1200000);
});
