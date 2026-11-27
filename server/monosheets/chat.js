// ============================================================
// Shared Chat UI Controller
// Manages the global #chat element across both Dashboard and Sheets.
// ============================================================
import { icon } from './ui/icons.js';
import { aiStatusLine } from './auth.js';

const el = (html) => { const div = document.createElement('div'); div.innerHTML = html.trim(); return div.firstChild; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class ChatUIController {
  constructor() {
    this.isOpen = false;
    this.mode = 'dashboard'; // 'dashboard' or 'sheet'
    this.onSend = null;
    this.history = { dashboard: [], sheet: [] };
  }

  mount() {
    this.chatEl = document.getElementById('chat');
    this.bodyEl = document.getElementById('chatBody');
    this.inputEl = document.getElementById('chatInput');
    this.titleEl = document.getElementById('chatTitle');
    this.providerEl = document.getElementById('chatProvider');
    this.iconEl = document.getElementById('chatIcon');
    this.fabEl = document.getElementById('fab');

    if (!this.chatEl) return;

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._handleSend();
      }
    });

    // Setup visual styling
    if (this.fabEl) this.fabEl.innerHTML = icon('sparkles', { size: 24 });
    if (this.iconEl) this.iconEl.innerHTML = icon('sparkles', { size: 16 });
    const closeBtn = document.getElementById('chatCloseBtn');
    if (closeBtn && !closeBtn.innerHTML.trim()) closeBtn.innerHTML = icon('x', { size: 14 });
    // BYOK status can change while the panel is open (Settings → AI)
    window.addEventListener('mono:aiConfigChanged', () => this.refreshProviderLine());
  }

  refreshProviderLine() {
    if (!this.providerEl) return;
    if (this.mode === 'sheet' && this.sheetHeader) { this.providerEl.textContent = this.sheetHeader.sub; return; }
    this.providerEl.textContent = aiStatusLine();
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'dashboard') {
      if (this.titleEl) this.titleEl.textContent = 'Dashboard Assistant';
      if (this.providerEl) this.providerEl.textContent = 'AI';
      if (this.inputEl) this.inputEl.placeholder = 'ask about your data...';
      if (this.fabEl) this.fabEl.title = 'Dashboard Assistant';
    } else {
      const hdr = this.sheetHeader;                     // Ask mode (UI Plan v3 §5.1)
      if (this.titleEl) this.titleEl.textContent = hdr ? hdr.title : '✨ Mono';
      if (this.inputEl) this.inputEl.placeholder = hdr ? 'Ask about this data — averages, counts, summaries…' : 'Ask for a formula, an explanation, or a change...';
      if (this.fabEl) this.fabEl.title = hdr ? 'Copilot — Ask mode' : 'Mono Copilot';
      this.refreshProviderLine();
    }
    
    // Switch active history
    this.renderHistory();
  }

  toggle() {
    if (!this.chatEl) return;
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.chatEl.classList.add('open');
      this.inputEl.focus();
      // If opening for first time in mode and history is empty, show welcome message
      if (this.history[this.mode].length === 0) {
        if (this.mode === 'dashboard') {
          this.pushBot('Ask about your data or tell me to change the dashboard. (Needs an AI key — add your own in Settings → AI; the free deterministic tools all work without one.)');
        } else if (this.sheetHeader) {
          this.pushBot(this.sheetHeader.welcome);
        } else {
          this.pushBot('I\'m Mono, your sheet copilot. Ask for a formula, an explanation of one, or a change — edits are always previewed and only applied when you click Apply.');
        }
      }
    } else {
      this.chatEl.classList.remove('open');
    }
  }

  pushUser(text) {
    this._appendMessage('user', text);
    this.history[this.mode].push({ role: 'user', text, isHtml: false });
  }

  pushBot(text, extraHtmlNode = null, isHtml = false) {
    this._appendMessage('bot', text, extraHtmlNode, isHtml);
    // Don't store nodes in history for now, just text
    this.history[this.mode].push({ role: 'bot', text, isHtml });
  }
  
  pushBotHtml(htmlStr) {
    this._appendMessage('bot', htmlStr, null, true);
    this.history[this.mode].push({ role: 'bot', text: htmlStr, isHtml: true });
  }

  _appendMessage(role, text, extraHtmlNode, isHtml) {
    if (!this.bodyEl) return; // not mounted yet
    const m = el(`<div class="msg ${role}"><div class="av">${role === 'user' ? 'You' : icon('sparkles', { size: 13 })}</div><div class="bub"></div></div>`);
    const bub = m.querySelector('.bub');
    if (isHtml) {
      bub.innerHTML = text;
    } else {
      bub.textContent = text;
    }
    if (extraHtmlNode) bub.appendChild(extraHtmlNode);
    this.bodyEl.appendChild(m);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  renderHistory() {
    if (!this.bodyEl) return; // not mounted yet
    this.bodyEl.innerHTML = '';
    for (const msg of this.history[this.mode]) {
      this._appendMessage(msg.role, msg.text, null, msg.isHtml);
    }
  }

  showSpinner() {
    this.spinId = 'spin_' + Date.now();
    const m = el(`<div class="msg bot" id="${this.spinId}"><div class="av">${icon('sparkles', { size: 13 })}</div><div class="bub"><span class="spin"></span></div></div>`);
    this.bodyEl.appendChild(m);
    this.bodyEl.scrollTop = 1e9;
  }

  removeSpinner() {
    if (this.spinId) {
      document.getElementById(this.spinId)?.remove();
      this.spinId = null;
    }
  }

  _handleSend() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (this.onSend) {
      this.inputEl.value = '';
      this.onSend(text);
    }
  }
}

window.ChatUI = new ChatUIController();

// Bind the #chat DOM as soon as it exists. Previously only the dashboard
// boot path called mount(), so starting the app in Sheet mode left the
// chat panel unbound (setMode crashed on the missing bodyEl and killed
// the copilot's onSend wiring with it).
const _mountChat = () => window.ChatUI.mount();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _mountChat);
else _mountChat();

// Expose a global toggle handler for index.html onclick
window.toggleChat = () => window.ChatUI.toggle();
window.sendChat = () => window.ChatUI._handleSend();
