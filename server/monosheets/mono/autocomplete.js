// ============================================================
//  Mono Sheets — formula function autocomplete (Phase 2.5)
//  Suggests function names + signatures while typing a formula.
// ============================================================
import { registry } from './engine/registry.js';
import './engine/builtins.js'; // ensure registry populated

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FormulaAutocomplete {
  constructor() {
    this.el = document.createElement('div'); this.el.className = 'ms-ac'; this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.items = []; this.idx = 0; this.input = null; this.tokenStart = 0; this.onPick = null;
    this.el.addEventListener('mousedown', (e) => { const it = e.target.closest('.ms-ac-item'); if (it) { e.preventDefault(); this.idx = +it.dataset.i; this.accept(); } });
  }
  fns() {
    if (this._fns) return this._fns;
    const seen = new Set(), out = [];
    for (const d of registry.list()) { if (seen.has(d.name)) continue; seen.add(d.name); out.push({ name: d.name, syntax: (d.help && d.help.syntax) || d.name + '(…)' }); }
    out.sort((a, b) => a.name < b.name ? -1 : 1); this._fns = out; return out;
  }
  visible() { return this.el.style.display !== 'none'; }
  hide() { this.el.style.display = 'none'; this.items = []; this.input = null; }
  update(input, rect) {
    const v = input.value, caret = input.selectionStart;
    if (!v.startsWith('=')) return this.hide();
    const m = /([A-Za-z][A-Za-z0-9_.]*)$/.exec(v.slice(0, caret));
    if (!m) return this.hide();
    const word = m[1].toUpperCase(); this.tokenStart = caret - m[1].length;
    const matches = this.fns().filter((f) => f.name.startsWith(word)).slice(0, 8);
    if (!matches.length || (matches.length === 1 && matches[0].name === word)) return this.hide();
    this.items = matches; this.idx = 0; this.input = input;
    this.el.innerHTML = matches.map((f, i) => `<div class="ms-ac-item ${i === 0 ? 'on' : ''}" data-i="${i}"><span class="ms-ac-name">${f.name}</span><span class="ms-ac-syn">${esc(f.syntax)}</span></div>`).join('');
    this.el.style.display = 'block'; this.el.style.left = rect.left + 'px'; this.el.style.top = (rect.bottom + 2) + 'px';
  }
  move(d) { if (!this.visible()) return; this.idx = (this.idx + d + this.items.length) % this.items.length; [...this.el.children].forEach((c, i) => c.classList.toggle('on', i === this.idx)); }
  accept() {
    if (!this.visible() || !this.input) return false;
    const name = this.items[this.idx].name, input = this.input, v = input.value, caret = input.selectionStart;
    const ins = name + '(';
    input.value = v.slice(0, this.tokenStart) + ins + v.slice(caret);
    const pos = this.tokenStart + ins.length; input.setSelectionRange(pos, pos);
    this.hide(); if (this.onPick) this.onPick(); return true;
  }
  onKeyDown(e) {
    if (!this.visible()) return false;
    if (e.key === 'ArrowDown') { this.move(1); e.preventDefault(); return true; }
    if (e.key === 'ArrowUp') { this.move(-1); e.preventDefault(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { if (this.accept()) { e.preventDefault(); return true; } }
    if (e.key === 'Escape') { this.hide(); return true; }
    return false;
  }
}
export default FormulaAutocomplete;
