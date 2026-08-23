import { buildApp } from './app.js';
import { closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';

async function main() {
  // Applying migrations at boot keeps local development to a single command and
  // matches how the Render deploy will run them.
  const driver = await runMigrations();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  app.log.info(
    { database: driver, storage: env.STORAGE_DRIVER, email: env.EMAIL_DRIVER },
    'InspectorOne API ready',
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      app.log.info(`${signal} received, shutting down`);
      await app.close();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
