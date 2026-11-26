import { useEffect, useState, type FormEvent } from 'react';
import { api, getToken, setToken, whenSignedOut, ApiError } from './api';
import { Overview } from './pages/Overview';
import { Users } from './pages/Users';
import { Data } from './pages/Data';
import { Audit } from './pages/Audit';
import { Backup } from './pages/Backup';

type Page = 'overview' | 'users' | 'data' | 'audit' | 'backup';
const PAGES: { id: Page; label: string; chip: string }[] = [
  { id: 'overview', label: 'Overview', chip: 'OV' },
  { id: 'users', label: 'Users', chip: 'US' },
  { id: 'data', label: 'Raw data', chip: 'DT' },
  { id: 'audit', label: 'Change log', chip: 'LG' },
  { id: 'backup', label: 'Import & backup', chip: 'BK' }
];

function pageFromHash(): Page {
  const h = location.hash.replace(/^#\/?/, '').split('/')[0] as Page;
  return PAGES.some((p) => p.id === h) ? h : 'overview';
}

export function App() {
  const [me, setMe] = useState<{ username: string; display: string } | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [page, setPage] = useState<Page>(pageFromHash());

  useEffect(() => {
    whenSignedOut(() => setMe(null));
    const onHash = () => setPage(pageFromHash());
    addEventListener('hashchange', onHash);
    if (getToken()) {
      api('/me').then((r) => setMe(r.user)).catch(() => setToken(null)).finally(() => setChecking(false));
    }
    return () => removeEventListener('hashchange', onHash);
  }, []);

  if (checking) return <div className="center muted">Loading…</div>;
  if (!me) return <Login onDone={setMe} />;

  /* Leaving the data page with a save still in flight would lose it. */
  const go = async (p: Page) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.sheet');
    const w = frame?.contentWindow as any;
    if (w?.levantoFlush) {
      const clean = await w.levantoFlush().catch(() => false);
      if (!clean && !confirm('Some changes on this tab have not been saved. Leave anyway?')) return;
    }
    location.hash = '#/' + p;
  };

  const signOut = async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* already gone */ }
    setToken(null);
    setMe(null);
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><div className="mark">//</div><div><b>Levanto</b><span>Admin</span></div></div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={'nav' + (page === p.id ? ' on' : '')} onClick={() => go(p.id)}>
              <span className="chip">{p.chip}</span>{p.label}
            </button>
          ))}
        </nav>
        <div className="foot">
          <a className="nav" href="/" target="_blank" rel="noreferrer"><span className="chip">&#8599;</span>Open forms app</a>
          <div className="who"><b>{me.display}</b><span>{me.username}</span></div>
          <button className="nav" onClick={signOut}><span className="chip">&#8592;</span>Sign out</button>
        </div>
      </aside>
      <main className={'main' + (page === 'data' ? ' wide' : '')}>
        {page === 'overview' && <Overview go={go} />}
        {page === 'users' && <Users me={me.username} />}
        {page === 'data' && <Data />}
        {page === 'audit' && <Audit />}
        {page === 'backup' && <Backup />}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: (u: { username: string; display: string }) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api('/login', { method: 'POST', json: { username, password } });
      setToken(r.token);
      onDone({ username: r.user.username, display: r.user.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="brand dark"><div className="mark">//</div><div><b>Levanto</b><span>Admin</span></div></div>
        <h1>Sign in</h1>
        <p className="muted">Use your forms-app username. Only administrators can open this area.</p>
        {error && <div className="alert err">{error}</div>}
        <label>Username<input autoFocus autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
