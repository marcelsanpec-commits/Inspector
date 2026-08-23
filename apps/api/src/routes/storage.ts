import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../authz.js';
import { localPaths } from '../storage/local.js';
import { verifyToken } from '../storage/tokens.js';

/**
 * Endpoints backing the local storage driver. Mounted only when
 * STORAGE_DRIVER=local; with R2 these URLs point at Cloudflare instead and the
 * API is out of the data path entirely.
 *
 * Authorization here comes purely from the signed token, exactly as it does
 * with a presigned S3 URL - no session, no cookie.
 */
export async function storageRoutes(app: FastifyInstance) {
  const paths = localPaths();

  app.put<{ Querystring: { token?: string } }>(
    '/storage/upload',
    async (req, reply) => {
      const token = req.query.token ? verifyToken(req.query.token) : null;
      if (!token || token.op !== 'put') {
        throw new HttpError(403, 'invalid_token', 'Invalid or expired upload token');
      }

      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        throw new HttpError(
          400,
          'invalid_body',
          'Expected a raw image body with a matching content-type header',
        );
      }

      if (token.contentType && req.headers['content-type'] !== token.contentType) {
        throw new HttpError(
          400,
          'content_type_mismatch',
          `Token was issued for ${token.contentType}`,
        );
      }

      if (token.maxBytes && body.length > token.maxBytes) {
        throw new HttpError(
          413,
          'too_large',
          `Body is ${body.length} bytes; token allows ${token.maxBytes}`,
        );
      }

      const full = paths.resolve(token.key);
      if (!full) throw new HttpError(400, 'invalid_key', 'Invalid storage key');

      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);

      reply.header('etag', `"${body.length}"`);
      return reply.code(200).send({ ok: true, bytes: body.length });
    },
  );

  app.get<{ Querystring: { token?: string } }>(
    '/storage/object',
    async (req, reply) => {
      const token = req.query.token ? verifyToken(req.query.token) : null;
      if (!token || token.op !== 'get') {
        throw new HttpError(403, 'invalid_token', 'Invalid or expired download token');
      }

      const full = paths.resolve(token.key);
      if (!full) throw new HttpError(400, 'invalid_key', 'Invalid storage key');

      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        throw new HttpError(404, 'not_found', 'Object not found');
      }

      const ext = path.extname(full).toLowerCase();
      const type =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.pdf'
              ? 'application/pdf'
              : 'image/jpeg';

      reply.header('content-type', type);
      reply.header('content-length', size);
      reply.header('cache-control', 'private, max-age=600');
      return reply.send(paths.createReadStream(full));
    },
  );
}
