import { test, expect } from 'vitest';
import { lockCondition, lockConditionFee } from '../../../wallet/src/lib/htlc';
import { decode, claimFee } from './index';

//guards the hardcoded fee against the core cost model: if the lock condition shape changes, this catches the drift
test('lockConditionFee equals the core cost of the swap lock condition minus the free limit', () => {
  const terms = { recipient: 'a'.repeat(64), sender: 'b'.repeat(64), hashlock: new Uint8Array(32).fill(1), deadline: 1800000000 };
  expect(claimFee(decode(lockCondition(terms as any)))).toBe(lockConditionFee);
});
