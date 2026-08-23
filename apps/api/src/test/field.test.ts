import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = 'memory://';
process.env.STORAGE_DRIVER = 'local';
process.env.SIGNING_SECRET = 'test-signing-secret';
process.env.EMAIL_DRIVER = 'console';
process.env.LOCAL_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), 'io-field-'));

const { buildApp } = await import('../app.js');
const { closeDb } = await import('../db/client.js');
const { seed, SEED, SEED_PASSWORD } = await import('../db/seed-data.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const tokens = new Map<string, string>();

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  await seed({ quiet: true });
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await closeDb();
});

/**
 * Objects persist on a site across jobs. That is what makes year-over-year
 * history for a serial number possible, and it is why re-entering a serial has
 * to return the existing record rather than erroring or duplicating.
 */
describe('objects', () => {
  it('creates a new object from a serial number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        siteId: SEED.siteTower,
        serialNumber: 'PMP-9001',
        label: 'Fire Pump 1',
        objectType: 'Pump',
        jobId: SEED.job1,
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().reused, false);
  });

  it('returns the existing object when the serial is already known', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: auth(await login('marcus@sanpec.example')),
      payload: { siteId: SEED.siteTower, serialNumber: 'ELV-4471', jobId: SEED.job1 },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().reused, true);
    assert.equal(first.json().object.id, SEED.objElevator);
  });

  it('refuses to create an object at a site the inspector cannot reach', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: auth(await login('marcus@sanpec.example')),
      payload: { siteId: SEED.siteWestline, serialNumber: 'X-1', jobId: SEED.job3 },
    });
    assert.equal(res.statusCode, 404);
  });

  it('exposes cross-job history for one object', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/objects/${SEED.objAhu}`,
      headers: auth(await login('dana@sanpec.example')),
    });
    assert.equal(res.statusCode, 200);
    const jobNumbers = res.json().history.map((h: { jobNumber: string }) => h.jobNumber);
    // The same AHU appears on both the current job and the post-storm job.
    assert.ok(jobNumbers.includes('JOB-2026-0001'));
    assert.ok(jobNumbers.includes('JOB-2026-0004'));
  });
});

/**
 * The full three-step handshake against the local driver. The same sequence
 * runs unchanged against R2 - only the URL the client PUTs to changes.
 */
describe('photo upload handshake', () => {
  it('issues a ticket, accepts the bytes, and confirms', async () => {
    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        jobId: SEED.job1,
        objectId: SEED.objElevator,
        contentType: 'image/jpeg',
        byteSize: JPEG.length,
        width: 1600,
        height: 1200,
        takenAt: '2026-08-20T14:31:00.000Z',
        gpsLat: 29.7604,
        gpsLng: -95.3698,
        caption: 'Governor assembly',
        voiceNote: 'Light surface corrosion on the governor rope.',
        voiceNoteIsDictated: true,
        includeInReport: true,
        clientRef: 'field-capture-001',
      },
    });
    assert.equal(ticketRes.statusCode, 201);
    const ticket = ticketRes.json();

    // The client PUTs bytes at the signed URL with no session header at all.
    const uploadPath = ticket.uploadUrl.replace(/^https?:\/\/[^/]+/, '');
    const putRes = await app.inject({
      method: 'PUT',
      url: uploadPath,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    assert.equal(putRes.statusCode, 200);

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/photos/confirm',
      headers: auth(await login('marcus@sanpec.example')),
      payload: { photoId: ticket.photoId },
    });
    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.json().photo.status, 'ready');
    assert.equal(
      confirmRes.json().photo.voiceNote,
      'Light surface corrosion on the governor rope.',
    );
  });

  it('preserves capture time and GPS through the round trip', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job1}/photos`,
      headers: auth(await login('marcus@sanpec.example')),
    });
    const photo = res
      .json()
      .photos.find((p: { clientRef: string }) => p.clientRef === 'field-capture-001');
    assert.ok(photo);
    assert.equal(photo.gpsLat, 29.7604);
    assert.equal(photo.takenAt, '2026-08-20T14:31:00.000Z');
    assert.ok(photo.url);
  });

  it('is idempotent across retries with the same clientRef', async () => {
    const payload = {
      jobId: SEED.job1,
      contentType: 'image/jpeg' as const,
      byteSize: JPEG.length,
      clientRef: 'offline-retry-77',
    };
    const token = auth(await login('marcus@sanpec.example'));
    const first = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: token,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: token,
      payload,
    });
    assert.equal(first.json().photoId, second.json().photoId);
  });

  it('will not confirm a photo whose bytes never arrived', async () => {
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        jobId: SEED.job1,
        contentType: 'image/jpeg',
        byteSize: JPEG.length,
        clientRef: 'never-uploaded',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/photos/confirm',
      headers: auth(await login('marcus@sanpec.example')),
      payload: { photoId: ticket.json().photoId },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects an upload to a job the inspector is not on', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('marcus@sanpec.example')),
      payload: { jobId: SEED.job3, contentType: 'image/jpeg', byteSize: JPEG.length },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects an object that belongs to a different site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        jobId: SEED.job1,
        objectId: SEED.objDock,
        contentType: 'image/jpeg',
        byteSize: JPEG.length,
      },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects a tampered upload token', async () => {
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        jobId: SEED.job1,
        contentType: 'image/jpeg',
        byteSize: JPEG.length,
        clientRef: 'tamper-test',
      },
    });
    const uploadPath = ticket.json().uploadUrl.replace(/^https?:\/\/[^/]+/, '');
    const res = await app.inject({
      method: 'PUT',
      url: uploadPath.slice(0, -2) + 'XX',
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects a body larger than the ticket allows', async () => {
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        jobId: SEED.job1,
        contentType: 'image/jpeg',
        byteSize: 10,
        clientRef: 'oversize-test',
      },
    });
    const uploadPath = ticket.json().uploadUrl.replace(/^https?:\/\/[^/]+/, '');
    const res = await app.inject({
      method: 'PUT',
      url: uploadPath,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    assert.equal(res.statusCode, 413);
  });
});

/**
 * The include-in-report toggle is editable long after capture - the decision is
 * usually clearer back at the office than it is on a ladder.
 */
describe('report inclusion', () => {
  it('can be flipped after the fact', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job1}/photos`,
      headers: auth(await login('marcus@sanpec.example')),
    });
    const target = list.json().photos[0];

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/photos/${target.id}`,
      headers: auth(await login('marcus@sanpec.example')),
      payload: { includeInReport: !target.includeInReport },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().photo.includeInReport, !target.includeInReport);
  });

  it('cannot be changed by a client', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job4}/photos`,
      headers: auth(await login('jamie@harborpoint.example')),
    });
    const target = list.json().photos[0];

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/photos/${target.id}`,
      headers: auth(await login('jamie@harborpoint.example')),
      payload: { includeInReport: false },
    });
    assert.equal(res.statusCode, 403);
  });
});

/**
 * The gallery is separate from the report on purpose: most photos never reach a
 * report, but both the company and the client still need to browse everything
 * that was documented.
 */
describe('gallery', () => {
  it('lets the company browse every photo it has taken', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery',
      headers: auth(await login('dana@sanpec.example')),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().photos.length >= 6);
    assert.ok(res.json().photos.every((p: { url: string }) => !!p.url));
  });

  it('filters by object', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/gallery?objectId=${SEED.objAhu}`,
      headers: auth(await login('dana@sanpec.example')),
    });
    const rows = res.json().photos;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((p: { objectId: string }) => p.objectId === SEED.objAhu));
  });

  it('filters by job and by report inclusion', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/gallery?jobId=${SEED.job4}&includeInReport=false`,
      headers: auth(await login('dana@sanpec.example')),
    });
    const rows = res.json().photos;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((p: { includeInReport: boolean }) => p.includeInReport === false));
  });

  it('shows a client only their own delivered work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery',
      headers: auth(await login('jamie@harborpoint.example')),
    });
    const rows = res.json().photos;
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((p: { clientName: string }) => p.clientName === 'Harbor Point Properties'),
    );
    // Job 1 is in progress, so none of its photos may appear.
    assert.ok(rows.every((p: { jobId: string }) => p.jobId !== SEED.job1));
  });

  it('shows a different client nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery',
      headers: auth(await login('sam@westline.example')),
    });
    assert.deepEqual(res.json().photos, []);
  });

  it('shows another inspecting company nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery',
      headers: auth(await login('owner@rival.example')),
    });
    assert.deepEqual(res.json().photos, []);
  });

  it('does not leak a restricted job through a direct filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/gallery?jobId=${SEED.job5}`,
      headers: auth(await login('alex@harborpoint.example')),
    });
    assert.deepEqual(res.json().photos, []);
  });
});
