import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

/**
 * PGlite and node-postgres expose the same Drizzle query surface, so we type
 * everything against one of them and cast at construction. This is what keeps
 * `DATABASE_URL=` (local, PGlite) and a Neon connection string (production)
 * from needing two code paths anywhere else in the app.
 */
export type Db = NodePgDatabase<typeof schema>;

export type DriverKind = 'pglite' | 'postgres';

let cached: { db: Db; kind: DriverKind; close: () => Promise<void> } | null =
  null;

export async function getDb() {
  if (cached) return cached;

  if (env.DATABASE_URL) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pgModule = await import('pg');
    const Pool = pgModule.default?.Pool ?? pgModule.Pool;
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      // Neon and Supabase both terminate TLS at the pooler with certs Node
      // won't chain by default.
      ssl: env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    });
    cached = {
      db: drizzle(pool, { schema }),
      kind: 'postgres',
      close: async () => {
        await pool.end();
      },
    };
    return cached;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  // 'memory://' gives each test file a private throwaway database.
  let client: InstanceType<typeof PGlite>;
  if (env.PGLITE_DIR === 'memory://') {
    client = new PGlite();
  } else {
    // PGlite's own mkdir is non-recursive, so the parent must already exist.
    const { mkdirSync } = await import('node:fs');
    const nodePath = await import('node:path');
    mkdirSync(nodePath.dirname(env.PGLITE_DIR), { recursive: true });
    client = new PGlite(env.PGLITE_DIR);
  }
  await client.waitReady;
  cached = {
    db: drizzle(client, { schema }) as unknown as Db,
    kind: 'pglite',
    close: async () => {
      await client.close();
    },
  };
  return cached;
}

export async function closeDb() {
  if (!cached) return;
  await cached.close();
  cached = null;
}

export { schema };
