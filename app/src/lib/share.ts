import { t } from './i18n';

//a contract shared as text: the receiver pastes the whole message into My contracts > Add, which finds the id in it
export const sharePrefix = 'nexus-contract:';

export function shareText(txid: string): string {
  return t('I sent you a payment with rules (a Nexus contract). In the Nexus wallet open the Nexus Contracts module, go to My contracts and paste this message into the Add box:') + ' ' + sharePrefix + txid;
}

/** The transaction id in a pasted message or a bare id, or null */
export function txidFrom(text: string): string | null {
  const m = /(?:^|[^0-9a-f])([0-9a-f]{128})(?![0-9a-f])/i.exec(text.trim());
  return m ? m[1]!.toLowerCase() : null;
}
