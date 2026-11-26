import { config } from './config.js';
import { migrate, pool } from './db.js';
import { boot, wb } from './app.js';
import { buildServer } from './server.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const t0 = Date.now();
await migrate();
await boot();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
app.log.info({ tabs: wb.tabs.length, ms: Date.now() - t0 }, 'data loaded');
if (config.scheduler) startScheduler(app.log);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  stopScheduler();
  try { await app.close(); await wb.flush(); await pool.end(); } finally { process.exit(0); }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
