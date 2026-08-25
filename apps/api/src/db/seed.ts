import { closeDb } from './client.js';
import { seed } from './seed-data.js';
import { env } from '../env.js';

// `npm run seed -- --force` to overwrite a database that already holds data.
const force = process.argv.includes('--force');

if (env.DATABASE_URL) {
  const host = (() => {
    try {
      return new URL(env.DATABASE_URL).host;
    } catch {
      return 'the configured database';
    }
  })();
  console.log(`Seeding REMOTE database at ${host}${force ? ' (--force)' : ''}`);
} else {
  console.log('Seeding local PGlite database');
}

seed({ force })
  .then(closeDb)
  .catch(async (err) => {
    console.error('\nSeed failed:', err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
