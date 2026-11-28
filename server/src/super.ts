/**
 * Super admins: the few administrators who may see and change the raw data
 * (Mono Sheets), import a workbook over it, and download it whole.
 *
 * A person is a super admin when the "Super Admin" column on their App Users
 * row says YES, or their username is listed in SUPER_ADMINS. The setting is
 * what guarantees there is always one: a column can be lost to an import, a
 * setting cannot. Being a super admin also requires being an active admin.
 */
import { rt, wb } from './app.js';

export const SUPER_HEADER = 'Super Admin';

function named(): string[] {
  return String(process.env.SUPER_ADMINS === undefined ? 'admin' : process.env.SUPER_ADMINS)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function superColumn(): number {
  const t = wb.tab(String(rt.global('FORMS_CFG').USERS_TAB));
  if (!t) return 0;
  for (let c = 1; c <= t.lastCol(); c++) if (String(t.get(1, c)).trim() === SUPER_HEADER) return c;
  return 0;
}

/** Fixed by the server's settings, so it cannot be switched off from the panel. */
export function isNamedSuper(username: string): boolean {
  return named().indexOf(String(username || '').trim().toLowerCase()) !== -1;
}

export function isSuper(username: string): boolean {
  const u: any = rt.call('fFindUser_', [username]);
  if (!u || !u.active || u.role !== 'admin') return false;
  if (isNamedSuper(u.username)) return true;
  const col = superColumn();
  if (!col) return false;
  const t = wb.tab(String(rt.global('FORMS_CFG').USERS_TAB))!;
  return String(t.get(u.row, col)).trim().toUpperCase() === 'YES';
}
