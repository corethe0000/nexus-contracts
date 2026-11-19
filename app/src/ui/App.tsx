import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { routeLinksOutside } from '../../../../dex/app/src/lib/module';
import { makeNode, signIn, type Session } from '../lib/chain';
import { NewContract } from './NewContract';
import { MyContracts } from './MyContracts';
import { Arbiter } from './Arbiter';

type Tab = 'new' | 'mine' | 'arbiter';

export function App() {
  const node = useMemo(() => makeNode(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('new');
  const [waiting, setWaiting] = useState(0);

  useEffect(() => routeLinksOutside(), []);

  if (!session) {
    return <SignIn onIn={(s) => setSession(s)} node={node} />;
  }
  const test = session.net.testnet || session.net.private;
  return (
    <div className="app">
      <div className="top">
        <h1>Nexus Contracts</h1>
        <span className={`badge ${test ? 'test' : ''}`}>{session.net.private ? 'private chain' : session.net.testnet ? 'testnet' : 'mainnet'}</span>
        <div className="who">
          <span>
            Signed in as <b>{session.username}</b>
          </span>
          <button className="small" onClick={() => setSession(null)}>
            Sign out
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>
          New contract
        </button>
        <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
          My contracts{waiting > 0 && <span className="count">{waiting}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'arbiter'} className={tab === 'arbiter' ? 'on' : ''} onClick={() => setTab('arbiter')}>
          Arbiter
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
          <MyContracts node={node} session={session} active={tab === 'mine'} onWaiting={setWaiting} />
        </Guard>
      </div>
      <div hidden={tab !== 'arbiter'}>
        <Guard>
          <Arbiter node={node} session={session} active={tab === 'arbiter'} />
        </Guard>
      </div>
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
      <h2>Nexus Contracts</h2>
      <p className="muted">Lock a payment with your own rules: escrow, a time-lock or a payment that comes back if nobody claims it.</p>
      <label className="field">
        <span>Username</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span>PIN</span>
        <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      {error && <div className="note bad">{error}</div>}
      <div className="row spaced">
        <button className="primary" disabled={busy || !username || !password || !pin}>
          {busy ? 'Checking...' : 'Sign in'}
        </button>
      </div>
      <p className="muted spaced" style={{ fontSize: 12 }}>
        Contracts are signed here, in this module, because the wallet's core can only add an expiry to a payment. Your password and PIN stay in memory until you sign out or close the module.
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
          Something went wrong here: {this.state.error}{' '}
          <button className="small" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
