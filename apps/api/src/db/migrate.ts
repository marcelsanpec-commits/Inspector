import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../drizzle');

/**
 * Applies the SQL in apps/api/drizzle to whatever database is configured.
 * The same migration files run against PGlite locally and Neon/Supabase in
 * production - that equivalence is the entire reason we don't use SQLite.
 */
export async function runMigrations() {
  const { db, kind } = await getDb();

  if (kind === 'postgres') {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
  }

  return kind;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  runMigrations()
    .then(async (kind) => {
      console.log(`Migrations applied (${kind}).`);
      await closeDb();
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await closeDb();
      process.exit(1);
    });
}
