/**
 * Background jobs. The logic registers them itself, as it did with Apps
 * Script triggers ("alertScan every 5 minutes", "telegramPoll every minute");
 * this runs whatever is registered, on time, one at a time.
 */
import { rt, wb, run } from './app.js';
import { listTriggers } from './gas/services.js';

const lastRun = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let busy = false;

async function tick(log: { warn: (o: any, m: string) => void }): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    rt.cache.sweep();
    const now = Date.now();
    for (const t of listTriggers(wb)) {
      if (!(t.everyMinutes > 0)) continue;
      const due = (lastRun.get(t.id) || 0) + t.everyMinutes * 60000 - 2000;
      if (now < due || !rt.has(t.handler)) continue;
      lastRun.set(t.id, now);
      try { await run(t.handler, []); }
      catch (e: any) { log.warn({ job: t.handler, err: String((e && e.message) || e) }, 'scheduled job failed'); }
    }
  } finally { busy = false; }
}

export function startScheduler(log: { warn: (o: any, m: string) => void }): void {
  if (timer) return;
  timer = setInterval(() => { void tick(log); }, 15000);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
