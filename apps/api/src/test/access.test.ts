import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Must be set before anything imports env.ts, which reads process.env at module
 * load. Each run gets a private in-memory Postgres and a throwaway storage
 * directory, so tests never touch development data.
 */
process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = 'memory://';
process.env.STORAGE_DRIVER = 'local';
process.env.SIGNING_SECRET = 'test-signing-secret';
process.env.EMAIL_DRIVER = 'console';
process.env.LOCAL_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), 'io-access-'));

const { buildApp } = await import('../app.js');
const { closeDb } = await import('../db/client.js');
const { seed, SEED, SEED_PASSWORD } = await import('../db/seed-data.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const tokens = new Map<string, string>();

async function login(email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SEED_PASSWORD },
  });
  assert.equal(res.statusCode, 200, `login failed for ${email}: ${res.body}`);
  const token = res.json().token as string;
  tokens.set(email, token);
  return token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function jobIdsFor(email: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/jobs',
    headers: auth(await login(email)),
  });
  assert.equal(res.statusCode, 200);
  return res.json().jobs.map((j: { id: string }) => j.id);
}

before(async () => {
  await seed({ quiet: true });
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await closeDb();
});

describe('account IDs', () => {
  /**
   * Guards against seed data drifting from the validator. The ID alphabet
   * deliberately omits 0/1/I/O/U/V, and a seeded ID containing one of them
   * looks fine until someone tries to type it into the "add member" box.
   */
  it('every seeded account ID satisfies the public schema', async () => {
    const { accountIdSchema } = await import('@inspectorone/shared');
    const { db } = await import('../db/client.js').then((m) => m.getDb());
    const { users } = await import('../db/schema.js');

    const rows = await db.select({ accountId: users.accountId }).from(users);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.doesNotThrow(
        () => accountIdSchema.parse(row.accountId),
        `seeded account ID ${row.accountId} is not valid input`,
      );
    }
  });
});

describe('signup', () => {
  it('creates an org and an owner membership for an inspecting company', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: 'founder@newfirm.example',
        password: 'a-long-enough-password',
        name: 'New Founder',
        role: 'inspection_company',
        organizationName: 'New Firm Engineering',
      },
    });
    assert.equal(res.statusCode, 201);
    const { principal } = res.json();
    assert.equal(principal.memberships.length, 1);
    assert.equal(principal.memberships[0].role, 'owner');
    assert.equal(principal.memberships[0].orgType, 'inspection_company');
    assert.match(principal.accountId, /^IO-[A-Z0-9]{6}$/);
  });

  it('creates no organization for an inspector', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: 'solo@inspector.example',
        password: 'a-long-enough-password',
        name: 'Solo Inspector',
        role: 'inspector',
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().principal.memberships.length, 0);
  });

  it('rejects an inspector who tries to create an org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: 'confused@inspector.example',
        password: 'a-long-enough-password',
        name: 'Confused',
        role: 'inspector',
        organizationName: 'Should Not Work',
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects a duplicate email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: 'dana@sanpec.example',
        password: 'a-long-enough-password',
        name: 'Impostor',
        role: 'inspector',
      },
    });
    assert.equal(res.statusCode, 409);
  });

  it('rejects a short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: 'short@example.com',
        password: 'short',
        name: 'Short',
        role: 'inspector',
      },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('login', () => {
  it('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dana@sanpec.example', password: 'not-the-password' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects an unknown email with the same error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@nowhere.example', password: 'not-the-password' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'invalid_credentials');
  });

  it('rejects a request with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs' });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a garbage token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: auth('not-a-real-token'),
    });
    assert.equal(res.statusCode, 401);
  });

  it('invalidates the session on logout', async () => {
    const token = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'sam@westline.example', password: SEED_PASSWORD },
      })
    ).json().token as string;

    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) }))
        .statusCode,
      200,
    );
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(token) });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) }))
        .statusCode,
      401,
    );
  });
});

describe('cross-company isolation', () => {
  it('another inspecting company sees none of these jobs', async () => {
    assert.deepEqual(await jobIdsFor('owner@rival.example'), []);
  });

  it('another company gets 404, not 403, on a known job id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job1}`,
      headers: auth(await login('owner@rival.example')),
    });
    // 403 would confirm the job exists.
    assert.equal(res.statusCode, 404);
  });

  it('an unaffiliated inspector sees nothing', async () => {
    assert.deepEqual(await jobIdsFor('newhire@example.com'), []);
  });
});

describe('inspector scoping', () => {
  it('sees only jobs assigned to them', async () => {
    const marcus = await jobIdsFor('marcus@sanpec.example');
    assert.deepEqual(marcus.sort(), [SEED.job1, SEED.job2].sort());

    const priya = await jobIdsFor('priya@sanpec.example');
    assert.deepEqual(priya.sort(), [SEED.job3, SEED.job4, SEED.job5].sort());
  });

  it("cannot open another inspector's job", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job3}`,
      headers: auth(await login('marcus@sanpec.example')),
    });
    assert.equal(res.statusCode, 404);
  });

  it('cannot create a job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: auth(await login('marcus@sanpec.example')),
      payload: {
        clientOrgId: SEED.harbor,
        siteId: SEED.siteTower,
        title: 'Should not be allowed',
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('cannot deliver a job to the client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${SEED.job1}/deliver`,
      headers: auth(await login('marcus@sanpec.example')),
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('client scoping', () => {
  it('a client owner sees delivered jobs, including one they are named on', async () => {
    const jamie = await jobIdsFor('jamie@harborpoint.example');
    assert.deepEqual(jamie.sort(), [SEED.job4, SEED.job5].sort());
  });

  it('a colleague in the same client org is excluded from a restricted job', async () => {
    const alex = await jobIdsFor('alex@harborpoint.example');
    assert.deepEqual(alex, [SEED.job4]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job5}`,
      headers: auth(await login('alex@harborpoint.example')),
    });
    assert.equal(res.statusCode, 404);
  });

  it('cannot see work that has not been delivered', async () => {
    // Job 3 belongs to Westline but is only 'submitted'.
    assert.deepEqual(await jobIdsFor('sam@westline.example'), []);

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${SEED.job3}`,
      headers: auth(await login('sam@westline.example')),
    });
    assert.equal(res.statusCode, 404);
  });

  it('is strictly read-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/photos/upload-url',
      headers: auth(await login('jamie@harborpoint.example')),
      payload: { jobId: SEED.job4, contentType: 'image/jpeg', byteSize: 1000 },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('company admin', () => {
  it('sees every job in their company', async () => {
    const dana = await jobIdsFor('dana@sanpec.example');
    assert.equal(dana.length, 5);
  });

  it('cannot create a job for a client that is not on their roster', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: auth(await login('owner@rival.example')),
      payload: {
        clientOrgId: SEED.harbor,
        siteId: SEED.siteTower,
        title: 'Cross-tenant job',
      },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('roster management', () => {
  it('adds an existing account by its account ID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.sanpec}/members/by-account-id`,
      headers: auth(await login('dana@sanpec.example')),
      payload: { accountId: 'IO-J2RD4N', role: 'inspector' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().member.name, 'Jordan Blake');
  });

  it('rejects an unknown account ID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.sanpec}/members/by-account-id`,
      headers: auth(await login('dana@sanpec.example')),
      payload: { accountId: 'IO-ZZZZZZ', role: 'inspector' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects a role that makes no sense for the org type', async () => {
    // "inspector" is meaningless inside a client company.
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.harbor}/members/by-account-id`,
      headers: auth(await login('jamie@harborpoint.example')),
      payload: { accountId: 'IO-J2RD4N', role: 'inspector' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('lets a client company add its own colleagues', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: 'facilities3@harborpoint.example',
        password: 'a-long-enough-password',
        name: 'Third Harbor Contact',
        role: 'client',
        organizationName: 'Placeholder Co',
      },
    });
    const accountId = signup.json().principal.accountId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.harbor}/members/by-account-id`,
      headers: auth(await login('jamie@harborpoint.example')),
      payload: { accountId, role: 'member' },
    });
    assert.equal(res.statusCode, 201);
  });

  it('an inspector cannot manage the roster', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.sanpec}/members/by-account-id`,
      headers: auth(await login('marcus@sanpec.example')),
      payload: { accountId: 'IO-J2RD4N', role: 'inspector' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('a client member cannot manage the roster', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.harbor}/invites`,
      headers: auth(await login('alex@harborpoint.example')),
      payload: { email: 'someone@example.com', role: 'member' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('refuses to remove the last owner', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/orgs/${SEED.sanpec}/members/${SEED.dana}`,
      headers: auth(await login('dana@sanpec.example')),
    });
    assert.equal(res.statusCode, 409);
  });

  it('cannot touch an org the caller does not belong to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/orgs/${SEED.sanpec}/members`,
      headers: auth(await login('owner@rival.example')),
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('invites', () => {
  it('issues an invite and accepts it into the org', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.sanpec}/invites`,
      headers: auth(await login('dana@sanpec.example')),
      payload: { email: 'invited@example.com', role: 'inspector' },
    });
    assert.equal(invite.statusCode, 201);

    // The console email driver hands the link back for local development.
    const link = invite.json().previewLink as string;
    const token = new URL(link).searchParams.get('token');
    assert.ok(token);

    const preview = await app.inject({
      method: 'GET',
      url: `/api/auth/invite?token=${token}`,
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().accountExists, false);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: {
        token,
        name: 'Invited Inspector',
        password: 'a-long-enough-password',
      },
    });
    assert.equal(accepted.statusCode, 200);
    const memberships = accepted.json().principal.memberships;
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].orgId, SEED.sanpec);
    assert.equal(memberships[0].role, 'inspector');
  });

  it('rejects a reused invite token', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.sanpec}/invites`,
      headers: auth(await login('dana@sanpec.example')),
      payload: { email: 'once@example.com', role: 'inspector' },
    });
    const token = new URL(invite.json().previewLink).searchParams.get('token');

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: { token, name: 'Once', password: 'a-long-enough-password' },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: { token, name: 'Twice', password: 'a-long-enough-password' },
    });
    assert.equal(second.statusCode, 404);
  });

  it('rejects an invented token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/invite?token=totally-made-up-token-value',
    });
    assert.equal(res.statusCode, 404);
  });

  it('creates and links a new client company when its invite is accepted', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/orgs/${SEED.sanpec}/clients/invite`,
      headers: auth(await login('dana@sanpec.example')),
      payload: { email: 'ops@newclient.example', organizationName: 'New Client Co' },
    });
    assert.equal(invite.statusCode, 201);
    const token = new URL(invite.json().previewLink).searchParams.get('token');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: { token, name: 'Client Owner', password: 'a-long-enough-password' },
    });
    assert.equal(accepted.statusCode, 200);
    const m = accepted.json().principal.memberships[0];
    assert.equal(m.orgType, 'client');
    assert.equal(m.orgName, 'New Client Co');
    assert.equal(m.role, 'owner');

    // And it now appears on the inspecting company's roster.
    const roster = await app.inject({
      method: 'GET',
      url: `/api/orgs/${SEED.sanpec}/clients`,
      headers: auth(await login('dana@sanpec.example')),
    });
    const names = roster.json().clients.map((c: { name: string }) => c.name);
    assert.ok(names.includes('New Client Co'));
  });
});
