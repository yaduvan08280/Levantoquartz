// ============================================================
//  Mono — Google Sheets importer  [Unified Import v3 — chunked]
//  ------------------------------------------------------------
//  Pulls a workbook out of an Apps Script /exec deployment (via the
//  server proxy /api/sheet, which dodges CORS) and normalises it
//  into a SheetImage.
//
//  MonoBridge v5 hands the workbook over in pieces, which is the
//  only way a six-figure-row workbook can cross the wire at all:
//     1. GET ?action=manifest — sheet list, per-sheet formatting,
//        and a CHUNK PLAN of row bands.
//     2. GET ?action=chunk&… for each band, a couple at a time.
//     3. Stitch the bands back together.
//
//  Everything about step 2 assumes things WILL go wrong, because on
//  a workbook this size they do:
//   - every request is time-boxed, so a stalled band cannot wedge
//     the whole sync;
//   - failures are retried with exponential backoff and jitter, and
//     a failing sync automatically slows itself down rather than
//     hammering a script that is already struggling;
//   - if the bridge says a band was too big (`retryWith`), the band
//     is split and re-queued instead of the sync dying;
//   - if the bridge ran out of time mid-band (`partial`), the
//     remainder is queued and the work already done is kept;
//   - errors name the sheet and the row range, so a failure is
//     actionable instead of "sync failed".
//
//  A non-chunked v3 payload still works, so a sheet whose Apps Script
//  has not been updated yet keeps importing.
// ============================================================
import { emptyImage, emptySheetImage, normCellImage } from './sheetImage.js';

const START_LANES = 2;        // parallel chunk requests to begin with
const MAX_LANES = 4;          // Apps Script queues per user; the aim is FEWER,
                              // bigger requests, not more simultaneous ones
const ATTEMPTS = 4;           // total tries per request
const REQUEST_TIMEOUT_MS = 100000;   // just over the server's own 90s cap

// Band growth. The bridge hands back a deliberately conservative plan, because
// nobody can know up front how expensive a sheet's cells are to read: asking
// the Sheets API for a band returns Google's verbose format, which is far
// larger than what comes back to us. So we MEASURE - if a band came back
// quickly, the next one merges neighbouring bands and asks for more.
const BAND_TARGET_MS = 8000;  // a comfortable response time to aim at
const BAND_SLOW_MS = 20000;   // past this, stop growing and shrink back
const BAND_GROWTH = 1.4;      // climb gently: overshooting costs a dead request
const BAND_MAX_CELLS = 60000; // never grow past this, whatever the bridge allows

// Fetch + normalise. `fetchImpl` is injectable for tests.
// opts: { onProgress({done,total,phase,sheet,note}), concurrency, direct, timeoutMs, signal }
export async function fetchGoogleSheetImage(execUrl, fetchImpl = fetch, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
  const pacer = makePacer();
  const transport = makeTransport(opts);
  const report = (p) => { if (onProgress) onProgress(p); };

  report({ done: 0, total: 0, phase: 'manifest' });
  const manifest = await getJson(execUrl, { action: 'manifest' }, fetchImpl, opts, pacer, transport);

  // Old script (v1/v2/v3): the first response already IS the workbook.
  if (!manifest.chunked) {
    const image = payloadToImage(manifest);
    image.source.url = execUrl;
    return image;
  }

  const image = manifestToImage(manifest);
  if (manifest.reduced) image.reduced = true;
  if (manifest.warnings) image.warnings = manifest.warnings.slice();

  // A live queue, not a fixed list: a band can split or leave a
  // remainder, and those go back in.
  const queue = [];
  (manifest.sheets || []).forEach((tab, i) => {
    (tab.chunks || []).forEach((ch) => queue.push({ i, tab, start: ch.start, rows: ch.rows, cols: ch.cols }));
  });

  let total = queue.length;
  let done = 0;

  const planRows = queue.length ? queue[0].rows : 1;
  const cols = Math.max(1, queue.length ? (queue[0].cols || 1) : 1);
  // never ask for more cells than the bridge says one execution can take
  const allowed = (manifest.sheets || []).reduce((n, t) => Math.max(n, t.maxCellsPerChunk || 0), 0) || BAND_MAX_CELLS;
  const capCells = Math.min(allowed, BAND_MAX_CELLS);
  const maxRows = Math.max(planRows, Math.floor(capCells / cols));
  let targetRows = planRows;

  report({ done, total, phase: 'chunks' });

  const worker = async () => {
    for (;;) {
      if (opts.signal && opts.signal.aborted) throw new Error('Sync cancelled');
      const task = takeBand();
      if (!task) return;
      const band = `${task.tab.name} rows ${task.start + 1}-${task.start + task.rows}`;
      const startedAt = Date.now();

      let chunk;
      try {
        chunk = await getJson(execUrl, {
          action: 'chunk', sheet: task.tab.index, name: task.tab.name,
          start: task.start, rows: task.rows, cols: task.cols,
        }, fetchImpl, opts, pacer, transport);
      } catch (e) {
        throw new Error(`${band}: ${e.message}`);
      }

      // The bridge refused the band as too big and told us what fits.
      if (chunk.retryWith && chunk.retryWith.rows) {
        // Honour the size the bridge says it can manage, even if that is one
        // row. Subdivision terminates because each part is strictly smaller
        // than the band it replaces; a single row that still will not fit is
        // the one case we cannot help with.
        const size = Math.max(1, Math.min(chunk.retryWith.rows, task.rows - 1));
        if (task.rows <= 1 || size >= task.rows) {
          throw new Error(`${band}: ${chunk.error || 'band too large'} and it cannot be split further.`);
        }
        for (let s = task.start; s < task.start + task.rows; s += size) {
          // `fixed` is essential: without it takeBand() would merge these
          // pieces straight back into the band that was just refused, which
          // would be refused again - an infinite loop.
          queue.push({ ...task, start: s, rows: Math.min(size, task.start + task.rows - s), fixed: true });
          total += 1;
        }
        total -= 1;                       // this task is replaced, not completed
        report({ done, total, phase: 'chunks', sheet: task.tab.name, note: 'splitting a large band' });
        continue;
      }

      applyChunk(image.sheets[task.i], chunk);

      // Hand the band over the moment it lands. Google's own progressive
      // loading (patent US10061759B2) paints the viewport first and keeps the
      // sheet interactive while the rest streams in; waiting for the whole
      // workbook before showing anything is what left a blank grid behind
      // "Pulling data... 7/251".
      if (onChunk) {
        try { onChunk({ image, sheetIndex: task.i, sheet: image.sheets[task.i], chunk, done: done + 1, total }); }
        catch { /* a display hook must never break the pull */ }
      }

      // The bridge ran out of time mid-band; keep what it sent and
      // queue the rest rather than losing the whole band.
      if (chunk.partial && Number.isFinite(chunk.nextStart)) {
        const consumed = chunk.nextStart - task.start;
        const left = task.rows - consumed;
        if (consumed > 0 && left > 0) {
          queue.push({ ...task, start: chunk.nextStart, rows: left, fixed: true });
          total += 1;
        } else if (left > 0) {
          throw new Error(`${band}: the bridge made no progress on this band.`);
        }
      }

      grow(Date.now() - startedAt, task.rows);
      done += 1;
      report({ done, total, phase: 'chunks', sheet: task.tab.name });
    }
  };

  // Pull one band off the queue, absorbing the bands that follow it while they
  // are contiguous, on the same sheet, and still inside the current target.
  function takeBand() {
    const first = queue.shift();
    if (!first) return null;
    if (first.fixed) return first;          // came from a split: leave it alone
    let rows = first.rows;
    while (rows < targetRows && queue.length) {
      const next = queue[0];
      if (next.fixed) break;
      if (next.i !== first.i || next.start !== first.start + rows) break;
      if (rows + next.rows > maxRows) break;
      rows += next.rows;
      queue.shift();
      total -= 1;              // one request instead of two
    }
    return rows === first.rows ? first : { ...first, rows };
  }

  // Climb while responses stay quick; back off the moment they do not.
  function grow(ms, rows) {
    if (ms > BAND_SLOW_MS) { targetRows = Math.max(planRows, Math.floor(rows / 2)); return; }
    if (ms < BAND_TARGET_MS) targetRows = Math.min(maxRows, Math.ceil(Math.max(targetRows, rows) * BAND_GROWTH));
  }

  // Ramp up: start conservatively, add a lane after a run of clean responses,
  // and let the pacer's backoff handle the other direction. A big pull finds
  // its own ceiling instead of being stuck at whatever constant I guessed.
  const cap = Math.max(1, Math.min(opts.concurrency || MAX_LANES, MAX_LANES, total || 1));
  const running = new Set();
  const spawn = () => {
    const w = worker().finally(() => running.delete(w));
    running.add(w);
    return w;
  };
  for (let i = 0; i < Math.min(START_LANES, cap); i++) spawn();
  const ramp = setInterval(() => {
    if (running.size < cap && queue.length > running.size && pacer.healthy()) spawn();
  }, 1500);
  try {
    // a lane can be added while we wait, so drain until none are left
    while (running.size) await Promise.all([...running]);
  } finally { clearInterval(ramp); }

  finalizeSheets(image);
  image.source.url = execUrl;
  if (manifest.timestamp) image.timestamp = manifest.timestamp;
  return image;
}

/* ---------- transport ---------- */
// A shared throttle. Every failure widens the gap between requests and
// every success narrows it, so a struggling Apps Script gets breathing
// room instead of being hammered by retries from several lanes at once.
function makePacer() {
  let delay = 0;
  let nextAt = 0;
  let streak = 0;
  return {
    async wait() {
      const now = Date.now();
      const at = Math.max(now, nextAt);
      nextAt = at + delay;
      if (at > now) await sleep(at - now);
    },
    penalise() { delay = Math.min(4000, delay ? delay * 2 : 500); streak = 0; },
    reward() { delay = delay > 250 ? Math.floor(delay / 2) : 0; streak += 1; },
    /** clean sailing for a while - safe to push a little harder */
    healthy() { return delay === 0 && streak >= 4; },
  };
}

// Which way we talk to Apps Script.
//
// Going straight to Google removes a whole network hop (browser -> your
// server -> Google -> back) from every request, and keeps the /exec URL -
// which is a key to the sheet - inside the browser entirely.
//
// It is OFF by default because the app serves `connect-src 'self'`, a
// deliberate choice (see src/app.js): with that header the browser blocks the
// direct call, so probing for it would waste a request on every sync for
// nothing. To turn it on, add
//     https://script.google.com https://script.googleusercontent.com
// to connect-src and pass `direct: true` - note that this widens where the
// page may send data, which is exactly what that header is there to limit.
function makeTransport(opts) {
  let mode = opts.direct === true ? 'probe' : 'proxy';
  return {
    urlFor(target) {
      return mode === 'proxy' ? '/api/sheet?url=' + encodeURIComponent(target) : target;
    },
    get mode() { return mode; },
    succeeded() { if (mode === 'probe') mode = 'direct'; },
    // A direct call can fail for reasons the proxy would survive (CORS, a
    // corporate egress rule). Drop back rather than failing the sync.
    failedDirect() { if (mode !== 'proxy') { mode = 'proxy'; return true; } return false; },
  };
}

async function getJson(execUrl, params, fetchImpl, opts, pacer, transport) {
  const target = withParams(execUrl, params);
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  let lastErr = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (opts.signal && opts.signal.aborted) throw new Error('Sync cancelled');
    await pacer.wait();

    const url = transport.urlFor(target);
    const wasDirect = transport.mode !== 'proxy';
    let timer = null;
    try {
      const init = {};
      if (typeof AbortController === 'function') {
        const ac = new AbortController();
        timer = setTimeout(() => ac.abort(), timeoutMs);
        init.signal = ac.signal;
      }
      const res = await fetchImpl(url, init);
      const payload = await res.json();
      if (wasDirect) transport.succeeded();

      if (payload && payload.ok) { pacer.reward(); return payload; }

      // A configuration problem will not fix itself — stop immediately.
      if (payload && payload.fatal) throw fatal(payload.error || 'Request rejected');
      // The bridge answering "too big, try N rows" is a usable answer.
      if (payload && payload.retryWith) { pacer.reward(); return payload; }

      throw new Error((payload && payload.error) || 'Google Sheets fetch failed');
    } catch (e) {
      lastErr = e;
      if (e && e.fatal) throw e;
      // A failure on the very first direct attempt is more likely to be the
      // transport than the request - switch to the proxy and retry at once.
      if (wasDirect && transport.failedDirect()) { attempt -= 1; continue; }
      pacer.penalise();
      if (attempt < ATTEMPTS) {
        // exponential backoff with jitter, so parallel lanes do not
        // all come back at the same instant
        const base = 600 * Math.pow(2, attempt - 1);
        await sleep(base + Math.random() * base);
      }
    } finally { if (timer) clearTimeout(timer); }
  }
  const msg = (lastErr && lastErr.message) || String(lastErr);
  throw new Error(`${msg} (after ${ATTEMPTS} attempts)`);
}

function fatal(message) { const e = new Error(message); e.fatal = true; return e; }

function withParams(url, params) {
  const qs = Object.keys(params)
    .filter((k) => params[k] != null && params[k] !== '')
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  if (!qs) return url;
  const [base, hash] = String(url).split('#');
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + qs + (hash ? '#' + hash : '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- manifest + chunks ---------- */
// The manifest carries every per-SHEET property; chunks carry cells.
export function manifestToImage(manifest) {
  const image = emptyImage({ kind: 'gsheet', name: manifest.spreadsheetName || 'Google Sheet', id: manifest.spreadsheetId || '' });
  (manifest.sheets || []).forEach((tab, i) => {
    const s = emptySheetImage(tab.name, i);
    s.index = tab.index != null ? tab.index : i;
    s.hidden = !!tab.hidden;
    s.tabColor = tab.tabColor || null;
    s.rows = tab.rows || 50;
    s.cols = tab.cols || 26;
    s.frozen = tab.frozen || { rows: 0, cols: 0 };
    s.merges = (tab.merges || []).map((m) => ({ ...m }));
    s.hiddenCols = [...(tab.hiddenCols || [])];
    s.colWidths = { ...(tab.colWidths || {}) };
    s.colMeta = (tab.colMeta || []).map((m) => (m ? { ...m } : null));
    s.conditionalFormats = (tab.conditionalFormats || []).map((c) => ({ ...c }));
    image.sheets.push(s);
  });
  return image;
}

// Merge one row band into its sheet. Cell keys are absolute "r,c", so
// bands can land in any order.
//
// v5 chunks hoist repeated styles and number formats into per-chunk tables
// (`styles`/`nfs`) and reference them by index, which is what lets one request
// carry five times as many cells. Expanding them here also INTERNS them: every
// cell sharing a style shares one object rather than a copy, which the
// workbook's own palette then preserves on save. Older chunks carry `st`/`nf`
// inline and still work.
export function applyChunk(sheet, chunk) {
  if (!sheet || !chunk) return sheet;
  const styles = chunk.styles || null;
  const nfs = chunk.nfs || null;
  for (const k of Object.keys(chunk.cells || {})) {
    const raw = chunk.cells[k];
    if (raw && styles && raw.s !== undefined) { raw.st = styles[raw.s]; delete raw.s; }
    if (raw && nfs && raw.n !== undefined) { raw.nf = nfs[raw.n]; delete raw.n; }
    const c = normCellImage(raw);
    if (c) {
      // normCellImage rebuilds the style object; point it back at the shared
      // palette entry so a million cells do not hold a million copies
      if (c.st && raw.st) c.st = raw.st;
      sheet.cells[k] = c;
    }
  }
  Object.assign(sheet.rowHeights, chunk.rowHeights || {});
  for (const r of chunk.hiddenRows || []) sheet.hiddenRows.push(r);
  for (const v of chunk.validations || []) sheet.validations.push({ ...v });
  return sheet;
}

// De-duplicate the per-chunk arrays and make sure the grid is big
// enough for every cell that actually arrived.
function finalizeSheets(image) {
  for (const s of image.sheets || []) {
    s.hiddenRows = Array.from(new Set(s.hiddenRows)).sort((a, b) => a - b);
    s.hiddenCols = Array.from(new Set(s.hiddenCols)).sort((a, b) => a - b);
    let maxR = -1, maxC = -1;
    for (const k of Object.keys(s.cells)) {
      const i = k.indexOf(',');
      const r = +k.slice(0, i), c = +k.slice(i + 1);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    if (maxR + 1 > s.rows) s.rows = maxR + 1;
    if (maxC + 1 > s.cols) s.cols = maxC + 1;
  }
  return image;
}

/* ---------- legacy one-shot payloads ---------- */
// Pure transform: Apps Script payload -> SheetImage. Exposed for tests.
export function payloadToImage(payload) {
  const image = emptyImage({ kind: 'gsheet', name: payload.spreadsheetName || payload.sheetName || 'Google Sheet', id: payload.spreadsheetId || '' });
  (payload.sheets || []).forEach((tab, i) => image.sheets.push(v3Sheet(tab, i)));
  if (payload.timestamp) image.timestamp = payload.timestamp;
  return image;
}

/* ---------- v3: MonoBridge full detail ---------- */
function v3Sheet(tab, i) {
  const s = emptySheetImage(tab.name, i);
  s.index = tab.index != null ? tab.index : i;
  s.hidden = !!tab.hidden;
  s.tabColor = tab.tabColor || null;
  s.rows = tab.rows || 50;
  s.cols = tab.cols || 26;
  s.frozen = tab.frozen || { rows: 0, cols: 0 };
  s.merges = (tab.merges || []).map((m) => ({ ...m }));
  s.hiddenRows = tab.hiddenRows || [];
  s.hiddenCols = tab.hiddenCols || [];
  s.colWidths = tab.colWidths || {};
  s.rowHeights = tab.rowHeights || {};
  s.colMeta = (tab.colMeta || []).map((m) => (m ? { ...m } : null));
  s.validations = (tab.validations || []).map((v) => ({ ...v }));
  s.conditionalFormats = (tab.conditionalFormats || []).map((c) => ({ ...c }));
  for (const k of Object.keys(tab.cells || {})) {
    const c = normCellImage(tab.cells[k]);
    if (c) s.cells[k] = c;
  }
  return s;
}

