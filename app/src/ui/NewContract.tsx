import { useEffect, useMemo, useRef, useState } from 'react';
import { decisionIds, describe, encode, escrow, parse, ParseError, print, returnIfUnclaimed, timeLock, toCondition, toWays, type Block, type Condition, type Way } from '@nexus-contracts/core/src';
import { hexOfMemory } from '../../../../wallet/src/lib/tritium';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { accountFor, blockTime, decisionState, reloadAccounts, sendContract, type DecisionState, type Person, type Session } from '../lib/chain';
import { decisionKey, fmtTime } from '../lib/status';
import { Builder } from './Builder';
import { copyText, errorText, formatAmount, parseAmount, pasteText, PersonInput, shortId, TimeInput } from './common';

type Template = 'return' | 'timelock' | 'escrow' | 'blank';

const templates: { id: Template; name: string; text: string }[] = [
  { id: 'return', name: 'Return if unclaimed', text: 'They claim before a date, after it the payment comes back to you' },
  { id: 'timelock', name: 'Time-lock', text: 'They can claim only from a date on' },
  { id: 'escrow', name: 'Escrow', text: 'A person you both trust decides: release to them or refund to you' },
  { id: 'blank', name: 'Blank', text: 'Build your own rules with blocks or code' },
];

const day = 86400;

export function NewContract({ node, session, onSent }: { node: NexusNode; session: Session; onSent: () => void }) {
  const now = () => Math.floor(Date.now() / 1000);
  const [template, setTemplate] = useState<Template>('return');
  const [recipient, setRecipient] = useState<Person | null>(null);
  const [recipientText, setRecipientText] = useState('');
  const [deadline, setDeadline] = useState(() => now() + 7 * day);
  const [unlock, setUnlock] = useState(() => now() + 30 * day);
  const [cancelable, setCancelable] = useState(false);
  const [returnAfter, setReturnAfter] = useState(0);
  const [arbiter, setArbiter] = useState<Person | null>(null);
  const [arbiterText, setArbiterText] = useState('');
  const [escrowId, setEscrowId] = useState('');
  const [fallback, setFallback] = useState(0);
  const [ways, setWaysRaw] = useState<Way[]>([[]]);
  const [names, setNames] = useState(() => new Map<string, string>());
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<{ msg: string; pos?: number } | null>(null);
  const [showBytes, setShowBytes] = useState(false);
  const [from, setFrom] = useState('');
  const [amountText, setAmountText] = useState('');
  const [payTo, setPayTo] = useState('');
  const [decisions, setDecisions] = useState(new Map<string, DecisionState>());
  const [toInfo, setToInfo] = useState<{ owner: string; token: string } | null | 'missing'>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: string; error?: string }>({});
  const [chainTime, setChainTime] = useState(0);
  const typing = useRef(false);

  const onName = (g: string, label: string) => setNames((m) => (m.get(g) === label ? m : new Map(m).set(g, label)));

  //--- template form to blocks ---
  const templateError = useMemo(() => {
    if (template === 'blank') {
      return '';
    }
    if (!recipient) {
      return 'Pick who gets the payment';
    }
    if (recipient.genesis === session.genesis) {
      return 'The recipient is you';
    }
    if (template === 'escrow') {
      if (!arbiter) {
        return 'Pick the arbiter';
      }
      if (!/^[a-z0-9]{4,32}$/.test(escrowId)) {
        return 'The escrow id is 4 to 32 lower case letters or digits, as the arbiter gave it to you';
      }
    }
    return '';
  }, [template, recipient, arbiter, escrowId, session.genesis]);

  const fillFromTemplate = () => {
    setResult({});
    if (template === 'blank') {
      setWays([[{ kind: 'who', genesis: recipient?.genesis ?? '' }]]);
      return;
    }
    if (templateError || !recipient) {
      return;
    }
    const me = session.genesis;
    try {
      let c: Condition;
      if (template === 'return') {
        c = returnIfUnclaimed({ sender: me, recipient: recipient.genesis, deadline });
      } else if (template === 'timelock') {
        c = timeLock({ sender: me, recipient: recipient.genesis, unlock, cancelable, returnAfter: returnAfter || undefined });
      } else {
        c = escrow({ sender: me, recipient: recipient.genesis, arbiter: arbiter!.genesis, id: escrowId, fallback: fallback || undefined });
      }
      setWays(toWays(c, decisionIds(arbiter ? [{ arbiter: arbiter.genesis, id: escrowId }] : [])));
    } catch (e) {
      setResult({ error: errorText(e) });
    }
  };

  //--- builder and console stay in step ---
  const known = useMemo(() => ways.flat().filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision').map((b) => ({ arbiter: b.arbiter, id: b.id })), [ways]);

  const built = useMemo((): { condition?: Condition; bytes?: Uint8Array; error?: string } => {
    try {
      const condition = toCondition(ways);
      return { condition, bytes: encode(condition) };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [ways]);

  function setWays(w: Way[]) {
    typing.current = false;
    setWaysRaw(w);
  }

  useEffect(() => {
    if (typing.current) {
      return;
    }
    if (built.condition) {
      setCode(print(built.condition));
      setCodeError(null);
    }
  }, [built]);

  const onCode = (text: string) => {
    setCode(text);
    try {
      const c = parse(text);
      typing.current = true;
      setWaysRaw(toWays(c, decisionIds(known)));
      setCodeError(null);
    } catch (e) {
      setCodeError(e instanceof ParseError ? { msg: e.message, pos: e.pos } : { msg: errorText(e) });
    }
  };

  //--- payment ---
  const fromAccount = session.accounts.find((a) => a.address === from);
  useEffect(() => {
    if (!from && session.accounts.length) {
      setFrom((session.accounts.find((a) => a.token === '0' && a.address !== a.token) ?? session.accounts[0]!).address);
    }
  }, [session.accounts, from]);
  //the recipient's account in the token that pays
  const [autoTo, setAutoTo] = useState<{ address?: string; looking?: boolean }>({});
  const payToken = fromAccount?.token;
  useEffect(() => {
    let live = true;
    if (!recipient || payToken === undefined) {
      setAutoTo({});
      return;
    }
    setAutoTo({ looking: true });
    accountFor(node, recipient, payToken)
      .then((a) => {
        if (live) {
          setAutoTo({ address: a });
          setPayTo(a ?? '');
        }
      })
      .catch(() => live && setAutoTo({}));
    return () => {
      live = false;
    };
  }, [recipient, payToken, node]);
  const amount = fromAccount ? parseAmount(amountText, fromAccount.decimals) : null;

  useEffect(() => {
    let live = true;
    setToInfo(null);
    if (!payTo.trim()) {
      return;
    }
    node
      .accountState(payTo.trim())
      .then((s) => live && setToInfo({ owner: s.owner, token: s.token }))
      .catch(() => live && setToInfo('missing'));
    return () => {
      live = false;
    };
  }, [payTo, node]);

  //decision registers the contract reads, and the block time
  useEffect(() => {
    let live = true;
    (async () => {
      const m = new Map<string, DecisionState>();
      for (const k of known) {
        if (/^[0-9a-f]{64}$/.test(k.arbiter) && /^[a-z0-9]{4,32}$/.test(k.id)) {
          m.set(decisionKey(k.arbiter, k.id), await decisionState(node, k.arbiter, k.id).catch(() => ({ exists: false })));
        }
      }
      const t = await blockTime(node).catch(() => 0);
      if (live) {
        setDecisions(m);
        setChainTime(t);
      }
    })();
    return () => {
      live = false;
    };
  }, [known, node]);

  //--- checks ---
  const labels = useMemo(() => {
    const l: Record<string, string> = { [session.genesis]: 'You' };
    for (const [g, n] of names) {
      l[g] = n;
    }
    if (recipient) {
      l[recipient.genesis] = recipient.username ?? l[recipient.genesis] ?? 'the recipient';
    }
    if (arbiter) {
      l[arbiter.genesis] = `${arbiter.username ?? 'the arbiter'} (arbiter)`;
    }
    return l;
  }, [names, recipient, arbiter, session.genesis]);

  const problems: string[] = [];
  const warnings: string[] = [];
  if (built.error) {
    problems.push(built.error);
  }
  if (codeError) {
    problems.push('The code has an error: fix it or undo it');
  }
  if (!fromAccount) {
    problems.push('Pick the account that pays');
  }
  if (amount === null || amount === 0n) {
    problems.push('Enter the amount');
  } else if (fromAccount && amount > fromAccount.balance) {
    problems.push('The amount is more than the account holds');
  }
  if (!payTo.trim()) {
    problems.push('Enter the account the payment goes to');
  } else if (toInfo === 'missing') {
    problems.push('The account it goes to was not found');
  } else if (toInfo && fromAccount && toInfo.token !== fromAccount.token) {
    problems.push('The account it goes to holds another token');
  }
  for (const k of known) {
    const d = decisions.get(decisionKey(k.arbiter, k.id));
    if (d && !d.exists) {
      problems.push(`The arbiter has not created escrow "${k.id}" yet. Ask them to create it in the Arbiter tab first: a contract that reads a missing register can never be claimed, not even taken back.`);
    } else if (d?.exists && d.owner !== k.arbiter) {
      problems.push(`Escrow "${k.id}" now belongs to someone else`);
    } else if (d?.exists && d.value !== 0) {
      warnings.push(`Escrow "${k.id}" is already decided (${d.value === 1 ? 'release' : d.value === 2 ? 'refund' : 'unknown value'}). Use a new escrow id for a new deal.`);
    }
  }
  //a claim goes into the claimer's own account: only the owner of "to" (claim) or you (take back) can ever use a way
  if (toInfo && toInfo !== 'missing' && built.condition) {
    ways.forEach((w, i) => {
      const who = w.filter((b): b is Extract<Block, { kind: 'who' }> => b.kind === 'who').map((b) => b.genesis);
      if (who.length && who.every((g) => g !== toInfo.owner && g !== session.genesis)) {
        warnings.push(`Way ${i + 1} can never be used: only the owner of the receiving account or you can claim.`);
      }
      if (!who.length) {
        warnings.push(`Way ${i + 1} has no "who claims" block: the recipient and you can both use it.`);
      }
    });
    const recipientWay = ways.some((w) => w.some((b) => b.kind === 'who' && b.genesis === toInfo.owner));
    const myWay = ways.some((w) => w.some((b) => b.kind === 'who' && b.genesis === session.genesis));
    if (!recipientWay && ways.every((w) => w.some((b) => b.kind === 'who'))) {
      warnings.push('The owner of the receiving account has no way to claim.');
    }
    if (!myWay && ways.every((w) => w.some((b) => b.kind === 'who'))) {
      warnings.push('You have no way to take it back: if they never claim, it stays locked for good.');
    }
  }
  const t = chainTime || now();
  for (const b of ways.flat()) {
    if ((b.kind === 'before' || b.kind === 'from') && b.time <= t) {
      warnings.push(`${b.kind === 'before' ? 'Before' : 'From'} ${fmtTime(b.time)} is already past.`);
    }
  }

  const send = async () => {
    if (!built.bytes || !fromAccount || !amount) {
      return;
    }
    setBusy(true);
    setResult({});
    try {
      const txid = await sendContract(node, session, { from: fromAccount.address, to: payTo.trim(), amount, condition: built.bytes });
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

  const words = built.condition ? describe(built.condition, { labels, sender: session.genesis, time: fmtTime }) : [];
  const ticker = fromAccount?.ticker ?? 'NXS';

  return (
    <div className="stack">
      <section className="card">
        <h2>
          <span className="step">1</span>Start from
        </h2>
        <div className="templates">
          {templates.map((tp) => (
            <button key={tp.id} className={template === tp.id ? 'on' : ''} onClick={() => setTemplate(tp.id)}>
              <b>{tp.name}</b>
              <small>{tp.text}</small>
            </button>
          ))}
        </div>
        <div className="grid2">
          <div>
            <label className="field">
              <span>Who gets the payment</span>
              <PersonInput
                node={node}
                session={session}
                value={recipientText}
                onPerson={(p, text) => {
                  setRecipient(p);
                  setRecipientText(text);
                  if (p) {
                    onName(p.genesis, p.username ?? text);
                  }
                }}
              />
            </label>
            {template === 'return' && (
              <label className="field">
                <span>They can claim until</span>
                <TimeInput value={deadline} onChange={setDeadline} />
                <span className="hint">After this the payment can only come back to you.</span>
              </label>
            )}
            {template === 'timelock' && (
              <>
                <label className="field">
                  <span>They can claim from</span>
                  <TimeInput value={unlock} onChange={setUnlock} />
                </label>
                <label className="row field">
                  <input type="checkbox" checked={cancelable} onChange={(e) => setCancelable(e.target.checked)} />
                  <span style={{ fontSize: 13, color: 'var(--ink)' }}>You can cancel it before that time</span>
                </label>
                <label className="field">
                  <span>Comes back to you if still unclaimed from (optional)</span>
                  <div className="row">
                    <TimeInput value={returnAfter} onChange={setReturnAfter} />
                    {returnAfter > 0 && (
                      <button className="small" onClick={() => setReturnAfter(0)}>
                        Clear
                      </button>
                    )}
                  </div>
                </label>
              </>
            )}
            {template === 'escrow' && (
              <>
                <label className="field">
                  <span>Arbiter (decides; cannot take the payment)</span>
                  <PersonInput
                    node={node}
                    session={session}
                    value={arbiterText}
                    onPerson={(p, text) => {
                      setArbiter(p);
                      setArbiterText(text);
                      if (p) {
                        onName(p.genesis, p.username ?? text);
                      }
                    }}
                  />
                </label>
                <label className="field">
                  <span>Escrow id</span>
                  <input value={escrowId} onChange={(e) => setEscrowId(e.target.value.toLowerCase().trim())} placeholder="from the arbiter, e.g. order42" spellCheck={false} />
                  <span className="hint">The arbiter creates it first in their Arbiter tab, then gives you the id.</span>
                </label>
                <label className="field">
                  <span>Comes back to you without a decision from (optional)</span>
                  <div className="row">
                    <TimeInput value={fallback} onChange={setFallback} />
                    {fallback > 0 && (
                      <button className="small" onClick={() => setFallback(0)}>
                        Clear
                      </button>
                    )}
                  </div>
                </label>
              </>
            )}
            {template === 'blank' && <p className="muted">Start with one way for the recipient and add your own blocks below.</p>}
          </div>
          <div>
            <TemplateExplain template={template} />
            <div className="row spaced">
              <button className="primary" onClick={fillFromTemplate} disabled={!!templateError && template !== 'blank'}>
                Put into the builder
              </button>
              {templateError && template !== 'blank' && <span className="muted">{templateError}</span>}
            </div>
          </div>
        </div>
      </section>

      <div className="grid2">
        <section className="card">
          <h2>
            <span className="step">2</span>Blocks
          </h2>
          <Builder node={node} session={session} ways={ways} setWays={setWays} names={names} onName={onName} />
        </section>
        <section className="card console">
          <h2>
            <span className="step">2</span>Code
          </h2>
          <div className="bar">
            <button className="small" onClick={() => copyText(code)}>
              Copy
            </button>
            <button
              className="small"
              onClick={async () => {
                const t = await pasteText();
                if (t !== null) {
                  onCode(t);
                }
              }}
            >
              Paste
            </button>
            <button className="small" disabled={!built.condition} onClick={() => built.condition && (setCode(print(built.condition)), setCodeError(null), (typing.current = false))}>
              Tidy
            </button>
            <label className="row end muted" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={showBytes} onChange={(e) => setShowBytes(e.target.checked)} /> bytes
            </label>
          </div>
          <textarea value={code} onChange={(e) => onCode(e.target.value)} spellCheck={false} aria-label="Contract code" placeholder="caller.genesis == 0x... AND ledger.timestamp < date(2027-01-01T00:00Z)" />
          {codeError && (
            <div className="note bad spaced">
              {codeError.msg}
              {codeError.pos !== undefined && <ErrorAt text={code} pos={codeError.pos} />}
            </div>
          )}
          {!codeError && built.error && <div className="note warn spaced">{built.error}</div>}
          {showBytes && built.bytes && (
            <>
              <pre>{Array.from(built.bytes, (b) => b.toString(16).padStart(2, '0')).join('')}</pre>
              <div className="row spaced">
                <span className="muted">{built.bytes.length} bytes</span>
                <button className="small" onClick={() => copyText(Array.from(built.bytes!, (b) => b.toString(16).padStart(2, '0')).join(''))}>
                  Copy bytes
                </button>
              </div>
            </>
          )}
          <details className="spaced">
            <summary className="muted">What you can write</summary>
            <CodeHelp />
          </details>
        </section>
      </div>

      <div className="grid2">
        <section className="card">
          <h2>
            <span className="step">3</span>Payment
          </h2>
          <label className="field">
            <span>From your account</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {session.accounts.map((a) => (
                <option key={a.address} value={a.address}>
                  {a.name ?? shortId(a.address)} ({formatAmount(a.balance, a.decimals)} {a.ticker})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount ({ticker})</span>
            <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </label>
          <label className="field">
            <span>Goes to account</span>
            <input value={payTo} onChange={(e) => setPayTo(e.target.value)} spellCheck={false} placeholder="the recipient's account address" />
            <span className="hint">
              {autoTo.looking ? 'Looking for their account in this token... ' : ''}
              {recipient && !autoTo.looking && !autoTo.address ? `${labels[recipient.genesis]} has no account in this token: enter one. ` : ''}
              {recipient && autoTo.address && payTo === autoTo.address ? `${labels[recipient.genesis]}'s account in this token. ` : ''}
              {toInfo && toInfo !== 'missing' ? `Owner: ${labels[toInfo.owner] ?? shortId(toInfo.owner)}` : ''}
            </span>
          </label>
        </section>
        <section className="card">
          <h2>
            <span className="step">4</span>Review
          </h2>
          {words.length > 0 && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                The payment can be claimed in {words.length === 1 ? 'one way' : `${words.length} ways`}:
              </p>
              <ul className="words">
                {words.map((w, i) => (
                  <li key={i}>
                    <b>{i + 1}</b>
                    {w}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="stack spaced" style={{ gap: 8 }}>
            {problems.map((p, i) => (
              <div key={`p${i}`} className="note bad">
                {p}
              </div>
            ))}
            {warnings.map((p, i) => (
              <div key={`w${i}`} className="note warn">
                {p}
              </div>
            ))}
            {words.length > 0 && <div className="note">Times are checked against the block time. On a quiet test chain a new block can take a while, so a claim right at the time may wait for the next block.</div>}
          </div>
          {result.error && <div className="note bad spaced">{result.error}</div>}
          {result.ok && (
            <div className="note good spaced">
              Sent. Transaction {shortId(result.ok)}{' '}
              <button className="link" onClick={() => copyText(result.ok!)}>
                copy id
              </button>{' '}
              <button className="link" onClick={onSent}>
                see My contracts
              </button>
            </div>
          )}
          <div className="row spaced">
            <button className="primary" disabled={problems.length > 0 || busy} onClick={() => setConfirm(true)}>
              Review and send
            </button>
          </div>
        </section>
      </div>

      {confirm && built.bytes && amount && fromAccount && (
        <div className="modal-back" role="dialog" aria-modal="true">
          <div className="card modal">
            <h2>Send this contract?</h2>
            <p>
              <b>
                {formatAmount(amount, fromAccount.decimals)} {ticker}
              </b>{' '}
              leaves {fromAccount.name ?? shortId(fromAccount.address)} and is locked by these rules:
            </p>
            <ul className="words">
              {words.map((w, i) => (
                <li key={i}>
                  <b>{i + 1}</b>
                  {w}
                </li>
              ))}
            </ul>
            <p className="muted">The rules cannot be changed after sending. Condition {built.bytes.length} bytes, fingerprint {hexOfMemory(built.bytes.slice(0, 4))}.</p>
            {warnings.length > 0 && <div className="note warn">{warnings.length === 1 ? warnings[0] : `${warnings.length} warnings above: check them first.`}</div>}
            <div className="row spaced">
              <button className="primary" onClick={send} disabled={busy}>
                {busy ? 'Signing and sending...' : 'Sign and send'}
              </button>
              <button onClick={() => setConfirm(false)} disabled={busy}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ErrorAt({ text, pos }: { text: string; pos: number }) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = text.indexOf('\n', pos);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  return (
    <div className="err-at spaced">
      {line}
      {'\n'}
      {' '.repeat(Math.max(0, pos - lineStart))}^
    </div>
  );
}

function TemplateExplain({ template }: { template: Template }) {
  const text: Record<Template, string[]> = {
    return: ['The recipient claims any time before the date.', 'After the date only you can take it back. Nothing happens by itself: you take it back in My contracts.'],
    timelock: ['The recipient can claim only from the date on, for example a gift or a vesting payment.', 'Optional: you may cancel before that time, or take it back if they never claim.'],
    escrow: [
      'For a deal between two people with a third person both trust.',
      'The arbiter creates an escrow id first. After the deal, the arbiter says release (the recipient can claim) or refund (you can take it back).',
      'The arbiter can never take the payment. Add a fallback date so it comes back to you if the arbiter never decides.',
    ],
    blank: ['Each way is one set of rules that must all be true. The payment can be claimed by the first way that is true.', 'Mix blocks and code; the code view shows exactly what goes on chain.'],
  };
  return (
    <div className="note">
      {text[template].map((t, i) => (
        <p key={i} style={{ margin: i ? '6px 0 0' : 0 }}>
          {t}
        </p>
      ))}
    </div>
  );
}

function CodeHelp() {
  return (
    <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
      <div>
        <code>caller.genesis</code> who claims, <code>contract.genesis</code> who sent it
      </div>
      <div>
        <code>ledger.timestamp</code> block time, <code>ledger.height</code> block height
      </div>
      <div>
        <code>0x...</code> 64 hex digits (a genesis id), <code>123</code> a number, <code>date(2027-01-01T00:00Z)</code> a time
      </div>
      <div>
        <code>register(ADDRESS).owner</code>, <code>.value("field")</code>, <code>.modified</code> read a register
      </div>
      <div>
        <code>sk256(x)</code> <code>sk512(x)</code> hashes, <code>+ - * / %</code> math
      </div>
      <div>
        <code>== != &lt; &gt; &lt;= &gt;=</code> compare, <code>AND</code> / <code>OR</code> (one kind per bracket level), <code>// note</code>
      </div>
    </div>
  );
}
