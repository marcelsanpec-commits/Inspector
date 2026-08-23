import {
  acceptInviteSchema,
  loginSchema,
  signupSchema,
} from '@inspectorone/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  authenticate,
  createSession,
  destroySession,
  loadPrincipal,
  requirePrincipal,
} from '../auth/index.js';
import { badRequest, conflict, HttpError } from '../authz.js';
import { getDb } from '../db/client.js';
import {
  clientRelationships,
  invites,
  memberships,
  organizations,
  users,
} from '../db/schema.js';
import { generateAccountId, generateSlug, hashToken } from '../lib/ids.js';
import { fakeVerify, hashPassword, verifyPassword } from '../lib/password.js';

/**
 * Account IDs are short enough that a collision is possible rather than
 * merely theoretical, so retry a few times before giving up.
 */
async function allocateAccountId(
  db: Awaited<ReturnType<typeof getDb>>['db'],
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateAccountId();
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.accountId, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  throw new HttpError(
    500,
    'account_id_exhausted',
    'Could not allocate an account ID. Please try again.',
  );
}

export async function authRoutes(app: FastifyInstance) {
  /**
   * Signup, three paths:
   *  - inspection_company / client: creates the org, caller becomes owner
   *  - inspector: creates only the account; they hand their ID to a company
   */
  app.post('/api/auth/signup', async (req, reply) => {
    const body = signupSchema.parse(req.body);
    const { db } = await getDb();

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing) {
      throw conflict('An account with that email already exists');
    }

    const passwordHash = await hashPassword(body.password);
    const accountId = await allocateAccountId(db);

    const userId = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: body.email,
          passwordHash,
          name: body.name,
          accountId,
          signupRole: body.role,
        })
        .returning({ id: users.id });

      // An inspector creates no organization - they wait to be added to one.
      if (body.role !== 'inspector') {
        const [org] = await tx
          .insert(organizations)
          .values({
            type: body.role === 'inspection_company' ? 'inspection_company' : 'client',
            name: body.organizationName!,
            slug: generateSlug(body.organizationName!),
          })
          .returning({ id: organizations.id });

        await tx.insert(memberships).values({
          userId: user!.id,
          orgId: org!.id,
          role: 'owner',
        });
      }

      return user!.id;
    });

    const session = await createSession(userId, req.headers['user-agent']);
    reply.code(201);
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      principal: await loadPrincipal(userId),
    };
  });

  app.post('/api/auth/login', async (req) => {
    const body = loginSchema.parse(req.body);
    const { db } = await getDb();

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    // Burn comparable time on a miss so response timing does not reveal which
    // email addresses have accounts.
    if (!user) {
      await fakeVerify();
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }

    if (!(await verifyPassword(body.password, user.passwordHash))) {
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }

    const session = await createSession(user.id, req.headers['user-agent']);
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      principal: await loadPrincipal(user.id),
    };
  });

  app.post('/api/auth/logout', async (req) => {
    const token = req.sessionToken;
    if (token) await destroySession(token);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    return { principal: requirePrincipal(req) };
  });

  /**
   * Look up an invite before showing the accept screen, so the UI can say which
   * organization is inviting you and whether you already have an account.
   */
  app.get<{ Querystring: { token?: string } }>('/api/auth/invite', async (req) => {
    const token = req.query.token;
    if (!token) throw badRequest('Missing invite token');
    const { db } = await getDb();

    const [invite] = await db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        orgName: organizations.name,
        orgType: organizations.type,
        createsClientOrgName: invites.createsClientOrgName,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .innerJoin(organizations, eq(invites.orgId, organizations.id))
      .where(
        and(
          eq(invites.tokenHash, hashToken(token)),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!invite) {
      throw new HttpError(404, 'invite_invalid', 'This invitation is invalid or has expired');
    }

    const [existingUser] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1);

    return {
      invite: {
        email: invite.email,
        role: invite.role,
        invitedBy: invite.orgName,
        orgType: invite.orgType,
        newClientOrgName: invite.createsClientOrgName,
        expiresAt: invite.expiresAt,
      },
      /** Tells the UI whether to ask for a password or just confirm. */
      accountExists: !!existingUser,
    };
  });

  /**
   * Accepting an invite either joins an existing org, or - when an inspecting
   * company invited a brand-new client company - creates that client org, makes
   * the invitee its owner, and links the two organizations in one step.
   */
  app.post('/api/auth/invite/accept', async (req) => {
    const body = acceptInviteSchema.parse(req.body);
    const { db } = await getDb();

    const [invite] = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.tokenHash, hashToken(body.token)),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!invite) {
      throw new HttpError(404, 'invite_invalid', 'This invitation is invalid or has expired');
    }

    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1);

    if (!existingUser && (!body.password || !body.name)) {
      throw badRequest('A name and password are required to create your account');
    }

    const passwordHash = existingUser
      ? null
      : await hashPassword(body.password as string);
    const accountId = existingUser ? null : await allocateAccountId(db);

    const userId = await db.transaction(async (tx) => {
      let uid: string;

      if (existingUser) {
        uid = existingUser.id;
      } else {
        const [created] = await tx
          .insert(users)
          .values({
            email: invite.email,
            passwordHash: passwordHash as string,
            name: body.name as string,
            accountId: accountId as string,
            signupRole: invite.createsClientOrgName ? 'client' : 'inspector',
          })
          .returning({ id: users.id });
        uid = created!.id;
      }

      if (invite.createsClientOrgName) {
        // New client company: create it, own it, and link it to the inspecting
        // company that sent the invitation.
        const [clientOrg] = await tx
          .insert(organizations)
          .values({
            type: 'client',
            name: invite.createsClientOrgName,
            slug: generateSlug(invite.createsClientOrgName),
          })
          .returning({ id: organizations.id });

        await tx
          .insert(memberships)
          .values({ userId: uid, orgId: clientOrg!.id, role: 'owner' })
          .onConflictDoNothing();

        if (invite.linkToCompanyOrgId) {
          await tx
            .insert(clientRelationships)
            .values({
              companyOrgId: invite.linkToCompanyOrgId,
              clientOrgId: clientOrg!.id,
            })
            .onConflictDoNothing();
        }
      } else {
        await tx
          .insert(memberships)
          .values({ userId: uid, orgId: invite.orgId, role: invite.role })
          .onConflictDoNothing();
      }

      await tx
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(eq(invites.id, invite.id));

      return uid;
    });

    const session = await createSession(userId, req.headers['user-agent']);
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      principal: await loadPrincipal(userId),
    };
  });
}

export { authenticate };
