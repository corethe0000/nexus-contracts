import { useCallback, useEffect, useState } from 'react';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { contractsForEscrows, createDecision, decisionState, myEscrowIds, nameFeeOn, reloadAccounts, setDecision, type ChainContract, type DecisionState, type Session } from '../lib/chain';
import { fmtTime } from '../lib/status';
import { copyText, errorText, formatAmount } from './common';
import { t } from '../lib/i18n';

//a function, so the texts follow the language set at start
const valueNames = (): Record<number, string> => ({ 0: t('open'), 1: t('released to the recipient'), 2: t('refunded to the sender') });

const autoRefreshMs = 30000;

export function Arbiter({ node, session, active }: { node: NexusNode; session: Session; active: boolean }) {
  const [items, setItems] = useState<{ id: string; d: DecisionState }[]>([]);
  const [uses, setUses] = useState(new Map<string, ChainContract[]>());
  const [newId, setNewId] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ids = await myEscrowIds(node, session);
      setItems(await Promise.all(ids.map(async (id) => ({ id, d: await decisionState(node, session.genesis, id) }))));
      setUses(await contractsForEscrows(node, session.genesis, ids));
    } catch (e) {
      setMsg({ error: errorText(e) });
    } finally {
      setLoading(false);
    }
  }, [node, session]);

  useEffect(() => {
    if (active) {
      void load();
    }
  }, [active, load]);

  //while the tab is open, a new block can bring news: look again every half minute
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => void load(), autoRefreshMs);
    return () => clearInterval(timer);
  }, [active, load]);

  const run = async (label: string, fn: () => Promise<string>, ok: string, after?: () => void) => {
    setBusy(label);
    setMsg({});
    try {
      const tx = await fn();
      setMsg({ ok: t('Sent (transaction {tx}...), waiting for the next block...', { tx: tx.slice(0, 8) }) });
      const inBlock = await node.waitConfirmed(tx, 1, 180000).then(
        () => true,
        () => false,
      );
      setMsg(inBlock ? { ok } : { ok: t('Sent, not in a block yet: refresh in a while. {message}', { message: ok }) });
      setBusy('');
      after?.();
      await reloadAccounts(node, session).catch(() => undefined);
      await load();
    } catch (e) {
      setMsg({ error: errorText(e) });
    } finally {
      setBusy('');
    }
  };

  const suggest = () => setNewId(Math.random().toString(36).slice(2, 10));
  const fee = nameFeeOn(session.net);
  const validId = /^[a-z0-9]{4,32}$/.test(newId);
  const taken = items.some((i) => i.id === newId);

  //newest first; an escrow whose payments were all claimed needs no decision any more
  const isDone = (id: string) => (uses.get(id)?.length ?? 0) > 0 && uses.get(id)!.every((c) => c.open <= 0n);
  const newest = [...items].reverse();
  const openOnes = newest.filter((i) => !isDone(i.id));
  const finished = newest.filter((i) => isDone(i.id));
  const values = valueNames();

  //a plain function, not a component: a component made inside would mount anew on every render
  const escrowRow = (id: string, d: DecisionState, done = false) => (
      <div key={id} className="card" style={{ padding: 12 }}>
              <div className="item">
                <div>
                  <b>{id}</b>{' '}
                  <button className="link" style={{ fontSize: 12 }} onClick={() => copyText(id)}>
                    {t('copy')}
                  </button>
                  <div className="meta">{d.exists ? (d.value !== undefined && d.value in values ? values[d.value] : t('unknown value')) : t('not found')}</div>
                  <Payments list={uses.get(id)} />
                </div>
                <div className="row" hidden={done}>
                  <button disabled={!!busy || d.value === 1} onClick={() => run(`r${id}`, () => setDecision(node, session, id, 1), t('Escrow "{id}": released. The recipient can claim now.', { id }))}>
                    {busy === `r${id}` ? t('Saving...') : t('Release')}
                  </button>
                  <button disabled={!!busy || d.value === 2} onClick={() => run(`f${id}`, () => setDecision(node, session, id, 2), t('Escrow "{id}": refunded. The sender can take it back now.', { id }))}>
                    {busy === `f${id}` ? t('Saving...') : t('Refund')}
                  </button>
                  {d.value !== 0 && (
                    <button className="small" disabled={!!busy} onClick={() => run(`o${id}`, () => setDecision(node, session, id, 0), t('Escrow "{id}" is open again.', { id }))}>
                      {t('Reopen')}
                    </button>
                  )}
                </div>
              </div>
            </div>
  );

  return (
    <div className="stack">
      <section className="card">
        <h2>{t('New escrow id')}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('When two people ask you to be their arbiter, create an id here and give it to the sender with your username. The sender uses it in the Escrow template. Later you decide: release (the recipient can claim) or refund (the sender can take it back). You never hold the payment and cannot take it.')}
        </p>
        <div className="row">
          <input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase().trim())} placeholder={t('e.g. order42')} spellCheck={false} style={{ width: 200 }} />
          <button onClick={suggest}>{t('Suggest one')}</button>
          <button className="primary" disabled={!validId || taken || !!busy} onClick={() => run('create', () => createDecision(node, session, newId), t('Escrow "{id}" is ready. Give the sender your username "{username}" and the id "{id}".', { id: newId, username: session.username }), () => setNewId(''))}>
            {busy === 'create' ? t('Creating...') : t('Create')}
          </button>
          {fee > 0n && <span className="muted">{t('costs {amount} NXS (a name)', { amount: formatAmount(fee, 6) })}</span>}
        </div>
        {newId && !validId && <p className="bad">{t('4 to 32 lower case letters or digits')}</p>}
        {taken && <p className="bad">{t('You already have this id')}</p>}
        {msg.ok && <div className="note good spaced">{msg.ok}</div>}
        {msg.error && <div className="note bad spaced">{msg.error}</div>}
      </section>

      <section className="card">
        <h2 className="row">
          {t('Your escrows')}
          <button className="small" onClick={load} disabled={loading}>
            {loading ? t('Loading...') : t('Refresh')}
          </button>
        </h2>
        {items.length === 0 && !loading && <p className="muted">{t('None yet.')}</p>}
        <div className="list">
          {openOnes.map(({ id, d }) => escrowRow(id, d))}
        </div>
        {finished.length > 0 && (
          <details className="spaced">
            <summary className="muted">{t('Finished: the payment was claimed ({n})', { n: finished.length })}</summary>
            <div className="list spaced">
              {finished.map(({ id, d }) => escrowRow(id, d, true))}
            </div>
          </details>
        )}
        <p className="muted spaced" style={{ fontSize: 12 }}>
          {t('A decision can be changed until someone claims; after a claim the payment has moved and the decision no longer matters. Use one id per deal.')}
        </p>
      </section>
    </div>
  );
}

//the payments that wait on this escrow: decide only once the payment is there
function Payments({ list }: { list?: ChainContract[] }) {
  if (!list?.length) {
    return <div className="meta">{t('No payment using this id in the recent blocks yet. Wait for the sender before you decide.')}</div>;
  }
  return (
    <div className="meta">
      {list.map((c) => (
        <div key={`${c.txid}/${c.contract}`}>
          {c.open > 0n
            ? t('{amount} {ticker} locked {time}: waiting for the claim', { amount: formatAmount(c.amount, c.decimals), ticker: c.ticker, time: fmtTime(c.time) })
            : t('{amount} {ticker} locked {time}: already claimed', { amount: formatAmount(c.amount, c.decimals), ticker: c.ticker, time: fmtTime(c.time) })}
        </div>
      ))}
    </div>
  );
}
