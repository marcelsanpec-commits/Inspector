/**
 * Read-only summary of whatever DATABASE_URL points at - or local PGlite when
 * it is unset. Useful for answering "what is actually in my database?"
 * without opening a SQL client.
 *
 *   npm run db:snapshot
 */
import { closeDb, getDb } from './client.js';
import { env } from '../env.js';
import {
  jobs,
  memberships,
  organizations,
  photos,
  sites,
  users,
} from './schema.js';

const { db } = await getDb();

console.log(
  `READ-ONLY snapshot of ${env.DATABASE_URL ? 'the REMOTE database' : 'local PGlite'}\n`,
);

const orgRows = await db
  .select({ name: organizations.name, type: organizations.type })
  .from(organizations);
const userRows = await db
  .select({
    email: users.email,
    name: users.name,
    role: users.signupRole,
    accountId: users.accountId,
    created: users.createdAt,
  })
  .from(users)
  .orderBy(users.createdAt);
const jobRows = await db
  .select({ number: jobs.jobNumber, title: jobs.title, status: jobs.status })
  .from(jobs);
const siteRows = await db.select({ name: sites.name }).from(sites);
const photoRows = await db.select({ id: photos.id }).from(photos);
const membershipRows = await db.select({ id: memberships.id }).from(memberships);

console.log(`ORGANIZATIONS (${orgRows.length})`);
for (const o of orgRows) console.log(`  ${String(o.type).padEnd(20)}${o.name}`);

console.log(`\nACCOUNTS (${userRows.length})`);
for (const u of userRows) {
  console.log(
    `  ${String(u.role).padEnd(19)}${u.email.padEnd(34)}${u.accountId}  ${u.name}`,
  );
}

console.log(
  `\nmemberships: ${membershipRows.length}   sites: ${siteRows.length}   jobs: ${jobRows.length}   photos: ${photoRows.length}`,
);
for (const j of jobRows) {
  console.log(`  ${j.number}  ${String(j.status).padEnd(12)}${j.title}`);
}

await closeDb();
