import { useCallback, useEffect, useState } from 'react';
import { describe, print } from '@nexus-contracts/core/src';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { blockTime, claim, decisionState, discoverEscrows, incomingContracts, readContracts, reloadAccounts, sentContracts, type ChainContract, type DecisionState, type Session } from '../lib/chain';
import { contractStatus, decisionKey, escrowRefs, fmtTime, type ContractStatus } from '../lib/status';
import { copyText, errorText, formatAmount, shortId } from './common';

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

  const load = useCallback(async () => {
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
      const list = all.map((r) => ({ ...r, status: contractStatus(r.c, session.genesis, t, decisions, ids) }));
      list.sort((a, b) => Number(b.status.canClaim) - Number(a.status.canClaim) || b.c.time - a.c.time);
      setRows(list);
      setNow(t);
      onWaiting(list.filter((r) => r.status.canClaim).length);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [node, session, watched, onWaiting]);

  useEffect(() => {
    if (active) {
      void load();
    }
  }, [active, load]);

  const add = async () => {
    const t = addText.trim().toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(t)) {
      setError('A transaction id is 128 hex digits');
      return;
    }
    try {
      const found = await readContracts(node, t);
      if (!found.length) {
        setError('That transaction has no contract');
        return;
      }
    } catch (e) {
      setError(errorText(e));
      return;
    }
    const list = [...new Set([...watched, t])];
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
      setDone((d) => ({ ...d, [key]: 'None of your accounts can receive it' }));
      return;
    }
    setActing(key);
    try {
      const tx = await claim(node, session, r.c, into);
      setDone((d) => ({ ...d, [key]: `Done, transaction ${shortId(tx)}` }));
      await node.waitConfirmed(tx, 1, 180000).catch(() => undefined);
      await load();
    } catch (e) {
      const m = errorText(e);
      setDone((d) => ({ ...d, [key]: /conditions not satisfied/.test(m) ? 'The chain says the rules are not met yet (it checks the time of the newest block)' : m }));
    } finally {
      setActing('');
    }
  };

  const open = rows.filter((r) => !r.status.closed);
  const closed = rows.filter((r) => r.status.closed);
  const incoming = open.filter((r) => r.incoming);
  const sent = open.filter((r) => !r.incoming);

  return (
    <div className="stack">
      <div className="row">
        <button onClick={load} disabled={busy}>
          {busy ? 'Loading...' : 'Refresh'}
        </button>
        {now > 0 && <span className="muted">Block time {fmtTime(now)}</span>}
        <span style={{ marginLeft: 'auto' }} className="row">
          <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="add a contract by transaction id" spellCheck={false} style={{ width: 300 }} />
          <button onClick={add} disabled={!addText.trim()}>
            Add
          </button>
        </span>
      </div>
      {error && <div className="note bad">{error}</div>}
      {hidden > 0 && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{hidden} DEX swap locks and ordinary payments with an expiry are not shown here: the DEX and the wallet handle them.</p>}

      <section className="card">
        <h2>Sent to you</h2>
        {incoming.length === 0 && <p className="muted">Nothing open. Contracts to your accounts in the last blocks show up here; an older one can be added by its transaction id.</p>}
        <div className="list">
          {incoming.map((r) => (
            <ContractRow key={`${r.c.txid}/${r.c.contract}`} r={r} session={session} acting={acting} result={done[`${r.c.txid}/${r.c.contract}`]} onAct={act} />
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Sent by you</h2>
        {sent.length === 0 && <p className="muted">No open contracts among your last 100 transactions.</p>}
        <div className="list">
          {sent.map((r) => (
            <ContractRow key={`${r.c.txid}/${r.c.contract}`} r={r} session={session} acting={acting} result={done[`${r.c.txid}/${r.c.contract}`]} onAct={act} />
          ))}
        </div>
      </section>

      {closed.length > 0 && (
        <section className="card">
          <h2 className="row">
            Finished ({closed.length})
            <button className="small" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? 'Hide' : 'Show'}
            </button>
          </h2>
          {showClosed && (
            <div className="list">
              {closed.map((r) => (
                <ContractRow key={`${r.c.txid}/${r.c.contract}`} r={r} session={session} acting={acting} onAct={act} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ContractRow({ r, session, acting, result, onAct }: { r: Row; session: Session; acting: string; result?: string; onAct: (r: Row) => void }) {
  const { c, status } = r;
  const key = `${c.txid}/${c.contract}`;
  const ticker = c.ticker;
  const labels: Record<string, string> = { [session.genesis]: 'You' };
  const words = c.condition ? describe(c.condition, { labels, sender: c.sender, time: fmtTime }) : ['A contract form this module cannot read'];
  const iAmSender = c.sender === session.genesis;
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="item">
        <div>
          <div className="amount">
            {formatAmount(status.closed ? c.amount : c.open, c.decimals)} {ticker}
          </div>
          <div className="meta">
            {iAmSender ? `to account ${shortId(c.to)}` : `from user ${shortId(c.sender)}`} . {fmtTime(c.time)} .{' '}
            <button className="link" style={{ fontSize: 12 }} onClick={() => copyText(c.txid)}>
              copy transaction id
            </button>
          </div>
        </div>
        <div className="row">
          {status.closed && <span className="pill done">finished</span>}
          {!status.closed && status.canClaim && (
            <button className="primary" disabled={acting === key} onClick={() => onAct(r)}>
              {acting === key ? 'Sending...' : iAmSender ? 'Take back' : 'Claim'}
            </button>
          )}
          {!status.closed && !status.canClaim && status.maybe && (
            <button disabled={acting === key} onClick={() => onAct(r)} title="Part of the rules is code: the chain decides">
              {acting === key ? 'Sending...' : 'Try to claim'}
            </button>
          )}
          {!status.closed && !status.canClaim && !status.maybe && <span className={`pill ${status.waiting.length ? 'wait' : 'done'}`}>{status.waiting.length ? `waiting: ${[...new Set(status.waiting)].join(', ')}` : iAmSender ? 'for the recipient' : 'not for you'}</span>}
        </div>
      </div>
      {result && <div className="note spaced">{result}</div>}
      <details className="spaced">
        <summary className="muted">Rules</summary>
        <ul className="words spaced">
          {words.map((w, i) => (
            <li key={i}>
              <b>{i + 1}</b>
              {w}
              {status.ways[i] && status.ways[i]!.mine && <span className={`pill ${status.ways[i]!.ready === 'yes' ? 'ready' : 'wait'}`} style={{ marginLeft: 8 }}>{status.ways[i]!.ready === 'yes' ? 'ready for you' : status.ways[i]!.ready === 'maybe' ? 'chain decides' : 'not yet'}</span>}
            </li>
          ))}
        </ul>
        {c.condition && <pre style={{ fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{print(c.condition)}</pre>}
      </details>
    </div>
  );
}
