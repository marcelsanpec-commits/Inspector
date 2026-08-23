import { closeDb } from './client.js';
import { seed } from './seed-data.js';

seed()
  .then(closeDb)
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await closeDb();
    process.exit(1);
  });
