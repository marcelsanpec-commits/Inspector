import { count } from 'drizzle-orm';
import { getDb } from './client.js';
import { runMigrations } from './migrate.js';
import { env } from '../env.js';
import { hashPassword } from '../lib/password.js';
import { getStorage, photoKey } from '../storage/index.js';
import {
  clientRelationships,
  invites,
  jobClientViewers,
  jobInspectors,
  jobObjects,
  jobs,
  memberships,
  objects,
  organizations,
  photos,
  reports,
  sessions,
  sites,
  users,
} from './schema.js';

/** Deterministic ids so bookmarks and tests stay valid across re-seeds. */
export const SEED = {
  sanpec: '00000000-0000-4000-8000-000000000001',
  rival: '00000000-0000-4000-8000-000000000002',
  harbor: '00000000-0000-4000-8000-000000000003',
  westline: '00000000-0000-4000-8000-000000000004',

  dana: '00000000-0000-4000-8000-000000000101',
  marcus: '00000000-0000-4000-8000-000000000102',
  priya: '00000000-0000-4000-8000-000000000103',
  jamie: '00000000-0000-4000-8000-000000000104',
  alex: '00000000-0000-4000-8000-000000000105',
  sam: '00000000-0000-4000-8000-000000000106',
  rivalOwner: '00000000-0000-4000-8000-000000000107',
  drifter: '00000000-0000-4000-8000-000000000108',

  siteTower: '00000000-0000-4000-8000-000000000201',
  siteParking: '00000000-0000-4000-8000-000000000202',
  siteWestline: '00000000-0000-4000-8000-000000000203',

  objElevator: '00000000-0000-4000-8000-000000000301',
  objAhu: '00000000-0000-4000-8000-000000000302',
  objDock: '00000000-0000-4000-8000-000000000303',

  job1: '00000000-0000-4000-8000-000000000401',
  job2: '00000000-0000-4000-8000-000000000402',
  job3: '00000000-0000-4000-8000-000000000403',
  job4: '00000000-0000-4000-8000-000000000404',
  job5: '00000000-0000-4000-8000-000000000405',
} as const;

/** Every seeded account shares this password. */
export const SEED_PASSWORD = 'inspector-demo-2026';

// A genuine 1x1 JPEG, so seeded photos actually resolve through the gallery.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

export async function seed({ quiet = false, force = false } = {}) {
  await runMigrations();
  const { db } = await getDb();
  const storage = await getStorage();

  /**
   * Seeding deletes everything first, which is fine for a local scratch
   * database and catastrophic for a real one. Against a configured Postgres
   * that already holds accounts, refuse unless the caller was explicit.
   */
  if (env.DATABASE_URL && !force) {
    const [existing] = await db.select({ n: count() }).from(users);
    if ((existing?.n ?? 0) > 0) {
      throw new Error(
        `Refusing to seed: DATABASE_URL points at a real database that already ` +
          `holds ${existing?.n} account(s), and seeding deletes every row first. ` +
          `Re-run with --force if you genuinely mean to erase it.`,
      );
    }
  }

  // Clear in FK-safe order so re-seeding is repeatable.
  await db.delete(reports);
  await db.delete(photos);
  await db.delete(jobObjects);
  await db.delete(jobClientViewers);
  await db.delete(jobInspectors);
  await db.delete(jobs);
  await db.delete(objects);
  await db.delete(sites);
  await db.delete(clientRelationships);
  await db.delete(invites);
  await db.delete(sessions);
  await db.delete(memberships);
  await db.delete(users);
  await db.delete(organizations);

  const pw = await hashPassword(SEED_PASSWORD);

  await db.insert(organizations).values([
    {
      id: SEED.sanpec,
      type: 'inspection_company',
      name: 'Sanpec Engineering',
      slug: 'sanpec-engineering',
    },
    // A second inspecting company, so cross-tenant isolation tests have
    // something real to fail against.
    {
      id: SEED.rival,
      type: 'inspection_company',
      name: 'Rival Engineering',
      slug: 'rival-engineering',
    },
    {
      id: SEED.harbor,
      type: 'client',
      name: 'Harbor Point Properties',
      slug: 'harbor-point',
    },
    {
      id: SEED.westline,
      type: 'client',
      name: 'Westline Industrial',
      slug: 'westline-industrial',
    },
  ]);

  await db.insert(users).values([
    { id: SEED.dana, email: 'dana@sanpec.example', passwordHash: pw, name: 'Dana Reyes', accountId: 'IO-D4N4RY', signupRole: 'inspection_company' },
    { id: SEED.marcus, email: 'marcus@sanpec.example', passwordHash: pw, name: 'Marcus Hale', accountId: 'IO-M4RCH2', signupRole: 'inspector' },
    { id: SEED.priya, email: 'priya@sanpec.example', passwordHash: pw, name: 'Priya Nair', accountId: 'IO-PRYN33', signupRole: 'inspector' },
    { id: SEED.jamie, email: 'jamie@harborpoint.example', passwordHash: pw, name: 'Jamie Cole', accountId: 'IO-J4M33C', signupRole: 'client' },
    { id: SEED.alex, email: 'alex@harborpoint.example', passwordHash: pw, name: 'Alex Whitfield', accountId: 'IO-4L3XWF', signupRole: 'client' },
    { id: SEED.sam, email: 'sam@westline.example', passwordHash: pw, name: 'Sam Ortiz', accountId: 'IO-S4M2RT', signupRole: 'client' },
    { id: SEED.rivalOwner, email: 'owner@rival.example', passwordHash: pw, name: 'Rival Owner', accountId: 'IO-R2W4L9', signupRole: 'inspection_company' },
    // Signed up, not yet added to any company - the "hand over your ID" state.
    { id: SEED.drifter, email: 'newhire@example.com', passwordHash: pw, name: 'Jordan Blake', accountId: 'IO-J2RD4N', signupRole: 'inspector' },
  ]);

  await db.insert(memberships).values([
    { userId: SEED.dana, orgId: SEED.sanpec, role: 'owner' },
    { userId: SEED.marcus, orgId: SEED.sanpec, role: 'inspector' },
    { userId: SEED.priya, orgId: SEED.sanpec, role: 'inspector' },
    { userId: SEED.jamie, orgId: SEED.harbor, role: 'owner' },
    { userId: SEED.alex, orgId: SEED.harbor, role: 'member' },
    { userId: SEED.sam, orgId: SEED.westline, role: 'owner' },
    { userId: SEED.rivalOwner, orgId: SEED.rival, role: 'owner' },
  ]);

  await db.insert(clientRelationships).values([
    { companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor },
    { companyOrgId: SEED.sanpec, clientOrgId: SEED.westline },
  ]);

  await db.insert(sites).values([
    { id: SEED.siteTower, companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor, name: 'Harbor Point Tower A', addressLine1: '1200 Harbor Blvd', city: 'Houston', state: 'TX', postalCode: '77002', lat: 29.7604, lng: -95.3698 },
    { id: SEED.siteParking, companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor, name: 'Harbor Point Parking Structure', addressLine1: '1210 Harbor Blvd', city: 'Houston', state: 'TX', postalCode: '77002', lat: 29.7608, lng: -95.3702 },
    { id: SEED.siteWestline, companyOrgId: SEED.sanpec, clientOrgId: SEED.westline, name: 'Westline Distribution Center', addressLine1: '8800 Industrial Way', city: 'Katy', state: 'TX', postalCode: '77494', lat: 29.7858, lng: -95.8245 },
  ]);

  await db.insert(objects).values([
    { id: SEED.objElevator, companyOrgId: SEED.sanpec, siteId: SEED.siteTower, serialNumber: 'ELV-4471', label: 'Passenger Elevator 1', objectType: 'Elevator', createdBy: SEED.marcus },
    { id: SEED.objAhu, companyOrgId: SEED.sanpec, siteId: SEED.siteTower, serialNumber: 'AHU-2210', label: 'Rooftop AHU-3', objectType: 'Air handling unit', createdBy: SEED.marcus },
    { id: SEED.objDock, companyOrgId: SEED.sanpec, siteId: SEED.siteWestline, serialNumber: 'DL-88', label: 'Dock Leveler 8', objectType: 'Dock equipment', createdBy: SEED.priya },
  ]);

  const now = Date.now();
  const days = (n: number) => new Date(now + n * 86_400_000);

  await db.insert(jobs).values([
    { id: SEED.job1, companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor, siteId: SEED.siteTower, jobNumber: 'JOB-2026-0001', title: 'Annual structural inspection - Tower A', status: 'in_progress', scheduledFor: days(0), startedAt: days(0) },
    { id: SEED.job2, companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor, siteId: SEED.siteParking, jobNumber: 'JOB-2026-0002', title: 'Parking structure deck survey', status: 'scheduled', scheduledFor: days(3) },
    { id: SEED.job3, companyOrgId: SEED.sanpec, clientOrgId: SEED.westline, siteId: SEED.siteWestline, jobNumber: 'JOB-2026-0003', title: 'Dock equipment condition assessment', status: 'submitted', scheduledFor: days(-4), startedAt: days(-4), submittedAt: days(-3) },
    { id: SEED.job4, companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor, siteId: SEED.siteTower, jobNumber: 'JOB-2026-0004', title: 'Post-storm damage assessment', status: 'delivered', scheduledFor: days(-20), startedAt: days(-20), submittedAt: days(-19), deliveredAt: days(-17) },
    // Delivered but narrowed to named people, to exercise restricted access.
    { id: SEED.job5, companyOrgId: SEED.sanpec, clientOrgId: SEED.harbor, siteId: SEED.siteTower, jobNumber: 'JOB-2026-0005', title: 'Confidential due-diligence walkthrough', status: 'delivered', clientAccess: 'restricted', scheduledFor: days(-30), deliveredAt: days(-28) },
  ]);

  await db.insert(jobInspectors).values([
    { jobId: SEED.job1, userId: SEED.marcus },
    { jobId: SEED.job2, userId: SEED.marcus },
    { jobId: SEED.job3, userId: SEED.priya },
    { jobId: SEED.job4, userId: SEED.priya },
    { jobId: SEED.job5, userId: SEED.priya },
  ]);

  // Only Jamie may see the restricted job - Alex, in the same client org, may not.
  await db.insert(jobClientViewers).values([{ jobId: SEED.job5, userId: SEED.jamie }]);

  await db.insert(jobObjects).values([
    { jobId: SEED.job1, objectId: SEED.objElevator, position: 0 },
    { jobId: SEED.job1, objectId: SEED.objAhu, position: 1 },
    { jobId: SEED.job3, objectId: SEED.objDock, position: 0 },
    { jobId: SEED.job4, objectId: SEED.objAhu, position: 0 },
  ]);

  /**
   * Photo bytes go through whatever storage adapter is configured locally,
   * which is this machine's disk. A remote API cannot read that, so seeding a
   * remote database would produce rows pointing at files it will never find -
   * a gallery of broken images.
   *
   * So skip them here. Photos for a remote database have to arrive the way real
   * ones do: uploaded through the API, into the storage that API is using.
   */
  const skipPhotos = !!env.DATABASE_URL;
  if (skipPhotos && !quiet) {
    console.log(
      '\nSkipping demo photos: the database is remote but storage is local, so ' +
        'the API could not serve them. Upload photos through the app instead.',
    );
  }

  const photoSpecs = skipPhotos ? [] : [
    { jobId: SEED.job1, objectId: SEED.objElevator, caption: 'Machine room overview', voiceNote: 'Governor rope shows light surface corrosion, no measurable loss of section.', include: true },
    { jobId: SEED.job1, objectId: SEED.objElevator, caption: 'Governor rope close-up', voiceNote: null, include: false },
    { jobId: SEED.job1, objectId: SEED.objAhu, caption: 'AHU-3 condensate pan', voiceNote: 'Standing water in the pan, drain appears partially blocked.', include: true },
    { jobId: SEED.job4, objectId: SEED.objAhu, caption: 'Storm damage to housing', voiceNote: 'Access panel torn free, insulation saturated.', include: true },
    { jobId: SEED.job4, objectId: SEED.objAhu, caption: 'Context shot from roof access', voiceNote: null, include: false },
    { jobId: SEED.job3, objectId: SEED.objDock, caption: 'Dock leveler hinge wear', voiceNote: 'Hinge pin walking out approximately 8mm.', include: true },
  ];

  let n = 0;
  for (const spec of photoSpecs) {
    const photoId = `00000000-0000-4000-8000-00000000050${n}`;
    const key = photoKey({
      orgId: SEED.sanpec,
      jobId: spec.jobId,
      photoId,
      contentType: 'image/jpeg',
    });
    await storage.putObject({ key, body: TINY_JPEG, contentType: 'image/jpeg' });
    await db.insert(photos).values({
      id: photoId,
      companyOrgId: SEED.sanpec,
      jobId: spec.jobId,
      objectId: spec.objectId,
      storageKey: key,
      contentType: 'image/jpeg',
      byteSize: TINY_JPEG.length,
      width: 1600,
      height: 1200,
      takenAt: days(-1 - n),
      gpsLat: 29.7604,
      gpsLng: -95.3698,
      caption: spec.caption,
      voiceNote: spec.voiceNote,
      voiceNoteIsDictated: !!spec.voiceNote,
      includeInReport: spec.include,
      status: 'ready',
      uploadedBy: SEED.marcus,
    });
    n++;
  }

  if (!quiet) {
    console.log('');
    console.log(`Seeded. Every account uses the password: ${SEED_PASSWORD}`);
    console.log('');
    console.log('  INSPECTING COMPANY - Sanpec Engineering');
    console.log('    dana@sanpec.example      owner       sees all 5 jobs');
    console.log('    marcus@sanpec.example    inspector   jobs 1, 2');
    console.log('    priya@sanpec.example     inspector   jobs 3, 4, 5');
    console.log('');
    console.log('  CLIENT - Harbor Point Properties');
    console.log('    jamie@harborpoint.example  owner     jobs 4 and 5 (named on 5)');
    console.log('    alex@harborpoint.example   member    job 4 only');
    console.log('');
    console.log('  CLIENT - Westline Industrial');
    console.log('    sam@westline.example       owner     nothing yet (job 3 not delivered)');
    console.log('');
    console.log('  OTHER COMPANY - Rival Engineering');
    console.log('    owner@rival.example        owner     sees nothing of Sanpec');
    console.log('');
    console.log('  UNAFFILIATED INSPECTOR');
    console.log('    newhire@example.com        account ID IO-J2RD4N - add them to test the roster flow');
    console.log('');
  }
}
