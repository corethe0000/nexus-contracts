import { describe, expect, it } from 'vitest';
import { parseAmount, formatAmount } from './amount';

// the default locale is 'en' (decimal dot, comma thousands)

describe('parseAmount', () => {
  it('reads a plain decimal', () => {
    expect(parseAmount('1.5', 6)).toBe(1_500_000n);
    expect(parseAmount('2', 6)).toBe(2_000_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
  });

  it('accepts a decimal comma and thousands separators', () => {
    expect(parseAmount('1,5', 6)).toBe(1_500_000n); // comma as decimal
    expect(parseAmount('1,000.5', 6)).toBe(1_000_500_000n); // comma thousands, dot decimal
    expect(parseAmount('  1 000.5 ', 6)).toBe(1_000_500_000n); // spaces ignored
  });

  it('rejects junk and too many decimal places', () => {
    for (const bad of ['', 'abc', '-1', '1.2.3', '1e3', '.5', '1.']) {
      expect(parseAmount(bad, 6)).toBeNull();
    }
    expect(parseAmount('0.0000001', 6)).toBeNull(); // 7 decimals, token has 6
  });

  it('handles a zero-decimal token', () => {
    expect(parseAmount('5', 0)).toBe(5n);
    expect(parseAmount('5.5', 0)).toBeNull();
  });
});

describe('formatAmount', () => {
  it('formats base units back to text', () => {
    expect(formatAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatAmount(1_000_000n, 6)).toBe('1');
    expect(formatAmount(0n, 6)).toBe('0');
    expect(formatAmount(-2_500_000n, 6)).toBe('-2.5');
    expect(formatAmount(1n, 6)).toBe('0.000001');
  });

  it('round-trips with parseAmount', () => {
    for (const v of [0n, 1n, 1_000_000n, 1_234_567n, 999_999_999_999n]) {
      expect(parseAmount(formatAmount(v, 6), 6)).toBe(v);
    }
  });
});
