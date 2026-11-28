/**
 * The production dashboard: its page at /dashboard and its data routes at
 * /exec, which is the address the page was written to talk to (the Apps
 * Script web-app URL). The dashboard's own router (doGet / doPost in
 * legacy-dashboard/Code.js) decides everything; this only carries requests
 * to it and its answers back.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { rt, run } from '../app.js';
import { ssoSnippet, switcherSnippet } from './sso.js';

/* Added to the page as it is served; the file itself is untouched. The style
   lets the side menu scroll on a short screen instead of spilling out of it. */
const HEAD_EXTRA = '<style>.side{overflow-y:auto;overscroll-behavior:contain}.side>*{flex-shrink:0}</style>' + ssoSnippet('dash') + switcherSnippet('dash');

function send(reply: FastifyReply, out: any) {
  reply.header('Cache-Control', 'no-store');
  if (!out || typeof out._content !== 'string') return reply.type('application/json').send('{"ok":false,"error":"no answer"}');
  if (out._kind === 'html') return reply.type('text/html; charset=utf-8').send(out._content);
  return reply.type(out._kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8').send(out._content);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  if (!rt.has('doGet') || !rt.has('page_')) return;          // dashboard source not installed

  app.get('/dashboard', async (_req, reply) => {
    const out: any = await run('doGet', [{ parameter: {} }]);
    if (out && out._kind === 'html') out._content = out._content.replace(/<head([^>]*)>/i, (m: string) => m + HEAD_EXTRA);
    return send(reply, out);
  });

  app.get('/exec', async (req, reply) => {
    const q = (req.query || {}) as Record<string, string>;
    /* Links in Telegram alerts point here with ?app=forms. */
    if (q.app === 'forms') {
      const rest = new URLSearchParams(q); rest.delete('app');
      return reply.redirect('/?' + rest.toString());
    }
    if (!q.api) return reply.redirect('/dashboard');
    return send(reply, await run('doGet', [{ parameter: q }]));
  });

  app.post('/exec', async (req, reply) => {
    const q = (req.query || {}) as Record<string, string>;
    const contents = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (/"action"\s*:\s*"login"/.test(contents)) await sleep(250);   // the pause the logic asks for on sign-in
    return send(reply, await run('doPost', [{ parameter: q, postData: { contents, type: 'text/plain' } }]));
  });
}
