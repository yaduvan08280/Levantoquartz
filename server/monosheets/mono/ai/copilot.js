// ============================================================
//  Mono — AI Copilot UI (P13)
//  Sheet-mode chat panel: local intent pre-pass, LLM fallback,
//  validated previews, explicit-click Apply.
// ============================================================
import { icon } from '../../ui/icons.js';
import { redactPayloadForLLM } from './redact.js';
import { renderDiffPreview } from '../ui/diffPreview.js';
import { applyPatch, normalizeOps } from './patches.js';
import { validateProposal } from './validators.js';
import { classifyLocalIntent, parseOKF, hasCellRef, looksLikeFormula } from './intents.js';
import { explainFormula } from './explain.js';
import { analyzeLocal } from './analyze.js';
import { localFormula, answerPossibility } from './localBrain.js';
import { normalizeQuery } from './normalizer.js';
import { makeHost } from '../views/host.js';
import { addrToA1 } from '../model/workbook.js';

let _grid = null;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Hard client-side token budget (roadmap P13: enforced BEFORE the fetch,
// never in the route handler). ~4 chars/token heuristic.
const TOKEN_BUDGET = 8000;
const CHAR_BUDGET = TOKEN_BUDGET * 4;

/** Append to the workbook's persisted AI log, trimming from the front at 500. */
function logAi(entry) {
  const log = (_grid.wb.aiLog = _grid.wb.aiLog || []);
  log.push(entry);
  if (log.length > 500) log.splice(0, log.length - 500);
}

/** Current selection rectangle (normalized). */
function selectionRect() {
  return {
    startRow: Math.min(_grid.active.r, _grid.anchor.r),
    endRow: Math.max(_grid.active.r, _grid.anchor.r),
    startCol: Math.min(_grid.active.c, _grid.anchor.c),
    endCol: Math.max(_grid.active.c, _grid.anchor.c),
  };
}

/** Computed values of a rect as a 2D array (rows × cols). */
function rectValues(rect, maxRows = Infinity) {
  const sid = _grid.sid();
  const out = [];
  for (let r = rect.startRow; r <= Math.min(rect.endRow, rect.startRow + maxRows - 1); r++) {
    const row = [];
    for (let c = rect.startCol; c <= rect.endCol; c++) {
      const v = _grid.engine.getValue(sid, r, c);
      row.push(v && v.__error ? v.type : v);
    }
    out.push(row);
  }
  return out;
}

/**
 * Assembles the /api/copilot payload and enforces the 8k-token cap by
 * sampling the sheet context (selection rows first) — NEVER the user's
 * prompt. Returns { payload, sampled }.
 */
/** First-row display values — the sheet's headers, for column matching. */
function sheetHeaders() {
  const sh = _grid.sheet();
  const out = [];
  for (let c = 0; c < Math.min(sh.cols, 40); c++) out.push(_grid.engine.getDisplay(_grid.sid(), 0, c));
  return out;
}

/** Compact summary of every sheet (name, headers) for server-side RAG-lite. */
function allSheetsSummary() {
  const out = [];
  for (const s of (_grid.wb.sheets || []).slice(0, 24)) {
    const headers = [];
    for (let c = 0; c < Math.min(s.cols, 16); c++) {
      const h = _grid.engine.getDisplay(s.id, 0, c);
      if (h) headers.push(String(h));
    }
    out.push({ name: s.name, rows: s.rows, headers });
  }
  return out;
}

function buildLlmPayload(text) {
  const sh = _grid.sheet();
  const rect = selectionRect();
  const headerRow = sheetHeaders();
  const norm = normalizeQuery(text);   // P21: Hinglish → English hint for the LLM tiers

  let maxRows = rect.endRow - rect.startRow + 1;
  let sampled = false;
  let payload;
  for (;;) {
    payload = {
      prompt: text,
      selection: { ...rect, values: rectValues(rect, maxRows) },
      context: {
        workbookId: _grid.wb?.id,          // server derives the caller's role → ask-only enforcement (§5.2)
        activeSheet: _grid.sid(),
        sheetName: sh.name,
        rows: sh.rows, cols: sh.cols,
        headers: headerRow,
        activeCell: { r: _grid.active.r, c: _grid.active.c },
        // P21: normalized prompt + all-sheet map for server-side RAG-lite.
        ...(norm.changed ? { normalizedPrompt: norm.text } : {}),
        allSheets: allSheetsSummary(),
        ...(sampled ? { sampled: true, note: `selection sampled to first ${maxRows} rows to fit token budget` } : {}),
      },
    };
    if (JSON.stringify(payload).length <= CHAR_BUDGET || maxRows === 0) break;
    maxRows = Math.floor(maxRows / 2);
    sampled = true;
  }
  // Single redaction choke point: the ENTIRE payload, exactly once,
  // after assembly and immediately before it leaves the browser.
  return { payload: redactPayloadForLLM(payload), sampled };
}

async function sendSheetChat(text) {
  if (!_grid) return;

  window.ChatUI.pushUser(text);
  logAi({ role: 'user', text });

  // Offline local bypass
  const intent = classifyLocalIntent(text);
  if (intent === 'explain') {
    const raw = _grid.engine.getRaw(_grid.sid(), _grid.active.r, _grid.active.c);
    if (raw && raw[0] === '=') {
      const explanation = explainFormula(raw);
      window.ChatUI.pushBot(explanation);
      logAi({ role: 'bot', text: explanation });
      return;
    }
  }
  if (intent === 'analyze') {
    const summary = analyzeLocal(rectValues(selectionRect()));
    window.ChatUI.pushBot(summary);
    logAi({ role: 'bot', text: summary });
    return;
  }

  // Local formula brain — instant, no API key. Tried for any request that
  // looks like a formula OR simply names a cell/range, regardless of which
  // intent bucket it fell into ("can you sum d2:d9?", "give me the total of
  // column d", "d2 se d9 ka sum d10 me"). Only a low-confidence result
  // falls through to the capability answer / LLM path below.
  if (intent === 'formula' || (hasCellRef(text) && looksLikeFormula(text))) {
    const local = localFormula(text, { activeCell: { r: _grid.active.r, c: _grid.active.c }, headers: sheetHeaders() });
    if (local.confidence >= 0.6) {
      const node = buildProposalNode({ reply: local.explanation, formula: local.formula }, { targetCell: local.targetCell });
      window.ChatUI.pushBot('', node, true);
      logAi({ role: 'bot', text: `${local.explanation} ${local.formula}` });
      return;
    }
  }

  // Capability questions ("can I…", "is there…") — answered straight from
  // the OKF knowledge bundle, no network. Below the confidence threshold
  // we say so honestly rather than fuzzy-match to the nearest feature.
  if (intent === 'question' || intent === 'unknown') {
    const poss = answerPossibility(text);
    if (poss) {
      window.ChatUI.pushBot(poss.answer);
      logAi({ role: 'bot', text: poss.answer });
      return;
    }
  }

  window.ChatUI.showSpinner();
  // "Thinking…" after ~1s so a slow LLM round-trip isn't a bare spinner.
  const thinkTimer = setTimeout(() => {
    const spin = window.ChatUI.spinId && document.getElementById(window.ChatUI.spinId);
    const bub = spin && spin.querySelector('.bub');
    if (bub) {
      const s = document.createElement('span');
      s.style.cssText = 'margin-left:6px; font-size:11px; color:var(--tx-3);';
      s.textContent = 'Thinking…';
      bub.appendChild(s);
    }
  }, 1000);

  try {
    const { payload, sampled } = buildLlmPayload(text);
    if (sampled) window.ChatUI.pushBot('Note: the selection was too large to send whole — the AI sees a sample of it.');

    const res = await fetch('/api/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    window.ChatUI.removeSpinner();

    if (!data.ok) throw new Error(data.error || 'Server error');

    const okf = data.result;
    const node = buildProposalNode(okf);

    if (node) {
      window.ChatUI.pushBot('', node, true);
    } else {
      window.ChatUI.pushBot('(no reply)');
    }
    logAi({ role: 'bot', text: okf.reply || okf.plan });

  } catch (err) {
    window.ChatUI.removeSpinner();
    window.ChatUI.pushBotHtml(`<span style="color:var(--ui-red)">Error: ${esc(err.message)}</span>`);
  } finally {
    clearTimeout(thinkTimer);
  }
}

/**
 * Builds the bot-message DOM node for an OKF proposal: reply/plan text,
 * an optional formula with an Insert button, and optional sheet ops with
 * a validated diff preview and an Approve & Apply button.
 *
 * Apply is gated on a trusted user click (roadmap P13: proposals never
 * auto-apply — any autoApply flag in the LLM response is simply ignored,
 * we never read it). Ops flow through normalizeOps once, so validation,
 * preview, and apply all see the identical canonical op list.
 */
const askMode = () => !!(_grid && _grid.access && !_grid.access.canEdit);

function buildProposalNode(okf, opts = {}) {
  const target = opts.targetCell || { r: _grid.active.r, c: _grid.active.c };
  const ask = askMode() || okf.askOnly;
  let html = okf.reply ? `<div>${esc(okf.reply)}</div>` : '';
  if (okf.plan) {
    html += `<div style="margin-top:8px; padding:8px; background:var(--bg-2); border-radius:4px; font-size:12px;"><b>Plan:</b><br/>${esc(okf.plan)}</div>`;
  }

  if (okf.formula) {
    const check = validateProposal([{ type: 'setCell', r: target.r, c: target.c, raw: okf.formula }], _grid.engine, _grid.sid());
    html += `<div style="margin-top:8px; font-family:monospace; background:var(--bg-3); padding:4px;">${esc(okf.formula)}</div>`;
    if (!check.valid) html += `<div style="margin-top:4px; color:var(--ui-red); font-size:12px;">This formula would produce: ${esc(check.errors.join(', '))}</div>`;
    html += ask
      ? `<div style="margin-top:4px; font-size:11.5px; color:var(--tx-3)">You have ${esc(_grid.access?.role || 'read-only')} access here, so I can't insert this — copy it or pass it to the owner. <button data-act="copyf" class="btn btn-ghost" style="font-size:11px; padding:2px 8px;">Copy formula</button></div>`
      : `<button data-act="formula" class="btn btn-primary" style="margin-top:4px; font-size:11px;">Apply to ${esc(addrToA1(target.r, target.c))}</button>`;
  }

  const { ops } = normalizeOps(okf.ops || []);
  if (ops.length) {
    const validation = validateProposal(ops, _grid.engine, _grid.sid());
    if (!validation.valid) {
      html += `<div style="margin-top:8px; color:var(--ui-red); font-size:12px;"><b>Warning:</b> Patch causes errors:<br/>${validation.errors.map(esc).join('<br/>')}</div>`;
    }
    if (!ask) {
      html += `<div style="margin-top:8px;">${renderDiffPreview(ops, _grid.wb, _grid.sid())}</div>`;
      html += `<button data-act="apply" class="btn btn-primary" style="margin-top:8px; font-size:12px;">Approve &amp; Apply</button>`;
    } else {
      html += `<div style="margin-top:6px; font-size:11.5px; color:var(--tx-3)">I can't change this workbook with your access — here's what I'd do, for the owner.</div>`;
    }
  }

  if (!html) return null;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;

  wrap.querySelector('[data-act="formula"]')?.addEventListener('click', (e) => {
    if (!e.isTrusted || !_grid) return;
    if (askMode()) return;                      // role changed mid-chat — server would reject anyway
    makeHost(_grid).applyEdit({ type: 'setCell', r: target.r, c: target.c, raw: okf.formula });
    e.target.disabled = true; e.target.textContent = 'Applied ✓';
  });
  wrap.querySelector('[data-act="copyf"]')?.addEventListener('click', (e) => {
    try { navigator.clipboard.writeText(okf.formula); e.target.textContent = 'Copied ✓'; } catch {}
  });
  wrap.querySelector('[data-act="apply"]')?.addEventListener('click', (e) => {
    if (!e.isTrusted || !_grid) return;
    if (askMode()) return;
    try {
      applyPatch(makeHost(_grid), ops);
      e.target.disabled = true; e.target.textContent = 'Applied ✓';
    } catch (err) {
      console.error(err);
      window.ChatUI.pushBotHtml(`<span style="color:var(--ui-red)">Failed to apply patch: ${esc(err.message)}</span>`);
    }
  });
  return wrap;
}

export function mountFab(grid) {
  _grid = grid;
  // onSend first — setMode repaints history and must not be able to
  // leave the panel half-wired if anything in the repaint throws.
  if (window.ChatUI) window.ChatUI.onSend = sendSheetChat;
  // Ask mode for Commenter/Viewer (UI Plan v3 §5.1): same Copilot, header
  // says so, suggestions are ask-style, and nothing offers to edit.
  if (window.ChatUI) {
    const ro = grid.access && !grid.access.canEdit;
    window.ChatUI.sheetHeader = ro
      ? { title: '✨ Copilot — Ask mode', sub: 'answers & calculations only', welcome: 'I can answer questions and calculate from this workbook, but not edit it. Try: “average of D2:D40”, “how many rows in column B are Done”, or “summarize this sheet”.' }
      : null;
  }
  window.ChatUI?.setMode('sheet');
  
  // Sync ChatUI history with workbook aiLog
  if (window.ChatUI) {
    window.ChatUI.history.sheet = (_grid.wb.aiLog || []).map(msg => ({
      role: msg.role,
      text: msg.text,
      isHtml: msg.role === 'bot' // assume bot messages might have HTML formatting, but for simplicity text works
    }));
    window.ChatUI.renderHistory();
  }
  
  // Global keyboard shortcut
  window._monoCopilotKeydown = (e) => {
    if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.ChatUI?.toggle();
    }
  };
  window.addEventListener('keydown', window._monoCopilotKeydown);
}

export function unmountFab() {
  if (window._monoCopilotKeydown) {
    window.removeEventListener('keydown', window._monoCopilotKeydown);
    window._monoCopilotKeydown = null;
  }
  _grid = null;
}

