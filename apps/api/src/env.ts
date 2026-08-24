import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

// .env.local wins over .env; neither is required for local development.
for (const file of ['.env.local', '.env']) {
  const full = path.join(REPO_ROOT, file);
  if (existsSync(full)) dotenv.config({ path: full });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),

  /** Empty locally: the API then runs PGlite, persisted to ./.data/pglite. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default(path.join(REPO_ROOT, '.data', 'pglite')),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default(path.join(REPO_ROOT, 'storage')),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('inspectorone-media'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),

  /** Signs storage upload/download tokens. Required in production. */
  SIGNING_SECRET: z.string().optional(),

  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  INVITE_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),

  PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  /** Where invite links point. */
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:5175'),

  /**
   * With no email provider configured, invite links are logged to the server
   * console and returned in the API response so the whole flow works offline.
   * Refused in production, where a link sitting in a log is a live credential.
   */
  EMAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('InspectorOne <noreply@example.com>'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;
const isProd = raw.NODE_ENV === 'production';

if (isProd && !raw.DATABASE_URL) {
  console.error(
    'FATAL: DATABASE_URL is required in production. PGlite is a local-development ' +
      'database and its contents do not survive a Render deploy.',
  );
  process.exit(1);
}

if (isProd && !raw.SIGNING_SECRET) {
  console.error('FATAL: SIGNING_SECRET is required in production.');
  process.exit(1);
}

/**
 * The console email driver prints invite links to the log, where anyone with
 * log access could redeem them. That is a real hazard, but refusing to BOOT
 * over it blocks a first deploy for no good reason - you can sign up directly
 * and never touch an invite.
 *
 * So the server starts and warns loudly, and `sendInviteEmail` refuses at the
 * point where a link would actually be written to a log. The safety property
 * is preserved; the deploy is not held hostage to it.
 */
if (isProd && raw.EMAIL_DRIVER === 'console') {
  console.warn(
    '\nWARNING: EMAIL_DRIVER=console in production. The server will start, but ' +
      'sending invitations is disabled - an invite link printed to a log is a ' +
      'live credential. Set EMAIL_DRIVER=resend and RESEND_API_KEY to enable ' +
      'invites.\n',
  );
}

/**
 * Local storage in production writes photos to the instance filesystem, which
 * Render replaces on every deploy. Inspection photos are the one thing in this
 * system that cannot be regenerated, so losing them silently is unacceptable.
 */
if (isProd && raw.STORAGE_DRIVER === 'local') {
  console.warn(
    '\nWARNING: STORAGE_DRIVER=local in production. Uploaded photos are written ' +
      'to this instance and WILL BE PERMANENTLY LOST on the next deploy or ' +
      'restart. Fine for a first look; configure R2 before real inspections.\n',
  );
}

if (raw.STORAGE_DRIVER === 's3') {
  const missing = (['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const).filter(
    (k) => !raw[k],
  );
  if (!raw.S3_ENDPOINT && !raw.R2_ACCOUNT_ID) {
    missing.push('R2_ACCOUNT_ID' as never);
  }
  if (missing.length) {
    console.error(`FATAL: STORAGE_DRIVER=s3 but missing: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export const env = {
  ...raw,
  isProd,
  isDev: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  // Ephemeral in development so nobody has to invent one; required in prod.
  SIGNING_SECRET: raw.SIGNING_SECRET ?? randomBytes(32).toString('hex'),
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  s3Endpoint:
    raw.S3_ENDPOINT ??
    (raw.R2_ACCOUNT_ID
      ? `https://${raw.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined),
};

export type Env = typeof env;
