import { useEffect, useRef, useState } from 'react';
import { api, type TabInfo } from '../api';

export function Data() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);

  const load = () => api('/tabs').then((r) => {
    setTabs(r.tabs);
    setActive((cur) => {
      if (cur !== null && r.tabs.some((t: TabInfo) => t.id === cur)) return cur;
      const wanted = Number(location.hash.split('/')[2]);
      const first = r.tabs.find((t: TabInfo) => t.id === wanted) || r.tabs.find((t: TabInfo) => !t.hidden) || r.tabs[0];
      return first ? first.id : null;
    });
  }).catch((e) => setError(e.message));

  useEffect(() => {
    void load();
    /* Row counts move as operators work; keep the list honest. */
    const onMsg = (e: MessageEvent) => { if (e.origin === location.origin && e.data?.type === 'levanto:saved') void load(); };
    addEventListener('message', onMsg);
    const t = setInterval(load, 30000);
    return () => { removeEventListener('message', onMsg); clearInterval(t); };
  }, []);

  const open = async (id: number) => {
    if (id === active) return;
    const w = frame.current?.contentWindow as any;
    if (w?.levantoFlush) {
      const clean = await w.levantoFlush().catch(() => false);
      if (!clean && !confirm('Some changes on this tab have not been saved. Switch anyway?')) return;
    }
    history.replaceState(null, '', '#/data/' + id);
    setActive(id);
  };

  const shown = tabs.filter((t) => (showHidden || !t.hidden || t.id === active) &&
    (!filter || t.name.toLowerCase().includes(filter.toLowerCase())));
  const hiddenCount = tabs.filter((t) => t.hidden).length;

  return (
    <div className="data">
      <div className="tablist">
        <div className="tl-head">
          <h1>Raw data</h1>
          <input className="search" placeholder="Find a tab" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {error && <div className="alert err">{error}</div>}
        <div className="tl-scroll">
          {shown.map((t) => (
            <button key={t.id} className={'tl' + (t.id === active ? ' on' : '') + (t.hidden ? ' dim' : '')} onClick={() => open(t.id)}>
              <span>{t.name}</span><i>{Math.max(t.rows - 1, 0).toLocaleString('en-IN')}</i>
            </button>
          ))}
        </div>
        {hiddenCount > 0 && (
          <label className="tl-foot"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show {hiddenCount} hidden tabs</label>
        )}
      </div>
      <div className="sheetwrap">
        {active !== null
          ? <iframe ref={frame} className="sheet" key={active} title="Raw data" src={'/admin/sheets/index.html?tab=' + active} />
          : <div className="center muted">No data yet. Import the Google Sheets workbook from "Import &amp; backup".</div>}
      </div>
    </div>
  );
}
