import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/**
 * Signed capability tokens for the local storage driver.
 *
 * These mirror what an S3/R2 presigned URL gives you: a short-lived, single-key,
 * single-operation grant that the client can use directly without holding any
 * credential. Building against these locally means the browser upload code is
 * exercised for real - swapping in R2 changes configuration, not the flow.
 */

export interface StorageToken {
  key: string;
  op: 'put' | 'get';
  contentType?: string;
  maxBytes?: number;
  /** Unix seconds. */
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(payload: string): string {
  return b64url(
    createHmac('sha256', env.SIGNING_SECRET).update(payload).digest(),
  );
}

export function signToken(token: StorageToken): string {
  const payload = b64url(JSON.stringify(token));
  return `${payload}.${hmac(payload)}`;
}

export function verifyToken(raw: string): StorageToken | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = hmac(payload);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: StorageToken;
  try {
    parsed = JSON.parse(fromB64url(payload).toString('utf8')) as StorageToken;
  } catch {
    return null;
  }

  if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (parsed.op !== 'put' && parsed.op !== 'get') return null;
  if (typeof parsed.key !== 'string' || !parsed.key) return null;

  return parsed;
}
