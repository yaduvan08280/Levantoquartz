import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Raw data is Mono Sheets itself, running in a frame against the live
 * database. This page only hands it the admin's sign-in first.
 */
export function Data() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/sheets-session', { method: 'POST' }).then(() => setReady(true)).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="center"><div className="alert err">{error}</div></div>;
  if (!ready) return <div className="center muted">Opening the data sheets…</div>;
  return <iframe className="sheet" title="Raw data" src="/sheets/" />;
}
