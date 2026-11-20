//the user logged in to the wallet (its genesis), passed in at the start and on every change; null = nobody logged in
type Listener = (genesis: string | null) => void;
type Utilities = { onWalletDataUpdated?: (f: (d: { userStatus?: { genesis?: string } | null }) => void) => void };

let current: string | null = null;
const listeners = new Set<Listener>();

export function walletGenesis(): string | null {
  return current;
}

export function setWalletGenesis(genesis: string | null | undefined) {
  const g = genesis ? genesis.toLowerCase() : null;
  if (g === current) {
    return;
  }
  current = g;
  listeners.forEach((f) => f(g));
}

export function onWalletGenesis(f: Listener): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function watchWallet(utilities: Utilities | undefined) {
  utilities?.onWalletDataUpdated?.((d) => {
    if (d && 'userStatus' in d) {
      setWalletGenesis(d.userStatus?.genesis ?? null);
    }
  });
}
