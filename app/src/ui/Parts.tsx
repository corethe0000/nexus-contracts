//Vesting and milestones: one payment split into parts, each a contract of its own, all sent in one transaction.
//Vesting: part n can be claimed from its date (the sender may cancel parts not yet due). Milestones: each part is
//released with its own code; parts not released come back to the sender from one date.
import { useEffect, useMemo, useState } from 'react';
import { codeHash, codeRelease, describe, encode, newCode, timeLock, type Condition } from '@nexus-contracts/core/src';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { accountFor, codeBoxState, feeForCondition, reloadAccounts, sendContracts, type Person, type Session } from '../lib/chain';
import { saveCode } from '../lib/codes';
import { t } from '../lib/i18n';
import { shareText } from '../lib/share';
import { fmtTime } from '../lib/status';
import { nthDate, splitAmount, type Every } from '../lib/parts-math';
import { copyText, errorText, formatAmount, inDays, parseAmount, shortId, TimeInput } from './common';

export type PartsKind = 'vesting' | 'milestones';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');


export function Parts(props: { node: NexusNode; session: Session; kind: PartsKind; recipient: Person | null; labels: Record<string, string>; onSent: () => void }) {
  const { node, session, kind, recipient } = props;
  const [count, setCount] = useState(kind === 'vesting' ? 4 : 3);
  const [start, setStart] = useState(() => inDays(30));
  const [every, setEvery] = useState<Every>('month');
  const [cancelable, setCancelable] = useState(true);
  const [backFrom, setBackFrom] = useState(() => inDays(90));
  const [codes, setCodes] = useState<string[]>(() => Array.from({ length: 12 }, () => newCode()));
  const [from, setFrom] = useState('');
  const [totalText, setTotalText] = useState('');
  const [payTo, setPayTo] = useState('');
  const [looking, setLooking] = useState(false);
  const [box, setBox] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: string; error?: string }>({});

  const fromAccount = session.accounts.find((a) => a.address === from);
  useEffect(() => {
    if (!from && session.accounts.length) {
      setFrom((session.accounts.find((a) => a.token === '0' && a.address !== a.token) ?? session.accounts[0]!).address);
    }
  }, [session.accounts, from]);

  //the recipient's account in the paying token, and for milestones whether they have a code box
  useEffect(() => {
    let live = true;
    setPayTo('');
    if (!recipient || !fromAccount) {
      setLooking(false);
      return;
    }
    setLooking(true);
    accountFor(node, recipient, fromAccount.token)
      .then((a) => live && setPayTo(a ?? ''))
      .finally(() => live && setLooking(false));
    if (kind === 'milestones') {
      codeBoxState(node, recipient.genesis)
        .then((b) => live && setBox(b.exists))
        .catch(() => live && setBox(null));
    }
    return () => {
      live = false;
    };
  }, [recipient, fromAccount?.token, kind, node]);

  const total = fromAccount ? parseAmount(totalText, fromAccount.decimals) : null;
  const amounts = total && total >= BigInt(count) ? splitAmount(total, count) : [];

  const parts = useMemo((): { amount: bigint; condition: Condition; when?: number; code?: string }[] => {
    if (!recipient || !amounts.length) {
      return [];
    }
    return amounts.map((amount, i) => {
      if (kind === 'vesting') {
        const when = nthDate(start, every, i);
        return { amount, when, condition: timeLock({ sender: session.genesis, recipient: recipient.genesis, unlock: when, cancelable }) };
      }
      const code = codes[i]!;
      return { amount, code, condition: codeRelease({ sender: session.genesis, recipient: recipient.genesis, hash: codeHash(code), takeBackFrom: backFrom }) };
    });
  }, [recipient, amounts.join(','), kind, start, every, cancelable, codes, backFrom, session.genesis]);

  const todo: string[] = [];
  const problems: string[] = [];
  if (!recipient) {
    todo.push(t('Pick who gets the payment'));
  } else if (recipient.genesis === session.genesis) {
    problems.push(t('The recipient is you'));
  }
  if (!fromAccount) {
    todo.push(t('Pick the account that pays'));
  }
  if (total === null || total === 0n) {
    todo.push(t('Enter the amount'));
  } else if (fromAccount && total > fromAccount.balance) {
    problems.push(t('The amount is more than the account holds'));
  } else if (total < BigInt(count)) {
    problems.push(t('The amount is too small for that many parts'));
  }
  if (looking) {
    todo.push(t("Looking for the recipient's account in this token..."));
  } else if (recipient && !payTo) {
    problems.push(t('{who} has no account in this token', { who: props.labels[recipient.genesis] ?? shortId(recipient.genesis) }));
  }
  if (kind === 'milestones' && recipient && box === false) {
    problems.push(t('{name} has no code box yet. They set it up once in My contracts ("Set up code box"); before that the chain would refuse every claim, the take back too.', { name: props.labels[recipient.genesis] ?? shortId(recipient.genesis) }));
  }
  if (kind === 'vesting' && start <= Math.floor(Date.now() / 1000)) {
    problems.push(t('The first part would be claimable at once: pick a later first date'));
  }
  if (kind === 'milestones' && backFrom <= Math.floor(Date.now() / 1000)) {
    problems.push(t('The take back date is already past'));
  }
  const fee = parts.length ? feeForCondition(session.net, parts[0]!.condition) : 0n;
  const ticker = fromAccount?.ticker ?? 'NXS';

  const send = async () => {
    if (!fromAccount || !parts.length) {
      return;
    }
    setBusy(true);
    setResult({});
    try {
      const txid = await sendContracts(node, session, { from: fromAccount.address, to: payTo, parts: parts.map((p) => ({ amount: p.amount, condition: encode(p.condition) })) });
      for (const p of parts) {
        if (p.code) {
          saveCode(session.genesis, hex(codeHash(p.code)), p.code);
        }
      }
      setResult({ ok: txid });
      setConfirm(false);
      await reloadAccounts(node, session).catch(() => undefined);
    } catch (e) {
      setResult({ error: errorText(e) });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const words = (c: Condition) => describe(c, { labels: props.labels, sender: session.genesis, me: session.genesis, time: fmtTime, t });

  return (
    <div className="grid2">
      <section className="card">
        <h2>
          <span className="step">2</span>
          {kind === 'vesting' ? t('Parts and dates') : t('Parts and codes')}
        </h2>
        <label className="field">
          <span>{t('Number of parts')}</span>
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {kind === 'vesting' ? (
          <>
            <label className="field">
              <span>{t('First part from')}</span>
              <TimeInput value={start} onChange={setStart} />
            </label>
            <label className="field">
              <span>{t('Then one part every')}</span>
              <select value={every} onChange={(e) => setEvery(e.target.value as Every)}>
                <option value="day">{t('day')}</option>
                <option value="week">{t('week')}</option>
                <option value="month">{t('month')}</option>
              </select>
            </label>
            <label className="row field">
              <input type="checkbox" checked={cancelable} onChange={(e) => setCancelable(e.target.checked)} />
              <span style={{ fontSize: 13, color: 'var(--ink)' }}>{t('You can take back parts that are not due yet')}</span>
            </label>
          </>
        ) : (
          <label className="field">
            <span>{t('Parts not released come back to you from')}</span>
            <TimeInput value={backFrom} onChange={setBackFrom} />
            <span className="hint">{t('Each part has its own code. Give a part\'s code when that part of the work is done.')}</span>
          </label>
        )}
        <label className="field">
          <span>{t('From your account')}</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {session.accounts.map((a) => (
              <option key={a.address} value={a.address}>
                {a.name ?? shortId(a.address)} ({formatAmount(a.balance, a.decimals)} {a.ticker})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('Total amount ({ticker})', { ticker })}</span>
          <input value={totalText} onChange={(e) => setTotalText(e.target.value)} inputMode="decimal" placeholder="0.00" />
          <span className="hint">{t('Split in equal parts; the last part takes what does not divide evenly.')}</span>
        </label>
      </section>

      <section className="card">
        <h2>
          <span className="step">3</span>
          {t('Review')}
        </h2>
        {parts.length > 0 && (
          <ul className="words">
            {parts.map((p, i) => (
              <li key={i}>
                <b>{i + 1}</b>
                {formatAmount(p.amount, fromAccount!.decimals)} {ticker}: {words(p.condition).join('; ')}
                {p.code && (
                  <span className="row" style={{ marginTop: 4 }}>
                    <span className="muted">{t('Code')}:</span> <b style={{ fontFamily: 'var(--mono)' }}>{p.code}</b>
                    <button className="small" onClick={() => copyText(p.code!)}>
                      {t('Copy')}
                    </button>
                    <button className="small" onClick={() => setCodes((cs) => cs.map((c, j) => (j === i ? newCode() : c)))}>
                      {t('New code')}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="stack spaced" style={{ gap: 8 }}>
          {todo.length > 0 && (
            <div className="note">
              <b>{t('Still needed')}</b>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {todo.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {problems.map((p, i) => (
            <div key={i} className="note bad">
              {p}
            </div>
          ))}
          {fee > 0n && <div className="note">{t('Each claim pays a network fee of about {fee} NXS (rules that read registers cost more than the free limit).', { fee: formatAmount(fee, 6) })}</div>}
        </div>
        {result.error && <div className="note bad spaced">{result.error}</div>}
        {result.ok && (
          <div className="note good spaced">
            {t('Sent. Transaction {id}', { id: shortId(result.ok) })}{' '}
            <button className="link" onClick={() => copyText(shareText(result.ok!))}>
              {t('copy a message for the recipient')}
            </button>{' '}
            <button className="link" onClick={props.onSent}>
              {t('see My contracts')}
            </button>
          </div>
        )}
        <div className="row spaced">
          <button className="primary" disabled={!parts.length || todo.length > 0 || problems.length > 0 || busy || !!result.ok} onClick={() => setConfirm(true)}>
            {t('Review and send')}
          </button>
        </div>
      </section>

      {confirm && fromAccount && total && (
        <div className="modal-back" role="dialog" aria-modal="true">
          <div className="card modal">
            <h2>{t('Send these parts?')}</h2>
            <p>
              {t('{amount} {ticker} leaves {account} in {n} parts, each locked by its own rules.', { amount: formatAmount(total, fromAccount.decimals), ticker, account: fromAccount.name ?? shortId(fromAccount.address), n: parts.length })}
            </p>
            {kind === 'milestones' && <div className="note warn">{t('Keep the codes safe. You give each one when you want to release that part. This module also keeps them on this computer under My contracts.')}</div>}
            <div className="row spaced">
              <button className="primary" onClick={send} disabled={busy}>
                {busy ? t('Signing and sending...') : t('Sign and send')}
              </button>
              <button onClick={() => setConfirm(false)} disabled={busy}>
                {t('Back')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
