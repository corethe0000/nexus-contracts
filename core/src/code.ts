//"Release with a code": the recipient can claim once they know a code the sender gives them; after a date the
//sender can take it back. The contract holds only sk256(secret); to claim, the recipient writes the secret into
//its own code box (a local name "nxcode", separate from the DEX reveal slot) and credits. The box must exist before
//the payment is sent: a condition that reads a missing register fails every way, the take back too.
import { memoryOfHex, namedAddress, sk256 } from '../../../wallet/src/lib/tritium';
import { and, compare, or, register, source, u256, u64, type Condition } from './condition/ast';

const addrName = 0xd9;
export const codeBoxName = 'nxcode';
export const codeBoxField = 'address';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; //no 0/O, 1/I: read aloud or typed from paper

/** A new code: 16 characters (80 bits), shown in groups of four */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => alphabet[b % 32]!).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** Upper case, without spaces and dashes, so a code typed a little differently still matches */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/** The 32 bytes written into the code box */
export function codeSecret(code: string): Uint8Array {
  const n = normalizeCode(code);
  if (n.length < 8) {
    throw new Error('the code is too short');
  }
  return sk256(new TextEncoder().encode(`nexus-contracts:${n}`));
}

/** What the contract stores: the hash of the secret */
export function codeHash(code: string): Uint8Array {
  return sk256(codeSecret(code));
}

export function codeBoxAddress(genesis: string): Uint8Array {
  return namedAddress(codeBoxName, memoryOfHex(genesis), addrName);
}

/** The two parts that check the code: the box still belongs to the recipient, and its value hashes to H */
export function codeParts(recipient: string, hash: Uint8Array): Condition[] {
  const box = codeBoxAddress(recipient);
  return [compare(register(box, 'owner'), '==', u256(memoryOfHex(recipient))), compare({ kind: 'hash', alg: 'sk256', of: register(box, { value: codeBoxField }) }, '==', u256(hash))];
}

export interface CodeRelease {
  sender: string;
  recipient: string;
  hash: Uint8Array; //codeHash(code)
  takeBackFrom: number; //the sender can take it back from this time on (block time), if not claimed
}

export function codeRelease(t: CodeRelease): Condition {
  if (!/^[0-9a-f]{64}$/.test(t.sender) || !/^[0-9a-f]{64}$/.test(t.recipient)) {
    throw new Error('sender and recipient must be genesis ids');
  }
  if (t.hash.length !== 32) {
    throw new Error('the code hash must be 32 bytes');
  }
  return or(
    and(compare(source('caller.genesis'), '==', u256(memoryOfHex(t.recipient))), ...codeParts(t.recipient, t.hash)),
    and(compare(source('caller.genesis'), '==', u256(memoryOfHex(t.sender))), compare(source('ledger.timestamp'), '>=', u64(t.takeBackFrom))),
  );
}
