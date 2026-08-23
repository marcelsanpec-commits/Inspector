import { defineConfig } from 'drizzle-kit';

/**
 * Only used by `drizzle-kit generate`, which reads the schema and emits SQL.
 * It never needs a live connection, so the same config produces migrations that
 * apply cleanly to PGlite locally and to Neon/Supabase in production.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
});
