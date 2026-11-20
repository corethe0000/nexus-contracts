import { describe, expect, it, beforeEach } from 'vitest';
import {
  walletGenesis,
  setWalletGenesis,
  onWalletGenesis,
  watchWallet,
} from './walletUser';

beforeEach(() => setWalletGenesis(null));

describe('walletUser', () => {
  it('lower-cases and stores the genesis', () => {
    setWalletGenesis('ABCDEF');
    expect(walletGenesis()).toBe('abcdef');
  });

  it('treats null and undefined as nobody logged in', () => {
    setWalletGenesis('abc');
    setWalletGenesis(undefined);
    expect(walletGenesis()).toBeNull();
    setWalletGenesis('abc');
    setWalletGenesis(null);
    expect(walletGenesis()).toBeNull();
  });

  it('notifies listeners only on a real change, and stops after unsubscribe', () => {
    const seen: (string | null)[] = [];
    const off = onWalletGenesis((g) => seen.push(g));
    setWalletGenesis('aa');
    setWalletGenesis('aa'); // same value, no notify
    setWalletGenesis('bb');
    off();
    setWalletGenesis('cc'); // after unsubscribe, not seen
    expect(seen).toEqual(['aa', 'bb']);
  });

  it('watchWallet forwards the logged-in user and handles logout', () => {
    let cb: ((d: unknown) => void) | undefined;
    watchWallet({ onWalletDataUpdated: (f) => (cb = f) });
    cb!({ userStatus: { genesis: 'DD' } });
    expect(walletGenesis()).toBe('dd');
    cb!({ userStatus: null }); // logout
    expect(walletGenesis()).toBeNull();
  });

  it('watchWallet ignores an update that carries no userStatus (e.g. only settings changed)', () => {
    let cb: ((d: unknown) => void) | undefined;
    watchWallet({ onWalletDataUpdated: (f) => (cb = f) });
    cb!({ userStatus: { genesis: 'EE' } });
    cb!({ settings: { locale: 'fr' } }); // no userStatus key, must not reset the user
    expect(walletGenesis()).toBe('ee');
  });
});
