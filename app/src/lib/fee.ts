import type { NexusAccount } from '../../../../dex/app/src/lib/nexus';

/**
 * Who pays a claim's network fee: an NXS account that already holds it, or the account being claimed into when the
 * claim itself brings in enough NXS. The second case lets a recipient claim their first NXS payment without already
 * owning NXS (the fee comes out of the amount claimed, in the same transaction). Returns undefined when no fee is
 * due, or when nobody can pay it (a non-NXS contract always needs a separate NXS account, since the fee is in NXS).
 */
export function pickFeePayer(
  accounts: NexusAccount[],
  contractToken: string,
  into: string,
  intoBalance: bigint,
  open: bigint,
  fee: bigint,
): string | undefined {
  if (fee <= 0n) {
    return undefined;
  }
  const funded = accounts.find(
    (a) => a.token === '0' && a.address !== a.token && a.balance >= fee,
  )?.address;
  if (funded) {
    return funded;
  }
  //the claim credits NXS into `into` in the same transaction, so the fee can come out of that
  if (contractToken === '0' && intoBalance + open >= fee) {
    return into;
  }
  return undefined;
}
