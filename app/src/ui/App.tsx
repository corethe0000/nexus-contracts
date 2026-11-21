import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { publishOverview } from '../lib/overview';
import { inWallet, routeLinksOutside } from '../../../../dex/app/src/lib/module';
import { makeNode, setUnlockPrompt, signIn, signInAs, unlock, type Session } from '../lib/chain';
import { onWalletGenesis, walletGenesis } from '../lib/walletUser';
import { t } from '../lib/i18n';
import { NewContract } from './NewContract';
import { MyContracts } from './MyContracts';
import { Arbiter } from './Arbiter';

type Tab = 'new' | 'mine' | 'arbiter';

export function App() {
  const node = useMemo(() => makeNode(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('new');
  const [picked, setPicked] = useState(false);
  const [waiting, setWaiting] = useState(0);
  //one place for a tab change the user asked for, so the auto-open below never fights them
  const choose = useCallback((to: Tab) => {
    setPicked(true);
    setTab(to);
  }, []);
  const wallet = useMemo(() => inWallet(), []);
  const [genesis, setGenesis] = useState(walletGenesis());
  const [openError, setOpenError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [ask, setAsk] = useState<{ s: Session; done: (ok: boolean) => void } | null>(null);
  //password and PIN live in the session object: re-render when they are entered or forgotten
  const [, setUnlocked] = useState(0);

  useEffect(() => routeLinksOutside(), []);
  useEffect(() => onWalletGenesis(setGenesis), []);

  //open on My contracts when there is something waiting to claim (e.g. the wallet's "payments to claim" sent the
  //user here), unless they have already chosen a tab themselves
  useEffect(() => {
    if (!picked && waiting > 0 && tab === 'new') {
      setTab('mine');
    }
  }, [picked, waiting, tab]);

  //in the wallet the module is the wallet's user and follows its login and logout
  useEffect(() => {
    if (!wallet) {
      return;
    }
    setSession(null);
    setOpenError('');
    if (!genesis) {
      return;
    }
    let live = true;
    signInAs(node, genesis)
      .then((s) => live && setSession(s))
      .catch((e) => live && setOpenError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [wallet, genesis, attempt, node]);

  useEffect(() => {
    setUnlockPrompt((s) => new Promise<boolean>((done) => setAsk({ s, done })));
    return () => setUnlockPrompt(null);
  }, []);

  const onWaiting = useCallback((n: number) => {
    setWaiting(n);
    publishOverview(n, t('contract payments are ready for you to claim'));
  }, []);

  if (!session) {
    if (!wallet) {
      return <SignIn onIn={(s) => setSession(s)} node={node} />;
    }
    if (!genesis) {
      return (
        <div className="card signin">
          <h2>{t('Nexus Contracts')}</h2>
          <p>{t('Log in to your wallet first. The module opens as the user logged in to the wallet.')}</p>
        </div>
      );
    }
    if (openError) {
      return (
        <div className="card signin">
          <h2>{t('Nexus Contracts')}</h2>
          <div className="note bad">{openError}</div>
          <div className="row spaced">
            <button className="primary" onClick={() => setAttempt((n) => n + 1)}>
              {t('Try again')}
            </button>
          </div>
        </div>
      );
    }
    return <Loading text={t('Opening your contracts...')} />;
  }
  const test = session.net.testnet || session.net.private;
  return (
    <div className="app">
      <div className="top">
        <h1>{t('Nexus Contracts')}</h1>
        <span className={`badge ${test ? 'test' : ''}`}>{session.net.private ? t('private chain') : session.net.testnet ? t('testnet') : t('mainnet')}</span>
        <div className="who">
          <span>
            {t('Signed in as')} <b>{session.username}</b>
          </span>
          {!wallet && (
            <button className="small" onClick={() => setSession(null)}>
              {t('Sign out')}
            </button>
          )}
          {wallet && session.who && (
            <button
              className="small"
              title={t('Forget the password and PIN; they are asked again for the next signature')}
              onClick={() => {
                session.who = undefined;
                setUnlocked((n) => n + 1);
              }}
            >
              {t('Lock')}
            </button>
          )}
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => choose('new')}>
          {t('New contract')}
        </button>
        <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => choose('mine')}>
          {t('My contracts')}{waiting > 0 && <span className="count">{waiting}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'arbiter'} className={tab === 'arbiter' ? 'on' : ''} onClick={() => choose('arbiter')}>
          {t('Arbiter')}
        </button>
      </div>
      {/* kept mounted so a half-built contract survives a look at another tab */}
      <div hidden={tab !== 'new'}>
        <Guard>
          <NewContract node={node} session={session} onSent={() => setTab('mine')} />
        </Guard>
      </div>
      <div hidden={tab !== 'mine'}>
        <Guard>
          <MyContracts node={node} session={session} active={tab === 'mine'} onWaiting={onWaiting} />
        </Guard>
      </div>
      <div hidden={tab !== 'arbiter'}>
        <Guard>
          <Arbiter node={node} session={session} active={tab === 'arbiter'} />
        </Guard>
      </div>
      {ask && (
        <UnlockDialog
          session={ask.s}
          onDone={(ok) => {
            ask.done(ok);
            setAsk(null);
            setUnlocked((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

export function Loading({ text }: { text: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      <div>{text}</div>
    </div>
  );
}

/** Password and PIN for the wallet's user, asked the first time something is signed */
function UnlockDialog({ session, onDone }: { session: Session; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await unlock(session, password, pin);
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-shade">
      <form className="card dialog" onSubmit={go}>
        <h2>{t('Password and PIN needed')}</h2>
        <p className="muted">
          {t('Contracts are built and signed in this module, so it needs the password and PIN of {user} once. They stay in memory until you lock it or close the module.', { user: session.username })}
        </p>
        <fieldset disabled={busy} className="plain">
          <label className="field">
            <span>{t('Password')}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          </label>
          <label className="field">
            <span>{t('PIN')}</span>
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </label>
          {error && <div className="note bad">{error}</div>}
          <div className="row spaced">
            <button className="primary" disabled={!password || !pin}>
              {busy ? t('Checking...') : t('Sign')}
            </button>
            <button type="button" onClick={() => onDone(false)}>
              {t('Cancel')}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

function SignIn({ node, onIn }: { node: ReturnType<typeof makeNode>; onIn: (s: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onIn(await signIn(node, username, password, pin));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card signin" onSubmit={go}>
      <h2>{t('Nexus Contracts')}</h2>
      <p className="muted">{t('Lock a payment with your own rules: escrow, a time-lock or a payment that comes back if nobody claims it.')}</p>
      <label className="field">
        <span>{t('Username')}</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label className="field">
        <span>{t('Password')}</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span>{t('PIN')}</span>
        <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      {error && <div className="note bad">{error}</div>}
      <div className="row spaced">
        <button className="primary" disabled={busy || !username || !password || !pin}>
          {busy ? t('Checking...') : t('Sign in')}
        </button>
      </div>
      <p className="muted spaced" style={{ fontSize: 12 }}>
        {t("Contracts are signed here, in this module, because the wallet's core can only add an expiry to a payment. Your password and PIN stay in memory until you sign out or close the module.")}
      </p>
    </form>
  );
}

//an unexpected error in one tab shows a message there instead of a blank module
class Guard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="note bad">
          {t('Something went wrong here: {error}', { error: this.state.error })}{' '}
          <button className="small" onClick={() => this.setState({ error: null })}>
            {t('Try again')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
