const TOKEN_KEY = 'levanto.admin.token';

export function getToken(): string | null {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}
export function setToken(t: string | null): void {
  if (t) { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); return; }
  /* Signing out here signs out of the forms app and dashboard too. */
  for (const k of [TOKEN_KEY, 'sw_tok', 'slabworksKey']) localStorage.removeItem(k);
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

let onSignedOut: (() => void) | null = null;
export function whenSignedOut(f: () => void): void { onSignedOut = f; }

export async function api<T = any>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) };
  const tk = getToken();
  if (tk) headers.Authorization = 'Bearer ' + tk;
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  let res: Response;
  try { res = await fetch('/api/admin' + path, { ...opts, headers, body }); }
  catch { throw new ApiError('The server could not be reached. Check the connection and try again.', 0); }
  let data: any = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data || data.ok === false) {
    if (res.status === 401 && path !== '/login') { setToken(null); onSignedOut?.(); }
    throw new ApiError((data && data.error) || 'The server answered HTTP ' + res.status + '.', res.status);
  }
  return data as T;
}

export interface FormInfo { key: string; no: number; title: string; abbr: string }
export interface User {
  row: number; username: string; display: string; assigned: string; all: boolean; forms: string[];
  active: boolean; hasPassword: boolean; lastLogin: string; role: string; telegramLinked: boolean;
}
export interface TabInfo {
  id: number; name: string; hidden: boolean; rows: number; cols: number; computed: boolean;
}
export interface AuditEntry {
  id: string; at: string; actor: string; action: string; tab: string | null; row_no: number | null;
  col_no: number | null; old_val: string | null; new_val: string | null; detail: any;
}
