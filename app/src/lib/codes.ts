//codes of payments this profile sent with "release with a code", kept in this browser only so the sender can give
//them later (the chain holds only their hash). Storage can be off: then the code shown at sending is the only copy.
const key = (genesis: string) => `nexus-contracts:codes:${genesis}`;

export function savedCodes(genesis: string): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(key(genesis)) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function saveCode(genesis: string, hashHex: string, code: string): boolean {
  try {
    localStorage.setItem(key(genesis), JSON.stringify({ ...savedCodes(genesis), [hashHex]: code }));
    return true;
  } catch {
    return false;
  }
}
