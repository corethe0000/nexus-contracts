import { describe, expect, it } from 'vitest';
import { pickFeePayer } from './fee';
import type { NexusAccount } from '../../../../dex/app/src/lib/nexus';

const acc = (
  address: string,
  token: string,
  balance: bigint,
): NexusAccount => ({
  address,
  name: address,
  token,
  ticker: token === '0' ? 'NXS' : 'TKN',
  decimals: token === '0' ? 6 : 2,
  balance,
});

const nxs = (a: string, b: bigint) => acc(a, '0', b);
const fee = 13056n; // a real escrow claim fee (base units)
const open = 300000n; // 0.3 NXS being claimed

describe('pickFeePayer', () => {
  it('no payer when there is no fee', () => {
    expect(
      pickFeePayer([nxs('A', 0n)], '0', 'A', 0n, open, 0n),
    ).toBeUndefined();
  });

  it('uses an NXS account that already holds the fee', () => {
    const accounts = [nxs('spending', 5_000_000n)];
    expect(pickFeePayer(accounts, '0', 'into', 0n, open, fee)).toBe('spending');
  });

  it('pays from the claimed amount when no account holds the fee yet (first claim, no NXS)', () => {
    // recipient owns only the destination account with 0 balance; the claim brings in 0.3 NXS
    expect(pickFeePayer([nxs('into', 0n)], '0', 'into', 0n, open, fee)).toBe(
      'into',
    );
  });

  it('refuses when even the claimed amount cannot cover the fee', () => {
    expect(
      pickFeePayer([nxs('into', 0n)], '0', 'into', 0n, fee - 1n, fee),
    ).toBeUndefined();
  });

  it('a non-NXS contract cannot pay the NXS fee from the claimed token', () => {
    // into is a token account; claiming the token does not provide NXS for the fee
    expect(
      pickFeePayer(
        [acc('into', 'TOKENADDR', 0n)],
        'TOKENADDR',
        'into',
        0n,
        open,
        fee,
      ),
    ).toBeUndefined();
  });

  it('a non-NXS contract uses a separate funded NXS account', () => {
    const accounts = [acc('into', 'TOKENADDR', 0n), nxs('gas', 1_000_000n)];
    expect(pickFeePayer(accounts, 'TOKENADDR', 'into', 0n, open, fee)).toBe(
      'gas',
    );
  });

  it('does not treat a token register account (address === token) as a payer', () => {
    // guards against an NXS "account" whose address equals the token id
    const accounts = [acc('0', '0', 5_000_000n)];
    expect(pickFeePayer(accounts, '0', 'into', 0n, open, fee)).toBe('into');
  });
});
