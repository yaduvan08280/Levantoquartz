// ============================================================
//  Mono — reusable right-side drawer/panel shell (U1 foundation)
//  Single slide-in drawer (~380px), dismissible via Esc or close
//  button, stacked above the grid but below modals. Every "side
//  panel" feature (view editor, link picker, AI copilot, automation
//  panel, comments, version history, preview drawer, etc.) renders
//  inside this one primitive, one at a time.
// ============================================================
const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let _current = null;

function ensureHost() {
  let host = document.getElementById('panelHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'panelHost';
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Open the shared drawer. Only one instance is ever mounted; opening a
 * new panel replaces whatever is currently shown.
 * @param {{title:string, width?:number, body:string, onClose?:Function, actions?:string}} opts
 * @returns {{el:HTMLElement, close:Function}}
 */
export function openPanel({ title = '', width = 400, body = '', onClose, actions = '' } = {}) {
  closePanel();
  const host = ensureHost();
  host.innerHTML = `
    <div class="panel-overlay" id="panelOverlay"></div>
    <aside class="panel" id="panelDrawer" style="width:${width}px" role="dialog" aria-label="${escH(title)}">
      <div class="panel-head">
        <div class="panel-title">${escH(title)}</div>
        ${actions ? `<div class="panel-head-actions">${actions}</div>` : ''}
        <button class="panel-close" id="panelClose" title="Close (Esc)">${'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}</button>
      </div>
      <div class="panel-body" id="panelBody">${body}</div>
    </aside>`;
  requestAnimationFrame(() => { host.querySelector('#panelDrawer')?.classList.add('open'); host.querySelector('#panelOverlay')?.classList.add('open'); });
  const close = () => {
    const drawer = host.querySelector('#panelDrawer'); const overlay = host.querySelector('#panelOverlay');
    drawer?.classList.remove('open'); overlay?.classList.remove('open');
    setTimeout(() => { if (_current && _current.token === token) { host.innerHTML = ''; _current = null; } }, 220);
    if (onClose) onClose();
  };
  const token = Symbol('panel');
  host.querySelector('#panelClose').addEventListener('click', close);
  host.querySelector('#panelOverlay').addEventListener('click', close);
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  _current = { token, close: () => { document.removeEventListener('keydown', escHandler); close(); }, el: host.querySelector('#panelDrawer') };
  return _current;
}

export function closePanel() { if (_current) { try { _current.close(); } catch {} _current = null; } }
export function panelBodyEl() { return document.getElementById('panelBody'); }
export function isPanelOpen() { return !!_current; }

export default { openPanel, closePanel, panelBodyEl, isPanelOpen };
