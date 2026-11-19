import { useEffect, useMemo, useRef, useState } from 'react';
import { codeHash, codeRelease, decisionIds, describe, encode, escrow, newCode, parse, ParseError, print, returnIfUnclaimed, timeLock, toCondition, toWays, type Block, type Condition, type Way } from '@nexus-contracts/core/src';
import { hexOfMemory } from '../../../../wallet/src/lib/tritium';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import { accountFor, blockTime, codeBoxState, decisionState, reloadAccounts, sendContract, type DecisionState, type Person, type Session } from '../lib/chain';
import { decisionKey, fmtTime } from '../lib/status';
import { Builder } from './Builder';
import { saveCode } from '../lib/codes';
import { shareText } from '../lib/share';
import { copyText, errorText, formatAmount, inDays, parseAmount, pasteText, PersonInput, shortId, TimeInput } from './common';
import { t } from '../lib/i18n';

type Template = 'return' | 'timelock' | 'escrow' | 'code' | 'blank';

//a function, so the texts follow the language set at start
const templates = (): { id: Template; name: string; text: string }[] => [
  { id: 'return', name: t('Return if unclaimed'), text: t('They claim before a date, after it the payment comes back to you') },
  { id: 'timelock', name: t('Time-lock'), text: t('They can claim only from a date on') },
  { id: 'escrow', name: t('Escrow'), text: t('A person you both trust decides: release to them or refund to you') },
  { id: 'code', name: t('Release with a code'), text: t('They claim once you give them a code, else it comes back to you') },
  { id: 'blank', name: t('Blank'), text: t('Build your own rules with blocks or code') },
];


export function NewContract({ node, session, onSent }: { node: NexusNode; session: Session; onSent: () => void }) {
  const now = () => Math.floor(Date.now() / 1000);
  const [template, setTemplate] = useState<Template>('return');
  const [recipient, setRecipient] = useState<Person | null>(null);
  const [recipientText, setRecipientText] = useState('');
  const [deadline, setDeadline] = useState(() => inDays(7));
  const [unlock, setUnlock] = useState(() => inDays(30));
  const [cancelable, setCancelable] = useState(false);
  const [returnAfter, setReturnAfter] = useState(0);
  const [arbiter, setArbiter] = useState<Person | null>(null);
  const [arbiterText, setArbiterText] = useState('');
  const [escrowId, setEscrowId] = useState('');
  const [fallback, setFallback] = useState(0);
  const [releaseCode, setReleaseCode] = useState(() => newCode());
  const [codeBack, setCodeBack] = useState(() => inDays(14));
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
      return t('Pick who gets the payment');
    }
    if (recipient.genesis === session.genesis) {
      return t('The recipient is you');
    }
    if (template === 'escrow') {
      if (!arbiter) {
        return t('Pick the arbiter');
      }
      if (arbiter.genesis === session.genesis || arbiter.genesis === recipient.genesis) {
        return t('The arbiter must be a third person: with you or the recipient as arbiter, one side decides alone');
      }
      if (!/^[a-z0-9]{4,32}$/.test(escrowId)) {
        return t('The escrow id is 4 to 32 lower case letters or digits, as the arbiter gave it to you');
      }
    }
    return '';
  }, [template, recipient, arbiter, escrowId, session.genesis]);

  //the builder follows the template form until the user edits blocks or code; then the button resets it
  const [manual, setManual] = useState(false);
  const fillFromTemplate = () => {
    setManual(false);
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
      } else if (template === 'code') {
        c = codeRelease({ sender: me, recipient: recipient.genesis, hash: codeHash(releaseCode), takeBackFrom: codeBack });
      } else {
        c = escrow({ sender: me, recipient: recipient.genesis, arbiter: arbiter!.genesis, id: escrowId, fallback: fallback || undefined });
      }
      setWays(withCodes(toWays(c, decisionIds(arbiter ? [{ arbiter: arbiter.genesis, id: escrowId }] : [])), [[{ kind: 'secret', genesis: recipient.genesis, hash: Array.from(codeHash(releaseCode), (x) => x.toString(16).padStart(2, '0')).join(''), code: releaseCode }]]));
    } catch (e) {
      setResult({ error: errorText(e) });
    }
  };

  useEffect(() => {
    if (!manual && (template === 'blank' || !templateError)) {
      fillFromTemplate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, template, templateError, recipient, deadline, unlock, cancelable, returnAfter, arbiter, escrowId, fallback, releaseCode, codeBack]);

  //--- builder and console stay in step ---
  const known = useMemo(() => ways.flat().filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision').map((b) => ({ arbiter: b.arbiter, id: b.id })), [ways]);

  const codeOwners = useMemo(() => [...new Set(ways.flat().flatMap((b) => (b.kind === 'secret' && /^[0-9a-f]{64}$/.test(b.genesis) ? [b.genesis] : [])))], [ways]);
  const [boxes, setBoxes] = useState(new Map<string, boolean>());

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

  const userSetWays = (w: Way[]) => {
    setManual(true);
    setWays(w);
  };

  const onCode = (text: string) => {
    setManual(true);
    setCode(text);
    try {
      const c = parse(text);
      typing.current = true;
      setWaysRaw(withCodes(toWays(c, decisionIds(known)), ways));
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
    setPayTo('');
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
      const b = new Map<string, boolean>();
      for (const g of codeOwners) {
        b.set(g, (await codeBoxState(node, g).catch(() => ({ exists: true }))).exists);
      }
      const t = await blockTime(node).catch(() => 0);
      if (live) {
        setBoxes(b);
        setDecisions(m);
        setChainTime(t);
      }
    })();
    return () => {
      live = false;
    };
  }, [known, codeOwners, node]);

  //--- checks ---
  const labels = useMemo(() => {
    const l: Record<string, string> = { [session.genesis]: t('You') };
    for (const [g, n] of names) {
      l[g] = n;
    }
    if (recipient) {
      l[recipient.genesis] = recipient.username ?? l[recipient.genesis] ?? t('the recipient');
    }
    if (arbiter) {
      l[arbiter.genesis] = t('{name} (arbiter)', { name: arbiter.username ?? t('the arbiter') });
    }
    l[session.genesis] = t('You');
    return l;
  }, [names, recipient, arbiter, session.genesis]);

  //todo = still to fill in (shown calmly), problems = something is wrong; both block sending
  const todo: string[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  if (built.error) {
    todo.push(built.error === 'add at least one way to claim' ? t('Rules: pick a template above, or add blocks or code') : t('Rules: {error}', { error: t(built.error) }));
  }
  if (codeError) {
    problems.push(t('The code has an error: fix it or undo it'));
  }
  if (!fromAccount) {
    todo.push(t('Pick the account that pays'));
  }
  if (amount === null || amount === 0n) {
    todo.push(t('Enter the amount'));
  } else if (fromAccount && amount > fromAccount.balance) {
    problems.push(t('The amount is more than the account holds'));
  }
  if (autoTo.looking) {
    todo.push(t("Looking for the recipient's account in this token..."));
  } else if (!payTo.trim()) {
    todo.push(t('Enter the account the payment goes to'));
  } else if (toInfo === 'missing') {
    problems.push(t('The account it goes to was not found'));
  } else if (toInfo && fromAccount && toInfo.token !== fromAccount.token) {
    problems.push(t('The account it goes to holds another token'));
  }
  for (const g of codeOwners) {
    if (boxes.get(g) === false) {
      problems.push(t('{name} has no code box yet. They set it up once in My contracts ("Set up code box"); before that the chain would refuse every claim, the take back too.', { name: labels[g] ?? shortId(g) }));
    }
  }
  for (const k of known) {
    const d = decisions.get(decisionKey(k.arbiter, k.id));
    if (d && !d.exists) {
      problems.push(t('The arbiter has not created escrow "{id}" yet. Ask them to create it in the Arbiter tab first: a contract that reads a missing register can never be claimed, not even taken back.', { id: k.id }));
    } else if (d?.exists && d.owner !== k.arbiter) {
      problems.push(t('Escrow "{id}" now belongs to someone else', { id: k.id }));
    } else if (d?.exists && d.value !== 0) {
      warnings.push(t('Escrow "{id}" is already decided ({value}). Use a new escrow id for a new deal.', { id: k.id, value: d.value === 1 ? t('release') : d.value === 2 ? t('refund') : t('unknown value') }));
    }
  }
  //a claim goes into the claimer's own account: only the owner of "to" (claim) or you (take back) can ever use a way
  if (toInfo && toInfo !== 'missing' && built.condition) {
    ways.forEach((w, i) => {
      const who = w.filter((b): b is Extract<Block, { kind: 'who' }> => b.kind === 'who').map((b) => b.genesis);
      if (who.length && who.every((g) => g !== toInfo.owner && g !== session.genesis)) {
        warnings.push(t('Way {n} can never be used: only the owner of the receiving account or you can claim.', { n: i + 1 }));
      }
      if (!who.length) {
        warnings.push(t('Way {n} has no "who claims" block: the recipient and you can both use it.', { n: i + 1 }));
      }
    });
    const recipientWay = ways.some((w) => w.some((b) => b.kind === 'who' && b.genesis === toInfo.owner));
    const myWay = ways.some((w) => w.some((b) => b.kind === 'who' && b.genesis === session.genesis));
    if (!recipientWay && ways.every((w) => w.some((b) => b.kind === 'who'))) {
      warnings.push(t('The owner of the receiving account has no way to claim.'));
    }
    if (!myWay && ways.every((w) => w.some((b) => b.kind === 'who'))) {
      warnings.push(t('You have no way to take it back: if they never claim, it stays locked for good.'));
    }
  }
  if (built.bytes && /caller\.timestamp|contract\.timestamp/.test(code)) {
    warnings.push(t('caller.timestamp and contract.timestamp are written by whoever sends the transaction and can be set back in time. Use ledger.timestamp (block time) for deadlines.'));
  }
  const nowTime = chainTime || now();
  for (const b of ways.flat()) {
    if ((b.kind === 'before' || b.kind === 'from') && b.time <= nowTime) {
      warnings.push(b.kind === 'before' ? t('Before {time} is already past.', { time: fmtTime(b.time) }) : t('From {time} is already past.', { time: fmtTime(b.time) }));
    }
  }

  //the same contract, amount and account just sent: no second send by a double click
  const sendKey = built.bytes && amount ? `${hexOfMemory(built.bytes)}/${amount}/${payTo}/${from}` : '';
  const [sentKey, setSentKey] = useState('');
  if (sendKey && sendKey === sentKey) {
    problems.push(t('This exact contract was just sent. Change something to send another one.'));
  }

  const send = async () => {
    if (!built.bytes || !fromAccount || !amount) {
      return;
    }
    setBusy(true);
    setResult({});
    try {
      const txid = await sendContract(node, session, { from: fromAccount.address, to: payTo.trim(), amount, condition: built.bytes });
      for (const b of ways.flat()) {
        if (b.kind === 'secret' && b.code) {
          saveCode(session.genesis, b.hash, b.code);
        }
      }
      setResult({ ok: txid });
      setSentKey(sendKey);
      setConfirm(false);
      await reloadAccounts(node, session).catch(() => undefined);
    } catch (e) {
      setResult({ error: errorText(e) });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  //an edit after sending starts the next contract: the old "Sent" note would read as if this one was sent
  useEffect(() => {
    setResult((r) => (r.ok ? {} : r));
  }, [ways, amountText, payTo, from]);

  const startOver = () => {
    setWays([[]]);
    setAmountText('');
    setResult({});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const words = built.condition ? describe(built.condition, { labels, sender: session.genesis, time: fmtTime, t, me: session.genesis }) : [];
  const ticker = fromAccount?.ticker ?? 'NXS';

  return (
    <div className="stack">
      <section className="card">
        <h2>
          <span className="step">1</span>{t('Start from')}
        </h2>
        <div className="templates">
          {templates().map((tp) => (
            <button key={tp.id} className={template === tp.id ? 'on' : ''} onClick={() => setTemplate(tp.id)}>
              <b>{tp.name}</b>
              <small>{tp.text}</small>
            </button>
          ))}
        </div>
        <div className="grid2">
          <div>
            <label className="field">
              <span>{t('Who gets the payment')}</span>
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
                <span>{t('They can claim until')}</span>
                <TimeInput value={deadline} onChange={setDeadline} />
                <span className="hint">{t('After this the payment can only come back to you.')}</span>
              </label>
            )}
            {template === 'timelock' && (
              <>
                <label className="field">
                  <span>{t('They can claim from')}</span>
                  <TimeInput value={unlock} onChange={setUnlock} />
                </label>
                <label className="row field">
                  <input type="checkbox" checked={cancelable} onChange={(e) => setCancelable(e.target.checked)} />
                  <span style={{ fontSize: 13, color: 'var(--ink)' }}>{t('You can cancel it before that time')}</span>
                </label>
                <label className="field">
                  <span>{t('Comes back to you if still unclaimed from (optional)')}</span>
                  <div className="row">
                    <TimeInput value={returnAfter} onChange={setReturnAfter} />
                    {returnAfter > 0 && (
                      <button className="small" onClick={() => setReturnAfter(0)}>
                        {t('Clear')}
                      </button>
                    )}
                  </div>
                </label>
              </>
            )}
            {template === 'escrow' && (
              <>
                <label className="field">
                  <span>{t('Arbiter (decides; cannot take the payment)')}</span>
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
                  <span>{t('Escrow id')}</span>
                  <input value={escrowId} onChange={(e) => setEscrowId(e.target.value.toLowerCase().trim())} placeholder={t('from the arbiter, e.g. order42')} spellCheck={false} />
                  <span className="hint">{t('The arbiter creates it first in their Arbiter tab, then gives you the id.')}</span>
                </label>
                <label className="field">
                  <span>{t('Comes back to you without a decision from (optional)')}</span>
                  <div className="row">
                    <TimeInput value={fallback} onChange={setFallback} />
                    {fallback > 0 && (
                      <button className="small" onClick={() => setFallback(0)}>
                        {t('Clear')}
                      </button>
                    )}
                  </div>
                </label>
              </>
            )}
            {template === 'code' && (
              <>
                <label className="field">
                  <span>{t('The code you give them to release it')}</span>
                  <div className="row">
                    <b style={{ fontFamily: 'var(--mono)', fontSize: 16 }}>{releaseCode}</b>
                    <button className="small" onClick={() => copyText(releaseCode)}>
                      {t('Copy')}
                    </button>
                    <button className="small" onClick={() => setReleaseCode(newCode())}>
                      {t('New code')}
                    </button>
                  </div>
                  <span className="hint">{t('Only its fingerprint goes on chain. Give the code only when you want them to have the payment.')}</span>
                </label>
                <label className="field">
                  <span>{t('Comes back to you if not claimed, from')}</span>
                  <TimeInput value={codeBack} onChange={setCodeBack} />
                </label>
              </>
            )}
            {template === 'blank' && <p className="muted">{t('Start with one way for the recipient and add your own blocks below.')}</p>}
          </div>
          <div>
            <TemplateExplain template={template} />
            <div className="row spaced">
              {manual ? (
                <>
                  <button onClick={fillFromTemplate} disabled={!!templateError && template !== 'blank'}>
                    {t('Reset the rules to this template')}
                  </button>
                  <span className="muted">{t('You changed the rules by hand, so this form no longer changes them.')}</span>
                </>
              ) : templateError && template !== 'blank' ? (
                <span className="muted">{templateError}</span>
              ) : (
                <span className="ok">{t('The rules below follow this form. Change them further with blocks or code.')}</span>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid2">
        <section className="card">
          <h2>
            <span className="step">2</span>{t('Blocks')}
          </h2>
          <Builder node={node} session={session} ways={ways} setWays={userSetWays} names={names} onName={onName} />
        </section>
        <section className="card console">
          <h2>
            <span className="step">2</span>{t('Code')}
          </h2>
          <p className="muted" style={{ margin: '-6px 0 8px', fontSize: 12 }}>
            {t('Times in the code are UTC (date(...) without a zone is read as UTC). The blocks and the review show your local time.')}
          </p>
          <div className="bar">
            <button className="small" onClick={() => copyText(code)}>
              {t('Copy')}
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
              {t('Paste')}
            </button>
            <button className="small" disabled={!built.condition} onClick={() => built.condition && (setCode(print(built.condition)), setCodeError(null), (typing.current = false))}>
              {t('Tidy')}
            </button>
            <label className="row end muted" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={showBytes} onChange={(e) => setShowBytes(e.target.checked)} /> {t('bytes')}
            </label>
          </div>
          <textarea value={code} onChange={(e) => onCode(e.target.value)} spellCheck={false} aria-label={t('Contract code')} placeholder="caller.genesis == 0x... AND ledger.timestamp < date(2027-01-01T00:00Z)" />
          {codeError && (
            <div className="note bad spaced">
              {codeError.msg}
              {codeError.pos !== undefined && <ErrorAt text={code} pos={codeError.pos} />}
            </div>
          )}
          {!codeError && built.error && <div className="note warn spaced">{t(built.error)}</div>}
          {showBytes && built.bytes && (
            <>
              <pre>{Array.from(built.bytes, (b) => b.toString(16).padStart(2, '0')).join('')}</pre>
              <div className="row spaced">
                <span className="muted">{t('{n} bytes', { n: built.bytes.length })}</span>
                <button className="small" onClick={() => copyText(Array.from(built.bytes!, (b) => b.toString(16).padStart(2, '0')).join(''))}>
                  {t('Copy bytes')}
                </button>
              </div>
            </>
          )}
          <details className="spaced">
            <summary className="muted">{t('What you can write')}</summary>
            <CodeHelp />
          </details>
        </section>
      </div>

      <div className="grid2">
        <section className="card">
          <h2>
            <span className="step">3</span>{t('Payment')}
          </h2>
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
            <span>{t('Amount ({ticker})', { ticker })}</span>
            <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </label>
          <label className="field">
            <span>{t('Goes to account')}</span>
            <input value={payTo} onChange={(e) => setPayTo(e.target.value)} spellCheck={false} placeholder={t("the recipient's account address")} />
            <span className="hint">
              {autoTo.looking ? t('Looking for their account in this token...') + ' ' : ''}
              {recipient && !autoTo.looking && !autoTo.address ? t('{name} has no account in this token: enter one.', { name: labels[recipient.genesis]! }) + ' ' : ''}
              {recipient && autoTo.address && payTo === autoTo.address ? t("{name}'s account in this token.", { name: labels[recipient.genesis]! }) + ' ' : ''}
              {toInfo && toInfo !== 'missing' ? t('Owner: {name}', { name: labels[toInfo.owner] ?? shortId(toInfo.owner) }) : ''}
            </span>
          </label>
        </section>
        <section className="card">
          <h2>
            <span className="step">4</span>{t('Review')}
          </h2>
          {words.length > 0 && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {words.length === 1 ? t('The payment can be claimed in one way:') : t('The payment can be claimed in {n} ways:', { n: words.length })}
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
            {todo.length > 0 && (
              <div className="note">
                <b>{t('Still needed')}</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {todo.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
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
            {words.length > 0 && <div className="note">{t('Times are checked against the block time. On a quiet test chain a new block can take a while, so a claim right at the time may wait for the next block.')}</div>}
          </div>
          {result.error && <div className="note bad spaced">{result.error}</div>}
          {result.ok && (
            <div className="note good spaced">
              {t('Sent. Transaction {id}', { id: shortId(result.ok) })}{' '}
              <button className="link" onClick={() => copyText(shareText(result.ok!))} title={t('Copies a message for the recipient, so they can find this payment')}>
                {t('copy a message for the recipient')}
              </button>{' '}
              <button className="link" onClick={onSent}>
                {t('see My contracts')}
              </button>{' '}
              <button className="link" onClick={startOver}>
                {t('start a new contract')}
              </button>
            </div>
          )}
          <div className="row spaced">
            <button className="primary" disabled={problems.length > 0 || todo.length > 0 || busy} onClick={() => setConfirm(true)}>
              {t('Review and send')}
            </button>
          </div>
        </section>
      </div>

      {confirm && built.bytes && amount && fromAccount && (
        <div className="modal-back" role="dialog" aria-modal="true">
          <div className="card modal">
            <h2>{t('Send this contract?')}</h2>
            <p>
              <b>
                {formatAmount(amount, fromAccount.decimals)} {ticker}
              </b>{' '}
              {t('leaves {account} and is locked by these rules:', { account: fromAccount.name ?? shortId(fromAccount.address) })}
            </p>
            <ul className="words">
              {words.map((w, i) => (
                <li key={i}>
                  <b>{i + 1}</b>
                  {w}
                </li>
              ))}
            </ul>
            {ways.flat().some((b) => b.kind === 'secret' && b.code) && (
              <div className="note warn">
                {t('Keep the code')}{' '}
                {ways
                  .flat()
                  .filter((b): b is Extract<Block, { kind: 'secret' }> => b.kind === 'secret' && !!b.code)
                  .map((b) => (
                    <b key={b.hash} style={{ fontFamily: 'var(--mono)' }}>
                      {b.code}{' '}
                    </b>
                  ))}
                {t('safe. You give it to them when you want to release the payment. This module also keeps it on this computer under My contracts.')}
              </div>
            )}
            <p className="muted">{t('The rules cannot be changed after sending. Condition {n} bytes, fingerprint {fingerprint}.', { n: built.bytes.length, fingerprint: hexOfMemory(built.bytes.slice(0, 4)) })}</p>
            {warnings.length > 0 && <div className="note warn">{warnings.length === 1 ? warnings[0] : t('{n} warnings above: check them first.', { n: warnings.length })}</div>}
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
    return: [t('The recipient claims any time before the date.'), t('After the date only you can take it back. Nothing happens by itself: you take it back in My contracts.')],
    timelock: [t('The recipient can claim only from the date on, for example a gift or a vesting payment.'), t('Optional: you may cancel before that time, or take it back if they never claim.')],
    escrow: [
      t('For a deal between two people with a third person both trust.'),
      t('The arbiter creates an escrow id first. After the deal, the arbiter says release (the recipient can claim) or refund (you can take it back).'),
      t('The arbiter can never take the payment. Add a fallback date so it comes back to you if the arbiter never decides.'),
    ],
    code: [
      t('Like an escrow without a third person: you hold the release yourself, as a code.'),
      t('You pay now. When you are happy (goods arrived, job done) you give them the code, and they claim with it. If you never give it, the payment comes back to you from the date.'),
      t('They need a code box first: a one time setup in their My contracts.'),
    ],
    blank: [t('Each way is one set of rules that must all be true. The payment can be claimed by the first way that is true.'), t('Mix blocks and code; the code view shows exactly what goes on chain.')],
  };
  return (
    <div className="note">
      {text[template].map((line, i) => (
        <p key={i} style={{ margin: i ? '6px 0 0' : 0 }}>
          {line}
        </p>
      ))}
    </div>
  );
}

function CodeHelp() {
  return (
    <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
      <div>
        <code>caller.genesis</code> {t('who claims')}, <code>contract.genesis</code> {t('who sent it')}
      </div>
      <div>
        <code>ledger.timestamp</code> {t('block time')}, <code>ledger.height</code> {t('block height')}
      </div>
      <div>
        <code>0x...</code> {t('64 hex digits (a genesis id)')}, <code>123</code> {t('a number')}, <code>date(2027-01-01T00:00Z)</code> {t('a time')}
      </div>
      <div>
        <code>register(ADDRESS).owner</code>, <code>.value("field")</code>, <code>.modified</code> {t('read a register')}
      </div>
      <div>
        <code>sk256(x)</code> <code>sk512(x)</code> {t('hashes')}, <code>+ - * / %</code> {t('math')}
      </div>
      <div>
        <code>== != &lt; &gt; &lt;= &gt;=</code> {t('compare')}, <code>AND</code> / <code>OR</code> {t('(one kind per bracket level)')}, <code>// note</code>
      </div>
    </div>
  );
}

//the chain form holds only a code's hash: carry the code text over from blocks that had it
function withCodes(next: Way[], prev: Way[]): Way[] {
  const known = new Map(prev.flat().flatMap((b) => (b.kind === 'secret' && b.code ? [[b.hash, b.code] as const] : [])));
  return next.map((w) => w.map((b) => (b.kind === 'secret' && !b.code && known.has(b.hash) ? { ...b, code: known.get(b.hash) } : b)));
}
