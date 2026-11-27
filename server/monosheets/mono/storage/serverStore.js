// ============================================================
//  Mono storage — ServerStore (Phase 6; multi-user per Plan v3)
//  Talks to /api/workbook* with optimistic concurrency:
//  - every load remembers {version, role, meta} per workbook
//  - every save sends baseVersion; a 409 NEVER overwrites — the
//    caller gets {ok:false, code:'conflict'} and shows the reload
//    modal (UI plan §8). 403 → {code:'forbidden'} (revoked/role),
//    401 → {code:'auth'} (the auth interceptor shows re-login).
//  Sharing + comments ride the same client (owner-only routes are
//  enforced server-side; these methods just surface the results).
// ============================================================
export class ServerStore {
  constructor(base = '') {
    this.base = base || ''; this._meta = new Map(); this._queue = new Map(); this._watch = new Map();
    // Names this tab on every write, so the event stream can tell our own
    // writes (already applied here) from everybody else's.
    this.clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  label() { return 'On the server'; }

  meta(id) { return this._meta.get(String(id)) || null; }
  roleOf(id) { const m = this.meta(id); return m ? m.role : null; }
  versionOf(id) { const m = this.meta(id); return m ? m.version : null; }
  setVersion(id, v) { const m = this._meta.get(String(id)); if (m) m.version = v; }
  /** Move forward only: a late event must not drag the version back. */
  bumpVersion(id, v) { const m = this._meta.get(String(id)); if (m && !(m.version >= v)) m.version = v; }

  /** Listen for other people's writes to a workbook. cb gets the server's
   *  event ({v, patch} or {v, reload}) or {resync:true} when this tab turns
   *  out to be behind. Returns a function that stops listening.
   *
   *  All watched workbooks share ONE stream: a stream each would use up the
   *  browser's six connections per site and leave saves queued behind them. */
  watch(id, cb) {
    id = String(id);
    this._watch.set(id, cb); this._rewatch();
    return () => { if (this._watch.get(id) === cb) { this._watch.delete(id); this._rewatch(); } };
  }
  _rewatch() {
    // Debounced: a reload stops watching and starts again in the same breath.
    clearTimeout(this._rw);
    this._rw = setTimeout(() => {
      if (this._es) { this._es.close(); this._es = null; }
      if (!this._watch.size || typeof EventSource !== 'function') return;
      const ids = [...this._watch.keys()].map(encodeURIComponent).join(',');
      const es = this._es = new EventSource(this.base + '/api/live?ids=' + ids);
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        const cb = this._watch.get(String(ev.id)); if (!cb) return;
        if (ev.hello) {
          // Sent on every (re)connect. If the server is ahead of us, give any
          // write of our own a moment to be answered, then check again.
          const behind = () => !(this.versionOf(ev.id) >= ev.v);
          if (behind()) setTimeout(() => { if (behind() && this._watch.get(String(ev.id)) === cb) cb({ resync: true }); }, 1500);
          return;
        }
        if (ev.from !== this.clientId) cb(ev);
      };
    }, 50);
  }

  /* One write per workbook at a time. Every write sends baseVersion, and the
     version only moves when a response comes back - so a second write that
     leaves while the first is still travelling carries the same baseVersion.
     For a full save that means a false 409 ("someone else saved", when the
     someone else was this tab); for anything, it means writes that can land
     out of order. Queued here, each write reads the version the one before it
     left behind. Per workbook, so a slow save of one never holds up another. */
  _serial(id, fn) {
    const key = String(id);
    const run = (this._queue.get(key) || Promise.resolve()).then(fn, fn);
    this._queue.set(key, run);
    run.finally(() => { if (this._queue.get(key) === run) this._queue.delete(key); }).catch(() => {});
    return run;
  }

  async load(id = 'default') {
    try {
      const r = await fetch(this.base + '/api/workbook/' + encodeURIComponent(id));
      if (!r.ok) {
        this._meta.delete(String(id));
        if (r.status === 403) return { __denied: true };
        return null;
      }
      const j = await r.json();
      if (!j.ok) return null;
      this._meta.set(String(id), { version: j.version, role: j.role, ...(j.meta || {}) });
      return j.workbook || null;
    } catch { return null; }
  }

  /** @returns {{ok:boolean, code?:'conflict'|'forbidden'|'auth'|'net', version?:number, detail?:string}} */
  save(id = 'default', json) { return this._serial(id, () => this._save(id, json)); }
  async _save(id, json) {
    try {
      const body = { workbook: json, baseVersion: this.versionOf(id) };
      const text = JSON.stringify(body);
      // A big workbook is enormously repetitive (the same border on every
      // cell, the same column of codes), so it compresses by ~14x. Without
      // this a two-lakh-row workbook is ~108 MB on the wire and is rejected
      // outright; gzipped it is single-digit MB. The server inflates it
      // transparently, and we fall back to plain JSON wherever
      // CompressionStream is unavailable.
      const { payload, headers } = await maybeGzip(text);
      headers['X-Mono-Client'] = this.clientId;
      const r = await fetch(this.base + '/api/workbook/' + encodeURIComponent(id), {
        method: 'PUT', headers, body: payload,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { this.bumpVersion(id, j.version); return { ok: true, version: j.version }; }
      if (r.status === 409) return { ok: false, code: 'conflict', version: j.version };
      if (r.status === 403) return { ok: false, code: 'forbidden', detail: j.detail || j.error };
      if (r.status === 401) return { ok: false, code: 'auth' };
      return { ok: false, code: 'net' };
    } catch { return { ok: false, code: 'net' }; }
  }

  /** Incremental save. Returns code 'unpatchable' when the server cannot apply
   *  the delta exactly, and the caller resends the whole workbook. */
  patch(id = 'default', patch) { return this._serial(id, () => this._patch(id, patch)); }
  async _patch(id, patch) {
    try {
      const base = this.versionOf(id);
      if (base == null) return { ok: false, code: 'unpatchable' };   // never loaded/saved: nothing to patch
      const text = JSON.stringify({ patch, baseVersion: base });
      const { payload, headers } = await maybeGzip(text);
      headers['X-Mono-Client'] = this.clientId;
      const r = await fetch(this.base + '/api/workbook/' + encodeURIComponent(id), {
        method: 'PATCH', headers, body: payload,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { this.bumpVersion(id, j.version); return { ok: true, version: j.version }; }
      if (r.status === 409) return { ok: false, code: 'conflict', version: j.version };
      if (r.status === 422) return { ok: false, code: 'unpatchable', detail: j.detail };
      if (r.status === 403) return { ok: false, code: 'forbidden', detail: j.detail || j.error };
      if (r.status === 401) return { ok: false, code: 'auth' };
      return { ok: false, code: 'net' };
    } catch { return { ok: false, code: 'net' }; }
  }

  async list() {
    try {
      const j = await (await fetch(this.base + '/api/workbooks')).json();
      return j.workbooks || [];
    } catch { return []; }
  }

  async remove(id = 'default') {
    try { const r = await fetch(this.base + '/api/workbook/' + encodeURIComponent(id), { method: 'DELETE' }); return r.ok; }
    catch { return false; }
  }

  /* ---- sharing (owner-only server-side) ---- */
  async acl(id) { try { const r = await fetch(`${this.base}/api/workbook/${encodeURIComponent(id)}/acl`); return r.ok ? await r.json() : null; } catch { return null; } }
  async share(id, username, role) {
    try {
      const r = await fetch(`${this.base}/api/workbook/${encodeURIComponent(id)}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, role }) });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    } catch { return { status: 0, ok: false }; }
  }
  async revoke(id, username) {
    try { const r = await fetch(`${this.base}/api/workbook/${encodeURIComponent(id)}/share/${encodeURIComponent(username)}`, { method: 'DELETE' }); return r.ok; }
    catch { return false; }
  }
  async checkUser(username) {
    try { return await (await fetch(this.base + '/api/users/check?u=' + encodeURIComponent(username))).json(); }
    catch { return { ok: false, exists: false }; }
  }

  /* ---- comments (server-mutated; works for the Commenter role) ---- */
  addComment(id, args) { return this._serial(id, () => this._addComment(id, args)); }
  async _addComment(id, { sheetId, r, c, text }) {
    try {
      const res = await fetch(`${this.base}/api/workbook/${encodeURIComponent(id)}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mono-Client': this.clientId },
        body: JSON.stringify({ sheetId, r, c, text, baseVersion: this.versionOf(id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { this.bumpVersion(id, j.version); return { ok: true, comment: j.comment }; }
      if (res.status === 409) return { ok: false, code: 'conflict' };
      if (res.status === 403) return { ok: false, code: 'forbidden' };
      return { ok: false, code: 'net' };
    } catch { return { ok: false, code: 'net' }; }
  }
  deleteComment(id, args) { return this._serial(id, () => this._deleteComment(id, args)); }
  async _deleteComment(id, { sheetId, r, c, cid }) {
    try {
      const res = await fetch(`${this.base}/api/workbook/${encodeURIComponent(id)}/comments/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mono-Client': this.clientId },
        body: JSON.stringify({ sheetId, r, c, cid }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { this.bumpVersion(id, j.version); return { ok: true }; }
      if (res.status === 403) return { ok: false, code: 'forbidden' };
      return { ok: false, code: 'net' };
    } catch { return { ok: false, code: 'net' }; }
  }
}

// Gzip a request body when it is big enough to be worth it. Returns the body
// and the headers to send with it. Never throws: if anything about the
// compression path is unavailable, the caller just sends plain JSON.
const GZIP_MIN_BYTES = 256 * 1024;

async function maybeGzip(text) {
  const plain = { payload: text, headers: { 'Content-Type': 'application/json' } };
  try {
    if (text.length < GZIP_MIN_BYTES) return plain;
    if (typeof CompressionStream !== 'function' || typeof Blob !== 'function') return plain;
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    if (!buf || !buf.byteLength) return plain;
    return { payload: buf, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } };
  } catch {
    return plain;
  }
}

