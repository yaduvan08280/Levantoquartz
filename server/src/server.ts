import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { formsRoutes } from './routes/forms.js';
import { adminRoutes } from './routes/admin.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { ssoRoutes } from './routes/sso.js';
import { monoRoutes } from './routes/mono.js';
import { marketingRoutes } from './routes/marketing.js';
import { wb } from './app.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.LOG === 'off' ? false : { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy
  });
  await app.register(compress, { threshold: 1024 });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });

  app.get('/healthz', async () => ({ ok: true, tabs: wb.tabs.length, loadedAt: wb.loadedAt }));

  const media = path.join(config.dataDir, 'media');
  fs.mkdirSync(media, { recursive: true });
  await app.register(fastifyStatic, { root: media, prefix: '/media/', index: false, decorateReply: false, maxAge: '30d' });

  /* The dashboard posts JSON as text/plain (it did so to avoid a CORS preflight). */
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  await app.register(formsRoutes);
  await app.register(dashboardRoutes);
  await app.register(ssoRoutes);
  await app.register(marketingRoutes);
  await app.register(monoRoutes);
  await app.register(adminRoutes);

  if (fs.existsSync(config.adminDir)) {
    await app.register(fastifyStatic, { root: config.adminDir, prefix: '/admin/', decorateReply: false, redirect: true });
  }
  return app;
}
