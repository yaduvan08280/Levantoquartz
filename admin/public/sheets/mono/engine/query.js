// ============================================================
//  Mono formula engine — QUERY (Phase 4B + aggregates)
//  SELECT (cols + sum/avg/count/max/min) · WHERE · GROUP BY ·
//  ORDER BY · LIMIT · OFFSET. Columns are A,B,C…  (pivot/label staged.)
// ============================================================
import { makeArray, compare } from './values.js';
import { ERR, err } from './errors.js';

function colIdx(s) { s = String(s).trim().toUpperCase(); if (/^[A-Z]+$/.test(s)) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; } const m = /^COL(\d+)$/.exec(s); return m ? +m[1] - 1 : -1; }
const numOf = (v) => Number(String(v == null ? '' : v).replace(/[,%\s₹$€£]/g, ''));

function splitClauses(q) {
  const toks = q.match(/'[^']*'|"[^"]*"|\S+/g) || [];
  const out = {}; let cur = null, buf = [];
  const flush = () => { if (cur) out[cur] = ((out[cur] ? out[cur] + ' ' : '') + buf.join(' ')).trim(); buf = []; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].toLowerCase(), two = t + ' ' + (toks[i + 1] || '').toLowerCase();
    if (two === 'order by') { flush(); cur = 'orderby'; i++; continue; }
    if (two === 'group by') { flush(); cur = 'groupby'; i++; continue; }
    if (['select', 'where', 'limit', 'offset', 'label', 'format', 'pivot'].includes(t)) { flush(); cur = t; continue; }
    buf.push(toks[i]);
  }
  flush(); return out;
}
function parseCond(s) {
  const m = /^([A-Za-z]+\d*)\s*(<=|>=|!=|<>|=|<|>|contains|starts with|ends with|matches)\s*([\s\S]+)$/i.exec(s.trim());
  if (!m) return { type: 'true' };
  let val = m[3].trim(), v;
  if (/^'.*'$/.test(val) || /^".*"$/.test(val)) v = val.slice(1, -1);
  else if (/^-?[\d.]+$/.test(val)) v = Number(val);
  else if (/^(true|false)$/i.test(val)) v = /^true$/i.test(val);
  else v = val;
  return { type: 'cond', col: colIdx(m[1]), op: m[2].toLowerCase(), val: v };
}
function parseWhere(s) { return { type: 'or', items: s.split(/\s+or\s+/i).map((o) => ({ type: 'and', items: o.split(/\s+and\s+/i).map(parseCond) })) }; }
function evalPred(p, row) {
  if (p.type === 'true') return true;
  if (p.type === 'or') return p.items.some((x) => evalPred(x, row));
  if (p.type === 'and') return p.items.every((x) => evalPred(x, row));
  const cell = row[p.col], { op, val } = p, sc = String(cell ?? '').toLowerCase(), sv = String(val).toLowerCase();
  if (op === 'contains') return sc.includes(sv);
  if (op === 'starts with') return sc.startsWith(sv);
  if (op === 'ends with') return sc.endsWith(sv);
  if (op === 'matches') { try { return new RegExp('^' + val + '$').test(String(cell ?? '')); } catch { return false; } }
  const cmp = compare(cell, val);
  return op === '=' ? cmp === 0 : (op === '!=' || op === '<>') ? cmp !== 0 : op === '<' ? cmp < 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : cmp >= 0;
}
function parseSelectItems(sel) {
  return sel.split(',').map((s) => { s = s.trim(); const m = /^(sum|avg|count|max|min)\s*\(\s*([A-Za-z]+\d*|\*)\s*\)$/i.exec(s); if (m) return { type: 'agg', fn: m[1].toLowerCase(), idx: m[2] === '*' ? 0 : colIdx(m[2]), raw: s.toLowerCase().replace(/\s+/g, '') }; return { type: 'col', idx: colIdx(s), raw: s.toUpperCase() }; });
}
function aggregate(fn, values) {
  if (fn === 'count') return values.filter((v) => v != null && v !== '').length;
  const nums = values.map(numOf).filter((n) => !Number.isNaN(n));
  if (!nums.length) return fn === 'sum' ? 0 : '';
  if (fn === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (fn === 'max') return Math.max(...nums);
  if (fn === 'min') return Math.min(...nums);
  return '';
}
function orderLimit(out, cl, indexOf) {
  if (cl.orderby) {
    const ords = cl.orderby.split(',').map((s) => { const mm = /^(.+?)\s*(asc|desc)?$/i.exec(s.trim()) || [0, '']; return { oi: indexOf(mm[1].trim()), dir: (mm[2] || 'asc').toLowerCase() }; }).filter((o) => o.oi >= 0);
    if (ords.length) out.sort((a, b) => { for (const o of ords) { const cmp = compare(a[o.oi], b[o.oi]); if (cmp) return o.dir === 'desc' ? -cmp : cmp; } return 0; });
  }
  const off = cl.offset ? parseInt(cl.offset, 10) : 0, lim = cl.limit ? parseInt(cl.limit, 10) : undefined;
  return out.slice(off, lim !== undefined ? off + lim : undefined);
}
export function query(data, qStr, headers) {
  const hdr = headers != null && headers > 0 ? Math.floor(headers) : 0;
  let work = data.slice(hdr).map((r) => r);
  const cl = splitClauses(String(qStr));
  if (cl.where) { const pred = parseWhere(cl.where); work = work.filter((r) => evalPred(pred, r)); }
  const selItems = (cl.select && cl.select.trim() !== '*') ? parseSelectItems(cl.select) : null;
  const groupCols = cl.groupby ? cl.groupby.split(',').map((s) => colIdx(s.trim())) : [];
  const hasAgg = (selItems && selItems.some((i) => i.type === 'agg')) || groupCols.length > 0;

  if (hasAgg) {
    const items = selItems || groupCols.map((c) => ({ type: 'col', idx: c, raw: '' }));
    const groups = new Map();
    for (const row of work) { const key = groupCols.map((c) => String(row[c] ?? '')).join(''); if (!groups.has(key)) groups.set(key, { rep: row, rows: [] }); groups.get(key).rows.push(row); }
    let out = [...groups.values()].map((g) => items.map((it) => it.type === 'col' ? g.rep[it.idx] : aggregate(it.fn, g.rows.map((r) => r[it.idx]))));
    const indexOf = (tok) => { const n = tok.toLowerCase().replace(/\s+/g, ''); let i = items.findIndex((it) => it.raw && it.raw.toLowerCase() === n); if (i >= 0) return i; const ci = colIdx(tok); return items.findIndex((it) => it.type === 'col' && it.idx === ci); };
    out = orderLimit(out, cl, indexOf);
    return out.length ? makeArray(out) : err(ERR.NA, 'QUERY: empty result');
  }

  const indexOf = (tok) => { if (!selItems) return colIdx(tok); const ci = colIdx(tok); return selItems.findIndex((it) => it.type === 'col' && it.idx === ci); };
  if (!selItems) work = orderLimit(work.map((r) => r), cl, (tok) => colIdx(tok)).map((r) => r);
  else { work = orderLimit(work, cl, indexOf === undefined ? colIdx : (tok) => colIdx(tok)); work = work.map((r) => selItems.map((it) => r[it.idx])); }
  return work.length ? makeArray(work) : err(ERR.NA, 'QUERY: empty result');
}
