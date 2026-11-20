//Amounts in base units (bigint) to and from the text a person types, in the wallet's locale.
import { intlLocale } from './i18n';

const decimalSeparator = () =>
  new Intl.NumberFormat(intlLocale())
    .formatToParts(1.5)
    .find((p) => p.type === 'decimal')?.value ?? '.';

export function formatAmount(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const whole = a / unit;
  const frac = (a % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString(intlLocale())}${frac ? `${decimalSeparator()}${frac}` : ''}`;
}

//"1.5" and "1,5" both mean one and a half; a comma with a dot too is a thousands separator ("1,000.5")
export function parseAmount(text: string, decimals: number): bigint | null {
  let t = text.trim().replace(/\s/g, '');
  t = t.includes('.') ? t.replace(/,/g, '') : t.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) {
    return null;
  }
  const [w, f = ''] = t.split('.');
  if (f.length > decimals) {
    return null;
  }
  return (
    BigInt(w!) * 10n ** BigInt(decimals) +
    BigInt(f.padEnd(decimals, '0') || '0')
  );
}
