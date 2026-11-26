import { useEffect, useState } from 'react';
import { api } from '../api';

export function Overview({ go }: { go: (p: any) => void }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/overview').then(setD).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="alert err">{error}</div>;
  if (!d) return <div className="muted">Loading…</div>;
  const n = (v: number) => v.toLocaleString('en-IN');
  return (
    <>
      <header className="head"><div><h1>Overview</h1><p className="muted">Levanto Quartz production control</p></div></header>
      <div className="tiles">
        <button className="tile" onClick={() => go('audit')}>
          <span>Entries today</span><b>{n(d.entriesToday)}</b>
          <i>{d.lastEntry ? 'Last: ' + d.lastEntry : 'Nothing entered yet today'}</i>
        </button>
        <button className="tile" onClick={() => go('users')}>
          <span>Users</span><b>{d.users.active}</b>
          <i>{d.users.total - d.users.active} inactive · {d.users.admins} admin{d.users.admins === 1 ? '' : 's'}</i>
        </button>
        <button className="tile" onClick={() => go('data')}>
          <span>Data</span><b>{n(d.rows)}</b>
          <i>rows across {d.tabs} tabs</i>
        </button>
        <div className="tile flat">
          <span>Telegram alerts</span><b className={d.telegram === 'connected' ? 'good' : 'warn'}>{d.telegram === 'connected' ? 'On' : 'Off'}</b>
          <i>{d.telegram === 'connected' ? 'Bot connected' : 'Set the bot up from Notifications in the forms app'}</i>
        </div>
      </div>
      <section className="card pad">
        <h2>Background jobs</h2>
        {d.jobs.length === 0
          ? <p className="muted">None running. The grade-alert scan and the Telegram check start themselves when an admin opens Notifications in the forms app.</p>
          : <table className="tbl"><thead><tr><th>Job</th><th>Runs</th></tr></thead><tbody>
              {d.jobs.map((j: any) => <tr key={j.handler}><td>{j.handler === 'alertScan' ? 'Grade-alert scan' : j.handler === 'telegramPoll' ? 'Telegram check' : j.handler}</td><td>every {j.everyMinutes} min</td></tr>)}
            </tbody></table>}
      </section>
    </>
  );
}
