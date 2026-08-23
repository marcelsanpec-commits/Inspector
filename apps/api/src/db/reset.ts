import { rm } from 'node:fs/promises';
import { env } from '../env.js';

/**
 * Deletes the local PGlite data directory and local storage output so
 * `npm run db:reset && npm run seed` gives a clean slate. Refuses to touch
 * anything when a real DATABASE_URL is configured.
 */
if (env.DATABASE_URL) {
  console.error(
    'Refusing to reset: DATABASE_URL is set, which means this points at a ' +
      'real Postgres instance. Drop it from the provider dashboard instead.',
  );
  process.exit(1);
}

await rm(env.PGLITE_DIR, { recursive: true, force: true });
await rm(env.LOCAL_STORAGE_DIR, { recursive: true, force: true });

console.log(`Removed ${env.PGLITE_DIR}`);
console.log(`Removed ${env.LOCAL_STORAGE_DIR}`);
console.log('Run `npm run seed` to rebuild.');
