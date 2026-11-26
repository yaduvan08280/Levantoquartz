import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The plant runs on India time. Every date the app formats, every "today" and
   every shift boundary is worked out in this zone, as it was in Apps Script
   (appsscript.json: Asia/Kolkata). Must be set before any Date is created. */
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function int(name: string, dflt: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return isFinite(v) ? v : dflt;
}

export const config = {
  root,
  timezone: process.env.TZ!,
  port: int('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgres://levanto:levanto@127.0.0.1:5432/levanto',
  /** Public address of the app, used in links sent out by the Telegram bot. */
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  legacyDir: path.resolve(process.env.LEGACY_DIR || path.join(root, 'legacy')),
  dashboardDir: path.resolve(process.env.DASHBOARD_DIR || path.join(root, 'legacy-dashboard')),
  adminDir: path.resolve(process.env.ADMIN_DIR || path.join(root, 'public', 'admin')),
  migrationsDir: path.join(root, 'migrations'),
  /** Background jobs (grade-alert scan, Telegram poll). Off in tests. */
  scheduler: process.env.SCHEDULER !== 'off',
  trustProxy: process.env.TRUST_PROXY === '1',
  maxBodyBytes: int('MAX_BODY_MB', 30) * 1024 * 1024,
  fetchTimeoutMs: int('FETCH_TIMEOUT_MS', 10000)
};

export type Config = typeof config;
