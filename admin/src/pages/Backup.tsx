import { useRef, useState } from 'react';
import { api, getToken } from '../api';

export function Backup() {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState<File | null>(null);
  const [book, setBook] = useState('newbase');
  const bookName = book === 'newbase' ? 'New Base' : 'Domestic Marketing';

  const download = async () => {
    setBusy('export'); setMsg(null);
    try {
      const res = await fetch('/api/admin/export?book=' + book, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('The backup could not be made (HTTP ' + res.status + ').');
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'levanto-data.xlsx';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } finally { setBusy(''); }
  };

  const doImport = async () => {
    if (!picked) return;
    setBusy('import'); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', picked);
      const r = await api('/import?book=' + book, { method: 'POST', body: fd });
      const rows = r.tabs.reduce((n: number, t: any) => n + t.rows, 0);
      setMsg({ kind: 'ok', text: 'Imported ' + r.tabs.length + ' tabs, ' + rows.toLocaleString('en-IN') + ' rows into ' + bookName + '.' });
      setPicked(null); setTyped('');
      if (file.current) file.current.value = '';
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } finally { setBusy(''); }
  };

  const reload = async () => {
    setBusy('reload'); setMsg(null);
    try { await api('/reload', { method: 'POST' }); setMsg({ kind: 'ok', text: 'Data reloaded from the database.' }); }
    catch (e: any) { setMsg({ kind: 'err', text: e.message }); } finally { setBusy(''); }
  };

  return (
    <>
      <header className="head"><div><h1>Import &amp; backup</h1><p className="muted">Move data in from Google Sheets, and take copies out.</p></div></header>
      {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}

      <section className="card pad">
        <h2>Workbook</h2>
        <p className="muted">Each app keeps its own. Backup and import below act on the one chosen here.</p>
        <div className="seg">
          <button className={book === 'newbase' ? 'on' : ''} onClick={() => { setBook('newbase'); setPicked(null); setTyped(''); }}>New Base (production)</button>
          <button className={book === 'marketing' ? 'on' : ''} onClick={() => { setBook('marketing'); setPicked(null); setTyped(''); }}>Domestic Marketing</button>
        </div>
      </section>

      <section className="card pad">
        <h2>Download a backup</h2>
        <p className="muted">Every tab of {bookName} as one Excel workbook, exactly as it is now. Opens in Excel or Google Sheets.</p>
        <button className="btn primary" onClick={download} disabled={!!busy}>{busy === 'export' ? 'Preparing…' : 'Download .xlsx'}</button>
      </section>

      <section className="card pad danger">
        <h2>Import from Google Sheets</h2>
        <p className="muted">
          In the "{bookName}" spreadsheet choose <b>File &rarr; Download &rarr; Microsoft Excel (.xlsx)</b> and pick that file here.
          Every tab of {bookName} is <b>replaced</b> by the file's contents, its user list included — anything entered here
          since the file was downloaded is lost. The other workbook is not touched. Download a backup first.
        </p>
        <input ref={file} type="file" accept=".xlsx" onChange={(e) => { setPicked(e.target.files?.[0] || null); setTyped(''); }} />
        {picked && (
          <div className="confirm">
            <label>Type <b>REPLACE</b> to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="REPLACE" />
            </label>
            <button className="btn bad" disabled={typed !== 'REPLACE' || !!busy} onClick={doImport}>
              {busy === 'import' ? 'Importing…' : 'Replace ' + bookName + ' with ' + picked.name}
            </button>
          </div>
        )}
      </section>

      <section className="card pad">
        <h2>Reload from the database</h2>
        <p className="muted">Only needed if someone changed the database directly, outside this app.</p>
        <button className="btn" onClick={reload} disabled={!!busy}>{busy === 'reload' ? 'Reloading…' : 'Reload'}</button>
      </section>
    </>
  );
}
