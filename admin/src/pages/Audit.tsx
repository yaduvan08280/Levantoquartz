import { useEffect, useState } from 'react';
import { api, type AuditEntry } from '../api';

const LABEL: Record<string, string> = {
  'data.edit': 'Cell edited', 'data.rows': 'Rows changed', 'data.bulk': 'Bulk edit', 'user.create': 'User added',
  'user.update': 'User changed', 'user.delete': 'User deleted', 'tab.create': 'Tab added', 'tab.update': 'Tab changed',
  import: 'Data imported', reload: 'Data reloaded'
};

function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function describe(e: AuditEntry) {
  if (e.action === 'data.edit') {
    return <><b>{e.tab}</b> {colLetter(e.col_no || 0)}{e.row_no}: <del>{e.old_val || '(empty)'}</del> &rarr; <ins>{e.new_val || '(empty)'}</ins></>;
  }
  if (e.action === 'data.rows') {
    const d = e.detail || {};
    return <><b>{e.tab}</b> {d.note || (d.inserted ? d.inserted + ' row(s) inserted at row ' + e.row_no : (d.deleted || 0) + ' row(s) deleted from row ' + e.row_no)}</>;
  }
  if (e.action === 'data.bulk') return <><b>{e.tab}</b> {e.detail?.cells} cells changed in one go</>;
  if (e.action.startsWith('user.')) {
    const { username, ...rest } = e.detail || {};
    const bits = Object.keys(rest).map((k) => k + (rest[k] === true || rest[k] === 'changed' ? '' : ': ' + String(rest[k])));
    return <><b>{username}</b>{bits.length ? ' — ' + bits.join(', ') : ''}</>;
  }
  if (e.action === 'import') return <>{e.detail?.file} — {(e.detail?.tabs || []).length} tabs</>;
  return <>{e.tab || ''}</>;
}

export function Audit() {
  const [list, setList] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const more = async (reset = false) => {
    setBusy(true);
    try {
      const before = !reset && list.length ? '&before=' + list[list.length - 1].id : '';
      const r = await api('/audit?limit=200' + before);
      setList(reset ? r.entries : list.concat(r.entries));
      setDone(r.entries.length < 200);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { void more(true); }, []);

  return (
    <>
      <header className="head">
        <div><h1>Change log</h1><p className="muted">Every change made from this admin panel. Entries made by operators are in the "App Submission Log" tab under Raw data.</p></div>
        <button className="btn" onClick={() => more(true)} disabled={busy}>Refresh</button>
      </header>
      {error && <div className="alert err">{error}</div>}
      <section className="card">
        <table className="tbl">
          <thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 110 }}>Who</th><th style={{ width: 130 }}>What</th><th>Detail</th></tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id}>
                <td className="num">{new Date(e.at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                <td>{e.actor}</td><td>{LABEL[e.action] || e.action}</td><td className="wrap">{describe(e)}</td>
              </tr>
            ))}
            {!list.length && !busy && <tr><td colSpan={4} className="muted pad">No changes recorded yet.</td></tr>}
          </tbody>
        </table>
      </section>
      {!done && list.length > 0 && <button className="btn" onClick={() => more()} disabled={busy}>Show older</button>}
    </>
  );
}
