// ============================================================
//  Mono Sheets — Settings panel (Phase 6, P20 per-workbook sync,
//  multi-user per Deployment/UI Plan v3; slimmed in P22)
//  General · Data & Sync · Import/Export.
//  P20: ctx is built for a specific workbookId — Data & Sync reads/
//  writes settings.syncByWorkbook[workbookId].
//  P22: Appearance moved to the global gear (shell.js); the AI
//  API-key UI moved to the profile menu (auth.js openApiKeyDialog) —
//  the key is per-user/per-browser, not per-workbook.
//  - when signed in, data always lives on the server under your
//    account (the old device/server toggle disappears — sharing and
//    roles need the server as the single source of truth).
// ============================================================
import { icon } from '../ui/icons.js';
import { Auth } from '../../auth.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function openSettings(ctx) {
  const { settings, save: saveSettings, wb, exportJson, importJson, migrateTo, syncNow, setupAuto, persist, onRename } = ctx;
  const sc = ctx.sync || settings.sync;
  const signedIn = !!Auth.user;

  const back = document.createElement('div'); back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal ms-settings"><h3>Settings — ${esc(wb.name)}</h3>
    <div class="set-sec">General</div>
    <div class="form-row"><label>Workbook name</label><input id="stName" value="${esc(wb.name)}"></div>
    <div class="set-sec">Data &amp; Sync <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">— this workbook only</span></div>
    ${signedIn
      ? `<div class="form-row"><label>Where your data lives</label><div class="note" style="margin-top:0">On the server, under your account (<b>${esc(Auth.user.username)}</b>) — that's what makes sharing and roles work. Workbooks you own can be shared from the Share button.</div></div>`
      : `<div class="form-row"><label>Where your data lives</label><div class="seg2"><button data-home="local" class="${settings.dataHome === 'local' ? 'on' : ''}">On this device</button><button data-home="server" class="${settings.dataHome === 'server' ? 'on' : ''}">On the server</button></div></div>
         <div class="form-row" id="srvRow" style="${settings.dataHome === 'server' ? '' : 'display:none'}"><label>Server URL (blank = this server)</label><input id="stServer" value="${esc(settings.serverUrl || '')}" placeholder="https://…"></div>`}
    <div class="form-row">
      <label>Pairing script</label>
      <div>
        <button class="btn btn-primary" id="getScript">Get Script</button>
        <a class="btn btn-ghost" href="/api/apps-script" download="MonoBridge.gs" style="text-decoration:none">${icon('download', { size: 13 })} .gs file</a>
        <span class="ai-test-out" id="getScriptOut"></span>
      </div>
    </div>
    <div id="pairSteps" style="display:none">
      <div class="note">
        <b>Pair this workbook with Google Sheets:</b>
        <ol style="margin:6px 0 0 18px;padding:0">
          <li>Open your Google Sheet ▸ <b>Extensions ▸ Apps Script</b>.</li>
          <li>Delete any code in the editor and <b>paste</b> (the script is already on your clipboard — Ctrl/Cmd+V).</li>
          <li>Click <b>Services (＋)</b> ▸ add <b>Google Sheets API</b> (optional — enables borders, fonts &amp; sizes).</li>
          <li><b>Deploy ▸ New deployment ▸ Web app.</b> Execute as: <b>Me</b>. Who has access: <b>Anyone</b>.</li>
          <li>Back in Mono, tick <b>"Sync this workbook with Google Sheets"</b> below.</li>
          <li>Paste the <b>/exec URL</b> into the "Apps Script /exec URL" box that appears, then click <b>Sync now</b>.</li>
        </ol>
      </div>
    </div>
    <div class="form-row"><label style="font-weight:600"><input type="checkbox" id="stSync" ${sc.enabled ? 'checked' : ''}> Sync this workbook with Google Sheets</label></div>
    <div id="syncBox" style="${sc.enabled ? '' : 'display:none'}">
      <div class="form-row"><label>Apps Script /exec URL</label><input id="stExec" value="${esc(sc.execUrl || '')}" placeholder="https://script.google.com/macros/s/…/exec"></div>
      <div class="form-grid">
        <div class="form-row"><label>Direction</label><select id="stDir"><option value="twoWay">Two-way</option><option value="pushOnly">Push only</option><option value="pullOnly">Pull only</option></select></div>
        <div class="form-row"><label>On conflict</label><select id="stConf"><option value="ask">Ask (keep local)</option><option value="localWins">Local wins</option><option value="remoteWins">Remote wins</option></select></div>
      </div>
      <div class="form-row"><label style="font-weight:400"><input type="checkbox" id="stAuto" ${sc.auto ? 'checked' : ''}> Auto-sync every ${sc.intervalSec}s while open</label></div>
      <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-primary" id="stSyncNow">${icon('refresh-cw', { size: 13 })} Sync now</button><span class="muted" id="stStatus" style="margin-left:8px">${sc.lastSyncAt ? 'Last synced ' + new Date(sc.lastSyncAt).toLocaleString() : 'Not synced yet'}</span></div>
      <div class="note">Values, formulas and basic formatting round-trip to Google Sheets. Treat the /exec URL as a secret — it's a key to your Google Sheet. It stays in this browser, is never shown to people you share with, and the server never logs it.</div>
    </div>
    <div class="set-sec">Import / Export</div>
    <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-ghost" id="stExport">${icon('download', { size: 13 })} Download .mono.json</button><label class="btn btn-ghost" style="cursor:pointer">${icon('upload', { size: 13 })} Import .mono.json<input type="file" id="stImport" accept=".json" style="display:none"></label></div>
    <div class="modal-actions"><button class="btn btn-primary" id="stClose">Done</button></div>
  </div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  $('#stDir').value = sc.direction; $('#stConf').value = sc.onConflict;
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  $('#stClose').onclick = () => back.remove();
  $('#stName').onchange = () => {
    const name = $('#stName').value;
    if (onRename) onRename(name);
    else { wb.name = name; window.dispatchEvent(new CustomEvent('mono:workspaceName', { detail: { name: wb.name } })); }
    if (persist) persist();
  };
  /* ---- data home (only when not signed in — offline/dev build) ---- */
  back.querySelectorAll('[data-home]').forEach((b) => b.onclick = async () => { back.querySelectorAll('[data-home]').forEach((x) => x.classList.toggle('on', x === b)); const row = $('#srvRow'); if (row) row.style.display = b.dataset.home === 'server' ? '' : 'none'; await migrateTo(b.dataset.home, $('#stServer')?.value); });
  const srv = $('#stServer'); if (srv) srv.onchange = async () => { if (settings.dataHome === 'server') await migrateTo('server', srv.value); };

  /* ---- Get Script (P22 #3): copy MonoBridge.gs + reveal pairing steps ---- */
  $('#getScript').onclick = async () => {
    const out = $('#getScriptOut');
    $('#pairSteps').style.display = '';   // always reveal the steps, even if copy fails
    try {
      const r = await fetch('/api/apps-script');
      if (!r.ok) throw new Error('fetch failed');
      const src = await r.text();
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(src); copied = true; } catch {}
      }
      if (!copied) {
        // Legacy fallback — clipboard API is blocked outside HTTPS/localhost
        const ta = document.createElement('textarea');
        ta.value = src; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        try { copied = document.execCommand('copy'); } catch {}
        ta.remove();
      }
      if (copied) { out.textContent = 'Script copied ✓'; out.style.color = 'var(--ui-green,#4F9D69)'; }
      else { out.textContent = 'Copy blocked — use the ".gs file" download instead'; out.style.color = 'var(--ui-red)'; }
    } catch {
      out.textContent = 'Could not reach the server — try the ".gs file" download';
      out.style.color = 'var(--ui-red)';
    }
  };

  $('#stSync').onchange = () => { sc.enabled = $('#stSync').checked; $('#syncBox').style.display = sc.enabled ? '' : 'none'; saveSettings(settings); setupAuto(); };
  $('#stExec').onchange = () => { sc.execUrl = $('#stExec').value.trim(); saveSettings(settings); setupAuto(); };
  $('#stDir').onchange = () => { sc.direction = $('#stDir').value; saveSettings(settings); };
  $('#stConf').onchange = () => { sc.onConflict = $('#stConf').value; saveSettings(settings); };
  $('#stAuto').onchange = () => { sc.auto = $('#stAuto').checked; saveSettings(settings); setupAuto(); };
  const NL = String.fromCharCode(10);   // status box shows multi-line warnings
  // The pull is chunked (one request per row band), so show it advancing.
  $('#stSyncNow').onclick = async () => {
    $('#stStatus').textContent = 'Syncing…';
    const onProgress = (p) => {
      if (p.phase === 'manifest') $('#stStatus').textContent = 'Reading sheet structure…';
      else if (p.total) $('#stStatus').textContent = 'Pulling data… ' + p.done + '/' + p.total + ' chunks';
    };
    try {
      const r = await syncNow({ onProgress });
      let msg = 'Synced ' + new Date().toLocaleTimeString();
      if (r && r.stats) msg += ' · ' + (r.stats.added + r.stats.updated) + ' cell(s) in';
      if (r && r.conflicts) msg += ' · ' + r.conflicts + ' conflict(s) kept local';
      // A sync that half-worked must say so. Losing borders or losing
      // anti-clobber protection silently is how a broken setup stays broken.
      if (r && r.warnings && r.warnings.length) msg += NL + '⚠ ' + r.warnings.join(NL + '⚠ ');
      $('#stStatus').textContent = msg;
      $('#stStatus').style.whiteSpace = 'pre-wrap';
    } catch (e) { $('#stStatus').textContent = 'Error: ' + (e && e.message || e); }
  };
  $('#stExport').onclick = () => exportJson();
  $('#stImport').onchange = (e) => { const f = e.target.files[0]; if (f) { importJson(f); back.remove(); } };
  if (ctx.focusExec) setTimeout(() => { const el = $('#stExec'); if (el) { el.focus(); el.select(); } }, 0);
}
