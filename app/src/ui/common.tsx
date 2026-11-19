import { useEffect, useRef, useState } from 'react';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { findPerson, type Person, type Session } from '../lib/chain';
import { intlLocale, t } from '../lib/i18n';

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const shortId = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}...${s.slice(-6)}` : s);

//<input type="datetime-local"> works in local time without seconds
export function toLocalInput(seconds: number): string {
  if (seconds > 8.64e12) {
    return '';
  }
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

//empty or half typed values are ignored, so backspacing one part does not wipe the time (optional times have a
//Clear button)
export function TimeInput({ value, onChange }: { value: number; onChange: (t: number) => void }) {
  return (
    <input
      type="datetime-local"
      value={value ? toLocalInput(value) : ''}
      onChange={(e) => {
        const t = fromLocalInput(e.target.value);
        if (t > 0) {
          onChange(t);
        }
      }}
    />
  );
}

/** Now plus some days, on a whole minute (the time field shows no seconds) */
export const inDays = (days: number) => Math.floor(Date.now() / 60000) * 60 + Math.round(days * 86400);

export async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

export async function pasteText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** Username or genesis id, checked against the chain when the field is left */
export function PersonInput(props: { node: NexusNode; session: Session; value: string; placeholder?: string; className?: string; onPerson: (p: Person | null, text: string) => void }) {
  const [text, setText] = useState(props.value);
  const [state, setState] = useState<{ ok?: string; error?: string; busy?: boolean }>({});
  const checked = useRef(props.value);

  //a new value from outside (another block moved here, a template) starts fresh
  useEffect(() => {
    if (props.value !== checked.current) {
      setText(props.value);
      setState({});
      checked.current = props.value;
    }
  }, [props.value]);

  const check = async () => {
    const q = text.trim();
    if (q === checked.current && !state.error) {
      return;
    }
    if (!q) {
      checked.current = '';
      setState({});
      props.onPerson(null, '');
      return;
    }
    setState({ busy: true });
    try {
      const p = await findPerson(props.node, props.session, q);
      const me = p.genesis === props.session.genesis;
      checked.current = q;
      setState({ ok: me ? t('you') : p.username ? `${p.username}` : t('user {id}', { id: shortId(p.genesis) }) });
      props.onPerson(p, q);
    } catch (e) {
      //only "no such user" clears the person; a node hiccup keeps what was there
      const notFound = /No account|username/i.test(errorText(e));
      setState({ error: notFound ? errorText(e) : t('Could not check now: {error}', { error: errorText(e) }) });
      if (notFound) {
        checked.current = q;
        props.onPerson(null, q);
      }
    }
  };

  return (
    <span className="row" style={{ flex: '1 1 220px' }}>
      <input
        className={props.className ?? 'wide'}
        value={text}
        placeholder={props.placeholder ?? t('username or genesis id')}
        onChange={(e) => setText(e.target.value)}
        onBlur={check}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
      {state.busy && <span className="muted">{t('checking...')}</span>}
      {state.ok && <span className="ok">{t('found: {name}', { name: state.ok })}</span>}
      {state.error && <span className="bad">{state.error}</span>}
    </span>
  );
}

const decimalSeparator = () => new Intl.NumberFormat(intlLocale()).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';

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
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
