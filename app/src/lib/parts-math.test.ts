import { describe, expect, it } from 'vitest';
import { nthDate, splitAmount } from './parts-math';

describe('splitAmount', () => {
  it('splits exactly, remainder on the last part, and always sums to the total', () => {
    expect(splitAmount(10n, 3)).toEqual([3n, 3n, 4n]);
    expect(splitAmount(9n, 3)).toEqual([3n, 3n, 3n]);
    expect(splitAmount(5n, 4)).toEqual([1n, 1n, 1n, 2n]);
    expect(splitAmount(100n, 1)).toEqual([100n]);
    for (const [total, n] of [
      [1000003n, 7],
      [2n, 2],
      [999n, 10],
    ] as const) {
      const parts = splitAmount(total, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });
});

describe('nthDate', () => {
  const t0 = 1_700_000_000;

  it('adds whole days and weeks', () => {
    expect(nthDate(t0, 'day', 0)).toBe(t0);
    expect(nthDate(t0, 'day', 3)).toBe(t0 + 3 * 86400);
    expect(nthDate(t0, 'week', 2)).toBe(t0 + 14 * 86400);
  });

  it('adds whole calendar months and clamps the 31st to a short month', () => {
    const jan31 = Math.floor(new Date(2025, 0, 31, 10, 30).getTime() / 1000);
    const feb = new Date(nthDate(jan31, 'month', 1) * 1000);
    expect([feb.getFullYear(), feb.getMonth(), feb.getDate()]).toEqual([
      2025, 1, 28,
    ]); // Feb 28, not leap
    expect([feb.getHours(), feb.getMinutes()]).toEqual([10, 30]);
    // the original day is re-derived from the start each time, so two months on is Mar 31
    const mar = new Date(nthDate(jan31, 'month', 2) * 1000);
    expect([mar.getMonth(), mar.getDate()]).toEqual([2, 31]);
  });

  it('clamps to Feb 29 in a leap year', () => {
    const jan31leap = Math.floor(new Date(2024, 0, 31, 9, 0).getTime() / 1000);
    const feb = new Date(nthDate(jan31leap, 'month', 1) * 1000);
    expect([feb.getMonth(), feb.getDate()]).toEqual([1, 29]);
  });
});
