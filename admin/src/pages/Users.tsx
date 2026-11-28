import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type FormInfo, type User } from '../api';

interface Draft {
  username: string; display: string; role: string; active: boolean; all: boolean; forms: string[];
  password: string; isNew: boolean; telegramLinked: boolean; unlinkTelegram: boolean;
  super: boolean; superFixed: boolean;
}

const ROLE_HELP: Record<string, string> = {
  admin: 'Every form, the Feedback page, and this admin panel',
  supervisor: 'Their forms, plus grade alerts in the app and on Telegram',
  operator: 'Their own forms only'
};

export function Users({ me, isSuper }: { me: string; isSuper: boolean }) {
  const [users, setUsers] = useState<User[]>([]);
  const [forms, setForms] = useState<FormInfo[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'all'>('active');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/users').then((r) => { setUsers(r.users); setForms(r.forms); setRoles(r.roles); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const title = useMemo(() => Object.fromEntries(forms.map((f) => [f.key, f.title])), [forms]);
  const list = users.filter((u) => (show === 'all' || u.active) &&
    (!q || (u.username + ' ' + u.display).toLowerCase().includes(q.toLowerCase())));
  const inactive = users.filter((u) => !u.active).length;

  const edit = (u: User) => setDraft({
    username: u.username, display: u.display, role: u.role, active: u.active, all: u.all,
    forms: u.all ? [] : u.forms, password: '', isNew: false, telegramLinked: u.telegramLinked, unlinkTelegram: false,
    super: u.super, superFixed: u.superFixed
  });
  const add = () => setDraft({
    username: '', display: '', role: 'operator', active: true, all: false, forms: [], password: '',
    isNew: true, telegramLinked: false, unlinkTelegram: false, super: false, superFixed: false
  });

  return (
    <>
      <header className="head">
        <div><h1>Users</h1><p className="muted">Who can sign in to the forms app, and which forms each person sees.</p></div>
        <button className="btn primary" onClick={add}>Add user</button>
      </header>
      {error && <div className="alert err">{error}</div>}
      <div className="toolbar">
        <input className="search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          <button className={show === 'active' ? 'on' : ''} onClick={() => setShow('active')}>Active ({users.length - inactive})</button>
          <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All ({users.length})</button>
        </div>
      </div>
      <section className="card">
        <table className="tbl hover">
          <thead><tr><th>User</th><th>Role</th><th>Forms</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.username} className={u.active ? '' : 'off'} onClick={() => edit(u)}>
                <td><b>{u.display}</b><div className="sub">{u.username}{u.username.toLowerCase() === me.toLowerCase() ? ' · you' : ''}</div></td>
                <td>{u.super ? <span className="pill admin">super admin</span> : <span className={'pill ' + u.role}>{u.role}</span>}{!u.active && <span className="pill gone">inactive</span>}{!u.hasPassword && <span className="pill warn">no password</span>}</td>
                <td className="wrap">{u.all ? 'All forms' : u.forms.length ? u.forms.map((k) => title[k] || k).join(', ') : <span className="muted">None</span>}</td>
                <td className="num">{u.lastLogin || <span className="muted">Never</span>}</td>
                <td className="right"><button className="btn sm" onClick={(e) => { e.stopPropagation(); edit(u); }}>Edit</button></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={5} className="muted pad">{loading ? 'Loading…' : q ? 'Nobody matches "' + q + '".' : 'No users yet.'}</td></tr>}
          </tbody>
        </table>
      </section>
      {draft && <Editor draft={draft} me={me} isSuper={isSuper} forms={forms} roles={roles}
        onClose={() => setDraft(null)} onSaved={(list) => { setUsers(list); setDraft(null); }} />}
    </>
  );
}

function Editor({ draft, me, isSuper, forms, roles, onClose, onSaved }: {
  draft: Draft; me: string; isSuper: boolean; forms: FormInfo[]; roles: string[];
  onClose: () => void; onSaved: (users: User[]) => void;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSelf = !d.isNew && d.username.toLowerCase() === me.toLowerCase();
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const toggle = (k: string) => set({ forms: d.forms.includes(k) ? d.forms.filter((x) => x !== k) : d.forms.concat(k) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body: any = { display: d.display, role: d.role, active: d.active, all: d.all, forms: d.forms };
      if (d.password) body.password = d.password;
      if (d.unlinkTelegram) body.unlinkTelegram = true;
      if (isSuper && d.super !== draft.super) body.super = d.super;
      const r = d.isNew
        ? await api('/users', { method: 'POST', json: { ...body, username: d.username, password: d.password } })
        : await api('/users/' + encodeURIComponent(d.username), { method: 'PATCH', json: body });
      onSaved(r.users);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm('Delete ' + d.username + '?\n\nThey will be signed out and can no longer sign in. Entries they made stay as they are. To stop someone for a while, untick "Can sign in" instead.')) return;
    setBusy(true); setError('');
    try { onSaved((await api('/users/' + encodeURIComponent(d.username), { method: 'DELETE' })).users); }
    catch (err: any) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="drawer" onSubmit={save}>
        <header><h2>{d.isNew ? 'Add user' : d.display || d.username}</h2><button type="button" className="x" onClick={onClose} aria-label="Close">&times;</button></header>
        <div className="body">
          {error && <div className="alert err">{error}</div>}
          <div className="two">
            <label>Username
              <input value={d.username} disabled={!d.isNew} autoFocus={d.isNew} autoCapitalize="none" spellCheck={false}
                onChange={(e) => set({ username: e.target.value.toLowerCase().replace(/\s+/g, '') })} required />
              {d.isNew && <small>What they type to sign in. Lower-case, no spaces.</small>}
            </label>
            <label>Display name
              <input value={d.display} onChange={(e) => set({ display: e.target.value })} placeholder={d.username.toUpperCase()} />
            </label>
          </div>
          <label>{d.isNew ? 'Password' : 'New password'}
            <input type="text" value={d.password} onChange={(e) => set({ password: e.target.value })} required={d.isNew}
              minLength={4} autoComplete="off" placeholder={d.isNew ? '' : 'Leave empty to keep the current one'} />
            {!d.isNew && d.password && !isSelf && <small>Saving signs them out everywhere; they sign in again with this.</small>}
          </label>

          <fieldset>
            <legend>Role</legend>
            {roles.map((r) => (
              <label key={r} className="radio">
                <input type="radio" name="role" checked={d.role === r} onChange={() => set({ role: r })} disabled={isSelf && r !== 'admin'} />
                <span><b>{r}</b><i>{ROLE_HELP[r] || ''}</i></span>
              </label>
            ))}
            {isSuper && d.role === 'admin' && (
              <label className="check" style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
                <input type="checkbox" checked={d.super} disabled={d.superFixed || isSelf}
                  onChange={(e) => set({ super: e.target.checked })} />
                <span><b>Super admin</b><i style={{ display: 'block', fontStyle: 'normal', color: 'var(--ink2)', fontSize: 12 }}>
                  {d.superFixed ? 'Always a super admin (set on the server).' : 'Also sees Raw data, and Import & backup'}</i></span>
              </label>
            )}
          </fieldset>

          <fieldset>
            <legend>Forms</legend>
            <label className="check strong"><input type="checkbox" checked={d.all} onChange={(e) => set({ all: e.target.checked })} /> All forms, including any added later</label>
            {!d.all && (
              <div className="grid">
                {forms.map((f) => (
                  <label key={f.key} className="check"><input type="checkbox" checked={d.forms.includes(f.key)} onChange={() => toggle(f.key)} /> {f.title}</label>
                ))}
              </div>
            )}
          </fieldset>

          <label className="check strong">
            <input type="checkbox" checked={d.active} disabled={isSelf} onChange={(e) => set({ active: e.target.checked })} /> Can sign in
          </label>
          {d.telegramLinked && (
            <label className="check"><input type="checkbox" checked={d.unlinkTelegram} onChange={(e) => set({ unlinkTelegram: e.target.checked })} /> Disconnect their Telegram</label>
          )}
        </div>
        <footer>
          {!d.isNew && !isSelf && <button type="button" className="btn bad ghost" onClick={remove} disabled={busy}>Delete user</button>}
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : d.isNew ? 'Add user' : 'Save'}</button>
        </footer>
      </form>
    </div>
  );
}
