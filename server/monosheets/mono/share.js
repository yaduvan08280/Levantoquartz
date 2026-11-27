// ============================================================
//  Mono — Share dialog (UI Plan v3 §4)
//  Same centered-modal pattern as the Comments dialog. Two parts:
//    1. Manage access — collaborators on THIS workbook: inline role
//       change, revoke with one confirm. Owner pinned at top.
//    2. Add people — username with exists-check on blur ("No user
//       with that username"), then a checklist of the owner's
//       workbooks, each with its own role dropdown.
//  Only ever opened for owners; the server re-checks every call.
//  No link sharing, no ownership transfer (cut for beta, Plan v3).
// ============================================================
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ROLES = [['viewer', 'Viewer'], ['commenter', 'Commenter'], ['editor', 'Editor']];
const roleSelect = (name, cur = 'viewer') =>
  `<select class="sh-role" data-rolefor="${escH(name)}">${ROLES.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

/**
 * @param {object} opts
 *  store        ServerStore
 *  workbookId   the workbook this dialog was opened from
 *  workbookName display name
 *  myWorkbooks  [{id, name}] everything the current user OWNS (for the checklist)
 *  onChanged    called after any grant/revoke so the sidebar can refresh
 */
export function openShareDialog({ store, workbookId, workbookName, myWorkbooks = [], onChanged }) {
  const back = document.createElement('div'); back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal sh-modal">
    <h3>${icon('users', { size: 15 })} Share “${escH(workbookName)}”</h3>

    <div class="set-sec">People with access</div>
    <div id="shAccess" class="sh-access"><span class="muted">Loading…</span></div>

    <div class="set-sec">Add people</div>
    <div class="form-row" style="margin-bottom:6px">
      <label>Username</label>
      <input id="shUser" placeholder="their Mono username" autocomplete="off" spellcheck="false">
      <div class="ag-hint" id="shUserHint"></div>
    </div>
    <div class="form-row">
      <label>Share these workbooks</label>
      <div class="sh-wblist" id="shWbList">
        ${myWorkbooks.map((w) => `
          <div class="sh-wbrow">
            <label class="sh-wbname"><input type="checkbox" data-wb="${escH(w.id)}" ${w.id === workbookId ? 'checked' : ''}> ${escH(w.name)}</label>
            ${roleSelect('wb:' + w.id)}
          </div>`).join('') || '<span class="muted">You don’t own any workbooks.</span>'}
      </div>
    </div>
    <div class="modal-actions" style="justify-content:space-between">
      <span class="muted" style="font-size:11px">Named users only — no links, no transfer. Access is checked on every request.</span>
      <span>
        <button class="btn btn-ghost" id="shClose">Close</button>
        <button class="btn btn-primary" id="shSave">Share</button>
      </span>
    </div>
  </div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  $('#shClose').onclick = () => back.remove();

  /* ---- manage access ---- */
  const paintAccess = async () => {
    const box = $('#shAccess');
    const data = await store.acl(workbookId);
    if (!data || !data.ok) { box.innerHTML = '<span class="muted">Could not load access list.</span>'; return; }
    const rows = [
      `<div class="sh-person"><span class="sh-avatar">${icon('user', { size: 12 })}</span><b>${escH(data.owner?.username || '')}</b><span class="sh-owner-tag">Owner</span></div>`,
      ...data.grants.map((g) => `
        <div class="sh-person" data-user="${escH(g.username)}">
          <span class="sh-avatar">${icon('user', { size: 12 })}</span>
          <span class="sh-name">${escH(g.username)}</span>
          ${roleSelect('grant:' + g.username, g.role)}
          <button class="xmini sh-revoke" data-revoke="${escH(g.username)}" title="Remove access">${icon('x', { size: 11 })}</button>
        </div>`),
    ];
    box.innerHTML = rows.join('') + (data.grants.length === 0 ? '<div class="muted" style="padding:4px 2px;font-size:12px">Only you so far.</div>' : '');

    box.querySelectorAll('select[data-rolefor^="grant:"]').forEach((sel) => sel.addEventListener('change', async () => {
      const username = sel.dataset.rolefor.slice(6);
      const r = await store.share(workbookId, username, sel.value);
      if (r.ok) { toast(`${username} is now ${sel.value}`); onChanged?.(); }
      else toast('Could not change role');
    }));
    box.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      const username = b.dataset.revoke;
      if (!confirm(`Remove ${username}'s access to “${workbookName}”?`)) return;
      const ok = await store.revoke(workbookId, username);
      if (ok) { toast(`Removed ${username} — takes effect immediately`); paintAccess(); onChanged?.(); }
      else toast('Could not revoke');
    }));
  };
  paintAccess();

  /* ---- add people ---- */
  let userValid = null;
  const hint = $('#shUserHint');
  const checkUser = async () => {
    const u = $('#shUser').value.trim().toLowerCase();
    userValid = null; hint.textContent = ''; hint.className = 'ag-hint';
    if (!u) return;
    const j = await store.checkUser(u);
    if (j.exists) { userValid = j.username; hint.textContent = '✓ ' + j.username; hint.className = 'ag-hint good'; }
    else { hint.textContent = 'No user with that username'; hint.className = 'ag-hint bad'; }
  };
  $('#shUser').addEventListener('blur', checkUser);
  $('#shUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); checkUser(); } });

  $('#shSave').onclick = async () => {
    await checkUser();
    if (!userValid) { hint.textContent = hint.textContent || 'Enter a username first'; hint.className = 'ag-hint bad'; return; }
    const picks = [...back.querySelectorAll('#shWbList input[type="checkbox"]:checked')].map((cb) => ({
      id: cb.dataset.wb,
      role: back.querySelector(`select[data-rolefor="wb:${cb.dataset.wb}"]`)?.value || 'viewer',
      name: myWorkbooks.find((w) => w.id === cb.dataset.wb)?.name || cb.dataset.wb,
    }));
    if (!picks.length) { toast('Tick at least one workbook'); return; }
    let done = 0, failed = [];
    for (const p of picks) {
      const r = await store.share(p.id, userValid, p.role);
      if (r.ok) done++; else failed.push(p.name + (r.error === 'self' ? ' (that’s you)' : ''));
    }
    if (done) toast(`Shared ${done} workbook${done === 1 ? '' : 's'} with ${userValid}`);
    if (failed.length) toast('Could not share: ' + failed.join(', '), 4000);
    $('#shUser').value = ''; userValid = null; hint.textContent = '';
    paintAccess(); onChanged?.();
  };
}

