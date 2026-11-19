import { useCallback, useEffect, useRef, useState } from 'react';
import { codeHash, describe, print, toWays } from '@nexus-contracts/core/src';
import { savedCodes } from '../lib/codes';
import { shareText, txidFrom } from '../lib/share';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { blockTime, claim, claimWithCode, codeBoxState, createCodeBox, decisionState, discoverEscrows, incomingContracts, readContracts, reloadAccounts, sentContracts, type ChainContract, type DecisionState, type Session } from '../lib/chain';
import { contractStatus, decisionKey, escrowRefs, fmtTime, type ContractStatus } from '../lib/status';
import { copyText, errorText, formatAmount, shortId } from './common';
import { t } from '../lib/i18n';

const hexBytes = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const storeKey = (g: string) => `nexus-contracts:watch:${g}`;

function loadWatched(g: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(g)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveWatched(g: string, list: string[]) {
  try {
    localStorage.setItem(storeKey(g), JSON.stringify(list));
  } catch {
    //storage off: the list lasts until the module closes
  }
}

interface Row {
  c: ChainContract;
  status: ContractStatus;
  incoming: boolean;
}

export function MyContracts({ node, session, active, onWaiting }: { node: NexusNode; session: Session; active: boolean; onWaiting: (n: number) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [watched, setWatched] = useState(() => loadWatched(session.genesis));
  const [addText, setAddText] = useState('');
  const [acting, setActing] = useState('');
  const [done, setDone] = useState<Record<string, string>>({});
  const [now, setNow] = useState(0);
  const [showClosed, setShowClosed] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [myBox, setMyBox] = useState<boolean | null>(null);
  const [codeFor, setCodeFor] = useState('');
  const [codeText, setCodeText] = useState('');

  //one load at a time; a request during a load gets a fresh one right after it (a payment sent meanwhile must show)
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const load = useCallback((): Promise<void> => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    inFlight.current = loadNow().finally(() => {
      inFlight.current = null;
      if (again.current) {
        again.current = false;
        void load();
      }
    });
    return inFlight.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, session, watched, onWaiting]);

  const loadNow = async () => {
    setBusy(true);
    setError('');
    try {
      await reloadAccounts(node, session);
      const [incoming, sent, t] = await Promise.all([incomingContracts(node, session, watched), sentContracts(node, session), blockTime(node)]);
      //DEX swap locks belong to the DEX, payments with the core's standard expiry to the wallet
      const every = [...incoming.map((c) => ({ c, incoming: true })), ...sent.map((c) => ({ c, incoming: false }))];
      const all = every.filter((x) => x.c.kind === 'contract');
      setHidden(every.length - all.length);
      const ids = await discoverEscrows(node, all.map((x) => x.c));
      const decisions = new Map<string, DecisionState>();
      for (const r of all) {
        for (const ref of escrowRefs(r.c, ids)) {
          const k = decisionKey(ref.arbiter, ref.id);
          if (!decisions.has(k)) {
            decisions.set(k, await decisionState(node, ref.arbiter, ref.id));
          }
        }
      }
      //code boxes the contracts read: a missing one fails every way
      const boxes = new Map<string, boolean>();
      for (const r of all) {
        for (const w of r.c.condition ? toWays(r.c.condition) : []) {
          for (const b of w) {
            if (b.kind === 'secret' && !boxes.has(b.genesis)) {
              boxes.set(b.genesis, (await codeBoxState(node, b.genesis)).exists);
            }
          }
        }
      }
      setMyBox(boxes.get(session.genesis) ?? (await codeBoxState(node, session.genesis)).exists);
      const myAccounts = new Set(session.accounts.map((a) => a.address));
      //one odd contract (anyone can send one) must not take the whole list down
      const list = all.flatMap((r) => {
        try {
          return [{ ...r, status: contractStatus(r.c, session.genesis, t, decisions, ids, myAccounts, boxes) }];
        } catch {
          return [];
        }
      });
      const ready = (x: Row) => Number(x.status.canClaim || x.status.needsCode);
      list.sort((a, b) => ready(b) - ready(a) || b.c.time - a.c.time);
      setRows(list);
      setNow(t);
      onWaiting(list.filter((r) => r.status.canClaim || r.status.needsCode).length);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  //once right after sign-in too, so the count on the tab and on the wallet's Overview is there without a visit
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (active || !loadedOnce.current) {
      loadedOnce.current = true;
      void load();
    }
  }, [active, load]);

  const add = async () => {
    const id = txidFrom(addText);
    if (!id) {
      setError(t('No contract id found: paste the message the sender shared, or a 128 digit transaction id'));
      return;
    }
    try {
      const found = await readContracts(node, id);
      if (!found.length) {
        setError(t('That transaction has no contract'));
        return;
      }
    } catch (e) {
      setError(errorText(e));
      return;
    }
    const list = [...new Set([...watched, id])];
    setWatched(list);
    saveWatched(session.genesis, list);
    setAddText('');
  };

  const act = async (r: Row) => {
    const mine = new Set(session.accounts.map((a) => a.address));
    //the recipient claims into the account it was sent to; the sender takes it back into the account it came from
    const into = mine.has(r.c.to) && r.c.sender !== session.genesis ? r.c.to : mine.has(r.c.from) ? r.c.from : mine.has(r.c.to) ? r.c.to : '';
    const key = `${r.c.txid}/${r.c.contract}`;
    if (!into) {
      setDone((d) => ({ ...d, [key]: t('None of your accounts can receive it') }));
      return;
    }
    setActing(key);
    try {
      const tx = await claim(node, session, r.c, into);
      setDone((d) => ({ ...d, [key]: t('Sent (transaction {tx}), waiting for the next block...', { tx: shortId(tx) }) }));
      const ok = await node.waitConfirmed(tx, 1, 180000).then(
        () => true,
        () => false,
      );
      setDone((d) => ({ ...d, [key]: ok ? t('Done, transaction {tx} is in a block', { tx: shortId(tx) }) : t('Sent (transaction {tx}), not in a block yet: refresh in a while', { tx: shortId(tx) }) }));
      await load();
    } catch (e) {
      const m = errorText(e);
      setDone((d) => ({ ...d, [key]: /conditions not satisfied/.test(m) ? t('The chain says the rules are not met yet (it checks the time of the newest block)') : m }));
    } finally {
      setActing('');
    }
  };

  const claimCode = async (r: Row) => {
    const key = `${r.c.txid}/${r.c.contract}`;
    const secret = r.status.ways.flatMap((w) => w.way).find((b) => b.kind === 'secret');
    if (secret?.kind === 'secret' && hexBytes(codeHash(codeText)) !== secret.hash) {
      setDone((d) => ({ ...d, [key]: t('That is not the code of this payment. Check it with the sender.') }));
      return;
    }
    setActing(key);
    try {
      const tx = await claimWithCode(node, session, r.c, codeText, (text) => setDone((d) => ({ ...d, [key]: text })));
      setDone((d) => ({ ...d, [key]: t('Claimed (transaction {tx}), waiting for the next block...', { tx: shortId(tx) }) }));
      await node.waitConfirmed(tx, 1, 300000).catch(() => undefined);
      setDone((d) => ({ ...d, [key]: t('Done, transaction {tx}', { tx: shortId(tx) }) }));
      setCodeFor('');
      setCodeText('');
      await load();
    } catch (e) {
      const m = errorText(e);
      setDone((d) => ({ ...d, [key]: /conditions not satisfied/.test(m) ? t('The chain refused the claim: the code was not in your code box yet. Try again in a minute.') : m }));
    } finally {
      setActing('');
    }
  };

  const setupBox = async () => {
    setActing('box');
    setError('');
    try {
      const tx = await createCodeBox(node, session);
      await node.waitConfirmed(tx, 1, 300000).catch(() => undefined);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing('');
    }
  };

  const codes = savedCodes(session.genesis);
  const rowProps = { session, acting, onAct: act, codes, codeFor, setCodeFor, codeText, setCodeText, onCode: claimCode };

  const open = rows.filter((r) => !r.status.closed);
  const closed = rows.filter((r) => r.status.closed);
  const incoming = open.filter((r) => r.incoming);
  const sent = open.filter((r) => !r.incoming);

  return (
    <div className="stack">
      <div className="row">
        <button onClick={load} disabled={busy}>
          {busy ? t('Loading...') : t('Refresh')}
        </button>
        {now > 0 && <span className="muted">{t('Block time {time}', { time: fmtTime(now) })}</span>}
        <span style={{ marginLeft: 'auto' }} className="row">
          <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder={t('paste a shared contract or a transaction id')} spellCheck={false} style={{ width: 320 }} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button onClick={add} disabled={!addText.trim()}>
            {t('Add')}
          </button>
        </span>
      </div>
      {error && <div className="note bad">{error}</div>}
      {hidden > 0 && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{t('{n} DEX swap locks and ordinary payments with an expiry are not shown here: the DEX and the wallet handle them.', { n: hidden })}</p>}

      {myBox === false && (
        <div className="note row">
          <span>
            {session.net.private || session.net.hybrid
              ? t('To receive payments released with a code, set up your code box once. Senders cannot use the code template for you before that.')
              : t('To receive payments released with a code, set up your code box once (a name, 1 NXS fee). Senders cannot use the code template for you before that.')}
          </span>
          <button className="small" disabled={acting === 'box'} onClick={setupBox}>
            {acting === 'box' ? t('Setting up...') : t('Set up code box')}
          </button>
        </div>
      )}
      <section className="card">
        <h2>{t('Sent to you')}</h2>
        {incoming.length === 0 && <p className="muted">{t('Nothing open. Contracts to your accounts in the last blocks show up here; an older one can be added by its transaction id.')}</p>}
        <div className="list">
          {incoming.map((r) => (
            <ContractRow key={`${r.c.txid}/${r.c.contract}`} r={r} {...rowProps} result={done[`${r.c.txid}/${r.c.contract}`]} />
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{t('Sent by you')}</h2>
        {sent.length === 0 && <p className="muted">{t('No open contracts among your last 100 transactions.')}</p>}
        <div className="list">
          {sent.map((r) => (
            <ContractRow key={`${r.c.txid}/${r.c.contract}`} r={r} {...rowProps} result={done[`${r.c.txid}/${r.c.contract}`]} />
          ))}
        </div>
      </section>

      {closed.length > 0 && (
        <section className="card">
          <h2 className="row">
            {t('Finished ({n})', { n: closed.length })}
            <button className="small" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? t('Hide') : t('Show')}
            </button>
          </h2>
          {showClosed && (
            <div className="list">
              {closed.map((r) => (
                <ContractRow key={`${r.c.txid}/${r.c.contract}`} r={r} {...rowProps} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

interface RowProps {
  r: Row;
  session: Session;
  acting: string;
  result?: string;
  onAct: (r: Row) => void;
  codes: Record<string, string>;
  codeFor: string;
  setCodeFor: (k: string) => void;
  codeText: string;
  setCodeText: (t: string) => void;
  onCode: (r: Row) => void;
}

function ContractRow({ r, session, acting, result, onAct, codes, codeFor, setCodeFor, codeText, setCodeText, onCode }: RowProps) {
  const { c, status } = r;
  const key = `${c.txid}/${c.contract}`;
  const ticker = c.ticker;
  const labels: Record<string, string> = { [session.genesis]: t('You') };
  const words = c.condition ? describe(c.condition, { labels, sender: c.sender, time: fmtTime, t, me: session.genesis }) : [t('A contract form this module cannot read')];
  const iAmSender = c.sender === session.genesis;
  const secret = status.ways.flatMap((w) => w.way).find((b) => b.kind === 'secret');
  const sentCode = secret?.kind === 'secret' ? codes[secret.hash] : undefined;
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="item">
        <div>
          <div className="amount">
            {formatAmount(status.closed ? c.amount : c.open, c.decimals)} {ticker}
          </div>
          <div className="meta">
            {iAmSender ? t('to account {id}', { id: shortId(c.to) }) : t('from user {id}', { id: shortId(c.sender) })} . {fmtTime(c.time)} .{' '}
            <button className="link" style={{ fontSize: 12 }} onClick={() => copyText(iAmSender ? shareText(c.txid) : c.txid)} title={iAmSender ? t('Copies a message to send to the recipient, so they can find this payment') : undefined}>
              {iAmSender ? t('share with the recipient') : t('copy transaction id')}
            </button>
          </div>
        </div>
        <div className="row">
          {status.closed && <span className="pill done">{t('finished')}</span>}
          {!status.closed && status.broken && <span className="pill">{t('cannot be claimed: a register it reads is missing')}</span>}
          {!status.closed && status.needsCode && !status.canClaim && (
            <button className="primary" disabled={acting === key} onClick={() => setCodeFor(codeFor === key ? '' : key)}>
              {t('Enter code')}
            </button>
          )}
          {!status.closed && status.canClaim && (
            <button className="primary" disabled={acting === key} onClick={() => onAct(r)}>
              {acting === key ? t('Sending...') : iAmSender ? t('Take back') : t('Claim')}
            </button>
          )}
          {!status.closed && !status.canClaim && status.maybe && (
            <button disabled={acting === key} onClick={() => onAct(r)} title={t('Part of the rules is code: the chain decides')}>
              {acting === key ? t('Sending...') : t('Try to claim')}
            </button>
          )}
          {!status.closed && !status.broken && !status.canClaim && !status.needsCode && !status.maybe && <span className={`pill ${status.waiting.length ? 'wait' : 'done'}`}>{status.waiting.length ? t('waiting: {list}', { list: [...new Set(status.waiting)].join(', ') }) : iAmSender ? t('for the recipient') : t('not for you')}</span>}
        </div>
      </div>
      {codeFor === key && (
        <div className="row spaced">
          <input value={codeText} onChange={(e) => setCodeText(e.target.value)} placeholder={t('the code from the sender, e.g. ABCD-EFGH-JKLM-NPQR')} spellCheck={false} style={{ flex: '1 1 260px', fontFamily: 'var(--mono)' }} autoFocus />
          <button className="primary" disabled={acting === key || codeText.replace(/[\s-]/g, '').length < 8} onClick={() => onCode(r)}>
            {acting === key ? t('Claiming...') : t('Claim with this code')}
          </button>
        </div>
      )}
      {iAmSender && !status.closed && sentCode && (
        <div className="note spaced">
          {t('Code to give when you want to release it:')} <b style={{ fontFamily: 'var(--mono)' }}>{sentCode}</b>{' '}
          <button className="link" onClick={() => copyText(sentCode)}>
            {t('copy')}
          </button>
        </div>
      )}
      {result && <div className="note spaced">{result}</div>}
      <details className="spaced">
        <summary className="muted">{t('Rules')}</summary>
        <ul className="words spaced">
          {words.map((w, i) => (
            <li key={i}>
              <b>{i + 1}</b>
              {w}
              {status.ways[i] && status.ways[i]!.mine && <span className={`pill ${status.ways[i]!.ready === 'yes' ? 'ready' : 'wait'}`} style={{ marginLeft: 8 }}>{status.ways[i]!.ready === 'yes' ? t('ready for you') : status.ways[i]!.ready === 'maybe' ? t('chain decides') : t('not yet')}</span>}
            </li>
          ))}
        </ul>
        {c.condition && <pre style={{ fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{print(c.condition)}</pre>}
      </details>
    </div>
  );
}
