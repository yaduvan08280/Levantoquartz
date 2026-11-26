import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { formsRoutes } from './routes/forms.js';
import { adminRoutes } from './routes/admin.js';
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

  await app.register(formsRoutes);
  await app.register(adminRoutes);

  if (fs.existsSync(config.adminDir)) {
    await app.register(fastifyStatic, { root: config.adminDir, prefix: '/admin/', decorateReply: false, redirect: true });
  }
  return app;
}
