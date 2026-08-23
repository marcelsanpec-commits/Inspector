import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authenticate, bearerFrom } from './auth/index.js';
import { HttpError } from './authz.js';
import { env } from './env.js';
import { authRoutes } from './routes/auth.js';
import { jobRoutes } from './routes/jobs.js';
import { orgRoutes } from './routes/orgs.js';
import { photoRoutes } from './routes/photos.js';
import { siteRoutes } from './routes/sites.js';
import { storageRoutes } from './routes/storage.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.isTest ? false : { level: env.LOG_LEVEL },
    // Generous enough for one compressed inspection photo. Only the local
    // storage driver ever receives a body this large; with R2 the bytes bypass
    // the API entirely.
    bodyLimit: 16 * 1024 * 1024,
  });

  // Raw passthrough so /storage/upload receives an untouched Buffer.
  app.addContentTypeParser(
    [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/octet-stream',
    ],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
    allowedHeaders: ['content-type', 'authorization'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  /**
   * Resolve identity once per request. Routes call `requirePrincipal`, which
   * throws 401 when nothing resolved - so a route cannot accidentally run
   * unauthenticated by forgetting a guard.
   */
  app.addHook('onRequest', async (req) => {
    // Signed-token and public endpoints authenticate themselves and must stay
    // reachable without a session, exactly like a presigned S3 URL.
    if (
      req.url.startsWith('/storage/') ||
      req.url.startsWith('/healthz') ||
      req.url.startsWith('/api/auth/signup') ||
      req.url.startsWith('/api/auth/login') ||
      req.url.startsWith('/api/auth/invite')
    ) {
      return;
    }
    req.sessionToken = bearerFrom(req) ?? undefined;
    req.principal = (await authenticate(req)) ?? undefined;
  });

  // Logout needs the raw token even though it is not a guarded route.
  app.addHook('preHandler', async (req) => {
    if (!req.sessionToken) req.sessionToken = bearerFrom(req) ?? undefined;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }

    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'Request failed validation',
          details: err.flatten(),
        },
      });
    }

    req.log.error({ err }, 'Unhandled error');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        // Never leak internals to a client portal.
        message: env.isProd
          ? 'Internal server error'
          : err instanceof Error
            ? err.message
            : String(err),
      },
    });
  });

  app.get('/healthz', async () => ({
    ok: true,
    storage: env.STORAGE_DRIVER,
    email: env.EMAIL_DRIVER,
    database: env.DATABASE_URL ? 'postgres' : 'pglite',
  }));

  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(siteRoutes);
  await app.register(jobRoutes);
  await app.register(photoRoutes);
  if (env.STORAGE_DRIVER === 'local') {
    await app.register(storageRoutes);
  }

  return app;
}
