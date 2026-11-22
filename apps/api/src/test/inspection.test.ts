import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = 'memory://';
process.env.STORAGE_DRIVER = 'local';
process.env.SIGNING_SECRET = 'test-signing-secret';
process.env.EMAIL_DRIVER = 'console';
process.env.LOCAL_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), 'io-inspection-'));

const { buildApp } = await import('../app.js');
const { closeDb, getDb } = await import('../db/client.js');
const { photos } = await import('../db/schema.js');
const { photoKey } = await import('../storage/index.js');
const { seed, SEED, SEED_PASSWORD } = await import('../db/seed-data.js');
const { isReportAspect, reportPhotoCrop } = await import('@inspectorone/shared');
const { eq } = await import('drizzle-orm');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const tokens = new Map<string, string>();

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const MARCUS = 'marcus@sanpec.example';
const PRIYA = 'priya@sanpec.example';
const DANA = 'dana@sanpec.example';
const JAMIE = 'jamie@harborpoint.example';

async function login(email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SEED_PASSWORD },
  });
  assert.equal(res.statusCode, 200, `login failed for ${email}`);
  const token = res.json().token as string;
  tokens.set(email, token);
  return token;
}

async function call(
  email: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await login(email)}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

/** The phone's whole handshake: ticket, PUT the bytes, confirm. */
async function shoot(
  email: string,
  jobId: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const ticket = await call(email, 'POST', '/api/photos/upload-url', {
    jobId,
    contentType: 'image/jpeg',
    byteSize: JPEG.length,
    width: 1600,
    height: 1200,
    ...fields,
  });
  assert.equal(ticket.statusCode, 201, ticket.body);
  const { photoId, uploadUrl } = ticket.json();

  const put = await app.inject({
    method: 'PUT',
    url: (uploadUrl as string).replace(/^https?:\/\/[^/]+/, ''),
    headers: { 'content-type': 'image/jpeg' },
    payload: JPEG,
  });
  assert.equal(put.statusCode, 200);

  const confirm = await call(email, 'POST', '/api/photos/confirm', { photoId });
  assert.equal(confirm.statusCode, 200, confirm.body);
  return photoId as string;
}

function storedFile(jobId: string, photoId: string): string {
  return path.join(
    process.env.LOCAL_STORAGE_DIR!,
    photoKey({ orgId: SEED.sanpec, jobId, photoId, contentType: 'image/jpeg' }),
  );
}

async function structure(email: string, jobId: string, structureId: string) {
  const res = await call(email, 'GET', `/api/jobs/${jobId}/structures/${structureId}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function newStructure(jobId: string, serialNumber: string, structureType = 'Anchor bolt cage') {
  const res = await call(MARCUS, 'POST', `/api/jobs/${jobId}/structures`, {
    serialNumber,
    structureType,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().structure as { id: string; objectId: string };
}

/** Job 2: Marcus's scheduled parking-structure survey, nothing captured yet. */
const job = SEED.job2;
/** A fresh job at Tower A, the site that already has an elevator on record. */
let towerJob: string;

before(async () => {
  await seed({ quiet: true });
  app = await buildApp();
  await app.ready();

  const res = await call(DANA, 'POST', '/api/jobs', {
    clientOrgId: SEED.harbor,
    siteId: SEED.siteTower,
    title: 'Elevator re-inspection',
    inspectorIds: [SEED.marcus],
  });
  assert.equal(res.statusCode, 201, res.body);
  towerJob = res.json().job.id;
});

after(async () => {
  await app.close();
  await closeDb();
});

describe('the report photo frame', () => {
  it('leaves a 4:3 phone photo whole and shrinks it to 1600x1200', () => {
    const c = reportPhotoCrop(4032, 3024);
    assert.deepEqual([c.sx, c.sy, c.sw, c.sh], [0, 0, 4032, 3024]);
    assert.deepEqual([c.outWidth, c.outHeight], [1600, 1200]);
  });

  it('keeps an upright photo upright', () => {
    const c = reportPhotoCrop(3024, 4032);
    assert.deepEqual([c.outWidth, c.outHeight], [1200, 1600]);
  });

  it('trims a 16:9 photo to 4:3, centred unless the inspector slides it', () => {
    const centred = reportPhotoCrop(1920, 1080);
    assert.deepEqual([centred.sx, centred.sw, centred.sh], [240, 1440, 1080]);
    assert.deepEqual([centred.outWidth, centred.outHeight], [1440, 1080]);
    assert.equal(reportPhotoCrop(1920, 1080, { offset: 0 }).sx, 0);
    assert.equal(reportPhotoCrop(1920, 1080, { offset: 1 }).sx, 480);
  });

  it('trims a square photo along its height', () => {
    const c = reportPhotoCrop(1000, 1000);
    assert.deepEqual([c.sy, c.sh, c.outWidth, c.outHeight], [125, 750, 1000, 750]);
  });

  it('always produces exactly 4:3, never 4:3-ish', () => {
    for (const [w, h] of [
      [4000, 3000],
      [2340, 1080],
      [1080, 2400],
      [3001, 2999],
      [801, 601],
    ] as const) {
      const c = reportPhotoCrop(w, h);
      const long = Math.max(c.outWidth, c.outHeight);
      const short = Math.min(c.outWidth, c.outHeight);
      assert.equal(long * 3, short * 4, `${w}x${h} -> ${c.outWidth}x${c.outHeight}`);
    }
  });

  it('knows the frame when it sees it', () => {
    assert.ok(isReportAspect(1600, 1200));
    assert.ok(isReportAspect(1200, 1600));
    assert.ok(!isReportAspect(1920, 1080));
    assert.ok(!isReportAspect(1000, 1000));
  });
});

describe('starting an inspection', () => {
  it('moves a scheduled job to in progress', async () => {
    const res = await call(MARCUS, 'POST', `/api/jobs/${job}/start`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().job.status, 'in_progress');
    assert.ok(res.json().job.startedAt);
  });

  it('keeps the original start time when pressed again', async () => {
    const first = await call(MARCUS, 'GET', `/api/jobs/${job}`);
    const again = await call(MARCUS, 'POST', `/api/jobs/${job}/start`);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().job.startedAt, first.json().job.startedAt);
  });

  it('is not possible for an inspector who is not on the job', async () => {
    const res = await call(PRIYA, 'POST', `/api/jobs/${job}/start`);
    assert.equal(res.statusCode, 404);
  });
});

describe('structures', () => {
  let first: { id: string; objectId: string };

  it('New Structure records the serial and what the structure is', async () => {
    const res = await call(MARCUS, 'POST', `/api/jobs/${job}/structures`, {
      serialNumber: '44065-3004-2',
      structureType: 'Pole section',
    });
    assert.equal(res.statusCode, 201, res.body);
    const s = res.json().structure;
    assert.equal(s.serialNumber, '44065-3004-2');
    assert.equal(s.structureType, 'Pole section');
    assert.equal(s.finishedAt, null);
    assert.equal(s.photoCount, 0);
    assert.equal(s.cover, null);
    assert.equal(res.json().reusedObject, false);
    first = s;
  });

  it('answers a serial already in this inspection with a 409 naming it', async () => {
    const res = await call(MARCUS, 'POST', `/api/jobs/${job}/structures`, {
      serialNumber: '44065-3004-2',
      structureType: 'Pole section',
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.details.structureId, first.id);
  });

  it('links a serial the site already knows, so its history carries over', async () => {
    const res = await call(MARCUS, 'POST', `/api/jobs/${towerJob}/structures`, {
      serialNumber: 'ELV-4471',
      structureType: 'Elevator',
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().reusedObject, true);
    assert.equal(res.json().structure.objectId, SEED.objElevator);

    const history = await call(DANA, 'GET', `/api/objects/${SEED.objElevator}`);
    const jobIds = history.json().history.map((h: { jobId: string }) => h.jobId);
    assert.ok(jobIds.includes(towerJob));
    assert.ok(jobIds.includes(SEED.job1));
  });

  it('needs both a serial and what the structure is', async () => {
    const blank = await call(MARCUS, 'POST', `/api/jobs/${job}/structures`, {
      serialNumber: '   ',
      structureType: 'Pole section',
    });
    assert.equal(blank.statusCode, 400);
    const noType = await call(MARCUS, 'POST', `/api/jobs/${job}/structures`, {
      serialNumber: 'X-1',
    });
    assert.equal(noType.statusCode, 400);
  });

  it('cannot be added by a client', async () => {
    const res = await call(JAMIE, 'POST', `/api/jobs/${SEED.job4}/structures`, {
      serialNumber: 'C-1',
      structureType: 'Anything',
    });
    assert.equal(res.statusCode, 403);
  });

  it('are invisible to an inspector who is not on the job', async () => {
    const list = await call(PRIYA, 'GET', `/api/jobs/${job}/structures`);
    assert.equal(list.statusCode, 404);
    const one = await call(PRIYA, 'GET', `/api/jobs/${job}/structures/${first.id}`);
    assert.equal(one.statusCode, 404);
  });

  it('cannot be reached through another job id', async () => {
    const res = await call(MARCUS, 'GET', `/api/jobs/${SEED.job1}/structures/${first.id}`);
    assert.equal(res.statusCode, 404);
  });

  it('treats a malformed id as missing rather than failing', async () => {
    const res = await call(MARCUS, 'GET', `/api/jobs/${job}/structures/not-a-uuid`);
    assert.equal(res.statusCode, 404);
    const badJob = await call(MARCUS, 'GET', '/api/jobs/not-a-uuid/structures');
    assert.equal(badJob.statusCode, 404);
  });

  it('suggests the types this company already uses, to its own people only', async () => {
    const mine = await call(MARCUS, 'GET', `/api/jobs/${job}/structures`);
    const types: string[] = mine.json().structureTypes;
    assert.ok(types.includes('Pole section'));
    assert.ok(types.includes('Elevator'));

    const client = await call(JAMIE, 'GET', `/api/jobs/${SEED.job4}/structures`);
    assert.equal(client.statusCode, 200);
    assert.deepEqual(client.json().structureTypes, []);
    assert.equal(client.json().structures.length, 1);
  });
});

describe('serial plate photo', () => {
  let s: { id: string; objectId: string };
  let firstPlate: string;

  before(async () => {
    s = await newStructure(job, 'PLATE-100');
  });

  it('becomes the structure thumbnail', async () => {
    firstPlate = await shoot(MARCUS, job, { objectId: s.objectId, serialPlate: true });
    const list = await call(MARCUS, 'GET', `/api/jobs/${job}/structures`);
    const tile = list.json().structures.find((x: { id: string }) => x.id === s.id);
    assert.equal(tile.cover.photoId, firstPlate);
    assert.equal(tile.cover.isSerialPlate, true);
    assert.ok(tile.cover.url);
  });

  it('is replaced outright by a retake, bytes and all', async () => {
    const retake = await shoot(MARCUS, job, { objectId: s.objectId, serialPlate: true });
    const { photos: list, structure: one } = await structure(MARCUS, job, s.id);
    const plates = list.filter((p: { isSerialPlate: boolean }) => p.isSerialPlate);
    assert.deepEqual(
      plates.map((p: { id: string }) => p.id),
      [retake],
    );
    assert.ok(!list.some((p: { id: string }) => p.id === firstPlate));
    assert.equal(one.cover.photoId, retake);
    assert.ok(!existsSync(storedFile(job, firstPlate)), 'old plate file still on disk');
    assert.ok(existsSync(storedFile(job, retake)));
  });

  it('must belong to a structure', async () => {
    const res = await call(MARCUS, 'POST', '/api/photos/upload-url', {
      jobId: job,
      contentType: 'image/jpeg',
      byteSize: JPEG.length,
      width: 1600,
      height: 1200,
      serialPlate: true,
    });
    assert.equal(res.statusCode, 400);
  });

  it('falls back to the first photo when no plate was taken', async () => {
    const bare = await newStructure(job, 'NO-PLATE-1');
    const photoId = await shoot(MARCUS, job, { objectId: bare.objectId });
    const list = await call(MARCUS, 'GET', `/api/jobs/${job}/structures`);
    const tile = list.json().structures.find((x: { id: string }) => x.id === bare.id);
    assert.equal(tile.cover.photoId, photoId);
    assert.equal(tile.cover.isSerialPlate, false);
  });
});

describe('photos and findings', () => {
  let s: { id: string; objectId: string };
  let finding: string;
  let ordinary: string;

  before(async () => {
    s = await newStructure(job, 'NC-200', 'Pole section');
  });

  it('must be 4:3 - a 16:9 shot is refused, a portrait one accepted', async () => {
    const wide = await call(MARCUS, 'POST', '/api/photos/upload-url', {
      jobId: job,
      objectId: s.objectId,
      contentType: 'image/jpeg',
      byteSize: JPEG.length,
      width: 1920,
      height: 1080,
    });
    assert.equal(wide.statusCode, 400);
    await shoot(MARCUS, job, { objectId: s.objectId, width: 1200, height: 1600 });
  });

  it('refuses a non-conforming photo that is left out of the report', async () => {
    const res = await call(MARCUS, 'POST', '/api/photos/upload-url', {
      jobId: job,
      objectId: s.objectId,
      contentType: 'image/jpeg',
      byteSize: JPEG.length,
      width: 1600,
      height: 1200,
      nonConforming: true,
      includeInReport: false,
    });
    assert.equal(res.statusCode, 400);
  });

  it('includes a non-conforming photo in the report', async () => {
    finding = await shoot(MARCUS, job, { objectId: s.objectId, nonConforming: true });
    const { photos: list } = await structure(MARCUS, job, s.id);
    const row = list.find((p: { id: string }) => p.id === finding);
    assert.equal(row.nonConforming, true);
    assert.equal(row.includeInReport, true);
  });

  it('pulls a photo into the report when it is flagged later', async () => {
    ordinary = await shoot(MARCUS, job, { objectId: s.objectId, includeInReport: false });
    const res = await call(MARCUS, 'PATCH', `/api/photos/${ordinary}`, { nonConforming: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().photo.includeInReport, true);
    assert.equal(res.json().photo.nonConforming, true);
  });

  it('will not take a finding out of the report', async () => {
    const res = await call(MARCUS, 'PATCH', `/api/photos/${finding}`, { includeInReport: false });
    assert.equal(res.statusCode, 400);

    const cleared = await call(MARCUS, 'PATCH', `/api/photos/${ordinary}`, {
      nonConforming: false,
      includeInReport: false,
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().photo.includeInReport, false);
  });

  it('is enforced by the database itself, not only the API', async () => {
    const { db } = await getDb();
    await assert.rejects(
      db.update(photos).set({ includeInReport: false }).where(eq(photos.id, finding)),
    );
  });

  it('counts photos, report photos and findings per structure', async () => {
    const { structure: one } = await structure(MARCUS, job, s.id);
    assert.equal(one.photoCount, 3);
    assert.equal(one.includedCount, 2);
    assert.equal(one.nonConformingCount, 1);
  });

  it('can make an existing photo the plate, keeping the old plate as a photo', async () => {
    const plate = await shoot(MARCUS, job, { objectId: s.objectId, serialPlate: true });
    const res = await call(MARCUS, 'PATCH', `/api/photos/${ordinary}`, { serialPlate: true });
    assert.equal(res.statusCode, 200);
    const { photos: list } = await structure(MARCUS, job, s.id);
    assert.equal(list[0].id, ordinary, 'the plate is listed first');
    const old = list.find((p: { id: string }) => p.id === plate);
    assert.equal(old.isSerialPlate, false);
  });

  it('shows up when the gallery is filtered to findings', async () => {
    const res = await call(DANA, 'GET', '/api/gallery?nonConforming=true');
    const rows = res.json().photos as { id: string; nonConforming: boolean }[];
    assert.ok(rows.some((p) => p.id === finding));
    assert.ok(rows.every((p) => p.nonConforming));
  });
});

describe('finishing and editing a structure', () => {
  let s: { id: string; objectId: string };

  before(async () => {
    s = await newStructure(job, 'TYPO-1', 'Anchor bolt cage');
    await shoot(MARCUS, job, { objectId: s.objectId, serialPlate: true });
    await shoot(MARCUS, job, { objectId: s.objectId });
  });

  it('Finish Structure saves the comments and marks it finished', async () => {
    const res = await call(MARCUS, 'PATCH', `/api/jobs/${job}/structures/${s.id}`, {
      comments: 'Shop welded 3/4" grounding nuts instead of 5/8".',
      finished: true,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().structure.finishedAt);
    assert.equal(res.json().structure.comments, 'Shop welded 3/4" grounding nuts instead of 5/8".');
  });

  it('stays finished, at the original time, through later edits', async () => {
    const before = await structure(MARCUS, job, s.id);
    const res = await call(MARCUS, 'PATCH', `/api/jobs/${job}/structures/${s.id}`, {
      comments: 'Updated after review.',
      finished: true,
    });
    assert.equal(res.json().structure.finishedAt, before.structure.finishedAt);
  });

  it('can be reopened', async () => {
    const res = await call(MARCUS, 'PATCH', `/api/jobs/${job}/structures/${s.id}`, {
      finished: false,
    });
    assert.equal(res.json().structure.finishedAt, null);
  });

  it('renames what the structure is', async () => {
    const res = await call(MARCUS, 'PATCH', `/api/jobs/${job}/structures/${s.id}`, {
      structureType: 'Anchor bolt cage, 8-bolt',
    });
    assert.equal(res.json().structure.structureType, 'Anchor bolt cage, 8-bolt');
  });

  it('moves the photos when the serial is corrected, and drops the typo', async () => {
    const res = await call(MARCUS, 'PATCH', `/api/jobs/${job}/structures/${s.id}`, {
      serialNumber: 'TYPO-I',
    });
    assert.equal(res.statusCode, 200, res.body);
    const fixed = res.json().structure;
    assert.equal(fixed.serialNumber, 'TYPO-I');
    assert.equal(fixed.structureType, 'Anchor bolt cage, 8-bolt');
    assert.equal(fixed.photoCount, 2);
    assert.equal(fixed.cover.isSerialPlate, true);
    assert.notEqual(fixed.objectId, s.objectId);

    const typo = await call(DANA, 'GET', `/api/objects/${s.objectId}`);
    assert.equal(typo.statusCode, 404);
  });

  it('refuses a serial that is already another structure here', async () => {
    const res = await call(MARCUS, 'PATCH', `/api/jobs/${job}/structures/${s.id}`, {
      serialNumber: '44065-3004-2',
    });
    assert.equal(res.statusCode, 409);
  });
});

describe('removing a structure', () => {
  it('deletes it with its photos on this job, files included', async () => {
    const s = await newStructure(job, 'MISTAKE-9');
    const photoId = await shoot(MARCUS, job, { objectId: s.objectId });
    assert.ok(existsSync(storedFile(job, photoId)));

    const res = await call(MARCUS, 'DELETE', `/api/jobs/${job}/structures/${s.id}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().photosDeleted, 1);

    const gone = await call(MARCUS, 'GET', `/api/jobs/${job}/structures/${s.id}`);
    assert.equal(gone.statusCode, 404);
    assert.ok(!existsSync(storedFile(job, photoId)));
  });

  it('keeps an object that other jobs have inspected', async () => {
    const list = await call(MARCUS, 'GET', `/api/jobs/${towerJob}/structures`);
    const elevator = list.json().structures.find(
      (x: { objectId: string }) => x.objectId === SEED.objElevator,
    );
    const res = await call(MARCUS, 'DELETE', `/api/jobs/${towerJob}/structures/${elevator.id}`);
    assert.equal(res.statusCode, 200);

    const still = await call(DANA, 'GET', `/api/objects/${SEED.objElevator}`);
    assert.equal(still.statusCode, 200);
  });
});

describe('a submitted inspection', () => {
  let s: { id: string; objectId: string };

  before(async () => {
    s = await newStructure(towerJob, 'LATE-1');
    const submit = await call(MARCUS, 'POST', `/api/jobs/${towerJob}/submit`);
    assert.equal(submit.statusCode, 200);
  });

  it('is read-only to the inspector', async () => {
    const add = await call(MARCUS, 'POST', `/api/jobs/${towerJob}/structures`, {
      serialNumber: 'LATE-2',
      structureType: 'Pole section',
    });
    assert.equal(add.statusCode, 403);
    const edit = await call(MARCUS, 'PATCH', `/api/jobs/${towerJob}/structures/${s.id}`, {
      comments: 'Too late',
    });
    assert.equal(edit.statusCode, 403);
    const remove = await call(MARCUS, 'DELETE', `/api/jobs/${towerJob}/structures/${s.id}`);
    assert.equal(remove.statusCode, 403);
  });

  it('can still be viewed', async () => {
    const res = await call(MARCUS, 'GET', `/api/jobs/${towerJob}/structures`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().permissions.canWriteContent, false);
  });
});
