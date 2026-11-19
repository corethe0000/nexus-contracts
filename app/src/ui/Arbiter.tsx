import { useCallback, useEffect, useState } from 'react';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { createDecision, decisionState, myEscrowIds, nameFeeOn, reloadAccounts, setDecision, type DecisionState, type Session } from '../lib/chain';
import { copyText, errorText, formatAmount } from './common';

const valueNames: Record<number, string> = { 0: 'open', 1: 'released to the recipient', 2: 'refunded to the sender' };

export function Arbiter({ node, session, active }: { node: NexusNode; session: Session; active: boolean }) {
  const [items, setItems] = useState<{ id: string; d: DecisionState }[]>([]);
  const [newId, setNewId] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ids = await myEscrowIds(node, session);
      setItems(await Promise.all(ids.map(async (id) => ({ id, d: await decisionState(node, session.genesis, id) }))));
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

  const run = async (label: string, fn: () => Promise<string>, ok: string) => {
    setBusy(label);
    setMsg({});
    try {
      const tx = await fn();
      await node.waitConfirmed(tx, 1, 180000).catch(() => undefined);
      setMsg({ ok });
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

  return (
    <div className="stack">
      <section className="card">
        <h2>New escrow id</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          When two people ask you to be their arbiter, create an id here and give it to the sender with your username. The sender uses it in the Escrow template. Later you decide: release (the recipient can claim) or refund (the sender
          can take it back). You never hold the payment and cannot take it.
        </p>
        <div className="row">
          <input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase().trim())} placeholder="e.g. order42" spellCheck={false} style={{ width: 200 }} />
          <button onClick={suggest}>Suggest one</button>
          <button className="primary" disabled={!validId || taken || !!busy} onClick={() => run('create', () => createDecision(node, session, newId), `Escrow "${newId}" is ready. Give the sender your username "${session.username}" and the id "${newId}".`)}>
            {busy === 'create' ? 'Creating...' : 'Create'}
          </button>
          {fee > 0n && <span className="muted">costs {formatAmount(fee, 6)} NXS (a name)</span>}
        </div>
        {newId && !validId && <p className="bad">4 to 32 lower case letters or digits</p>}
        {taken && <p className="bad">You already have this id</p>}
        {msg.ok && <div className="note good spaced">{msg.ok}</div>}
        {msg.error && <div className="note bad spaced">{msg.error}</div>}
      </section>

      <section className="card">
        <h2 className="row">
          Your escrows
          <button className="small" onClick={load} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </h2>
        {items.length === 0 && !loading && <p className="muted">None yet.</p>}
        <div className="list">
          {items.map(({ id, d }) => (
            <div key={id} className="card" style={{ padding: 12 }}>
              <div className="item">
                <div>
                  <b>{id}</b>{' '}
                  <button className="link" style={{ fontSize: 12 }} onClick={() => copyText(id)}>
                    copy
                  </button>
                  <div className="meta">{d.exists ? (d.value !== undefined && d.value in valueNames ? valueNames[d.value] : 'unknown value') : 'not found'}</div>
                </div>
                <div className="row">
                  <button disabled={!!busy || d.value === 1} onClick={() => run(`r${id}`, () => setDecision(node, session, id, 1), `Escrow "${id}": released. The recipient can claim now.`)}>
                    {busy === `r${id}` ? 'Saving...' : 'Release'}
                  </button>
                  <button disabled={!!busy || d.value === 2} onClick={() => run(`f${id}`, () => setDecision(node, session, id, 2), `Escrow "${id}": refunded. The sender can take it back now.`)}>
                    {busy === `f${id}` ? 'Saving...' : 'Refund'}
                  </button>
                  {d.value !== 0 && (
                    <button className="small" disabled={!!busy} onClick={() => run(`o${id}`, () => setDecision(node, session, id, 0), `Escrow "${id}" is open again.`)}>
                      Reopen
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="muted spaced" style={{ fontSize: 12 }}>
          A decision can be changed until someone claims; after a claim the payment has moved and the decision no longer matters. Use one id per deal.
        </p>
      </section>
    </div>
  );
}
