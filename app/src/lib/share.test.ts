import { describe, expect, it } from 'vitest';
import { shareText, sharePrefix, txidFrom } from './share';

const id = '01'.repeat(64); // 128 hex chars

describe('txidFrom', () => {
  it('reads a bare transaction id', () => {
    expect(txidFrom(id)).toBe(id);
    expect(txidFrom(`  ${id}  `)).toBe(id);
  });

  it('finds the id inside the shared message', () => {
    expect(txidFrom(shareText(id))).toBe(id);
    expect(txidFrom(`please claim ${sharePrefix}${id} thanks`)).toBe(id);
  });

  it('lower-cases the id', () => {
    expect(txidFrom(id.toUpperCase())).toBe(id);
  });

  it('returns null when there is no id', () => {
    expect(txidFrom('')).toBeNull();
    expect(txidFrom('no id here, just words')).toBeNull();
    expect(txidFrom(sharePrefix)).toBeNull();
  });

  it('rejects a too-short or too-long hex run', () => {
    expect(txidFrom('ab'.repeat(63) + 'ab'.slice(0, 1))).toBeNull(); // 127 chars
    expect(txidFrom(id + 'a')).toBeNull(); // 129 chars
    expect(txidFrom(id + id)).toBeNull(); // 256 chars, no valid 128-run boundary
  });

  it('does not pick an id out of a longer hex-like token', () => {
    // 128 hex chars glued to more hex on both sides must not match
    expect(txidFrom('f'.repeat(130))).toBeNull();
  });
});
