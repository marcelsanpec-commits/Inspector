import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import type { StorageAdapter, UploadTicket } from './index.js';
import { signToken } from './tokens.js';

/**
 * Filesystem-backed storage that behaves like S3 from the client's point of
 * view. Uploads go to a signed URL the API serves at /storage/*, so the browser
 * code path is identical to the one that will talk to R2.
 */
export function createLocalStorage(): StorageAdapter {
  const root = env.LOCAL_STORAGE_DIR;

  /**
   * Storage keys come from our own code, never user input - but resolving and
   * re-checking the prefix costs nothing and stops a traversal bug from ever
   * becoming a file-write-anywhere bug.
   */
  function resolveKey(key: string): string {
    const full = path.resolve(root, key);
    const rootWithSep = path.resolve(root) + path.sep;
    if (!full.startsWith(rootWithSep)) {
      throw new Error(`Refusing to resolve storage key outside root: ${key}`);
    }
    return full;
  }

  return {
    name: 'local',

    async createUploadUrl({ key, contentType, maxBytes, ttlSeconds = 900 }) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const token = signToken({ key, op: 'put', contentType, maxBytes, exp });
      const ticket: UploadTicket = {
        uploadUrl: `${env.PUBLIC_API_URL}/storage/upload?token=${encodeURIComponent(token)}`,
        method: 'PUT',
        headers: { 'content-type': contentType },
        expiresAt: new Date(exp * 1000).toISOString(),
      };
      return ticket;
    },

    async createDownloadUrl({ key, ttlSeconds = 900 }) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const token = signToken({ key, op: 'get', exp });
      return `${env.PUBLIC_API_URL}/storage/object?token=${encodeURIComponent(token)}`;
    },

    async putObject({ key, body }) {
      const full = resolveKey(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
    },

    async statObject(key) {
      try {
        const s = await stat(resolveKey(key));
        return { size: s.size };
      } catch {
        return null;
      }
    },

    async deleteObject(key) {
      await rm(resolveKey(key), { force: true });
    },
  };
}

/** Used by the /storage routes, which are only mounted for the local driver. */
export function localPaths() {
  const root = env.LOCAL_STORAGE_DIR;
  return {
    root,
    resolve(key: string) {
      const full = path.resolve(root, key);
      const rootWithSep = path.resolve(root) + path.sep;
      if (!full.startsWith(rootWithSep)) return null;
      return full;
    },
    createReadStream,
  };
}
