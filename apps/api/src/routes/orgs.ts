import {
  addClientByAccountIdSchema,
  addMemberByAccountIdSchema,
  canManageMembers,
  inviteClientSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  type MembershipRole,
  type OrgType,
} from '@inspectorone/shared';
import { and, count, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/index.js';
import { badRequest, conflict, forbidden, notFound } from '../authz.js';
import { getDb } from '../db/client.js';
import {
  clientRelationships,
  invites,
  memberships,
  organizations,
  users,
} from '../db/schema.js';
import { env } from '../env.js';
import { sendInviteEmail } from '../lib/email.js';
import { generateToken } from '../lib/ids.js';

/**
 * Roles are constrained by org type. An inspecting company has no "member", and
 * a client company has no "inspector" - allowing either would create accounts
 * whose permissions nothing in the system knows how to evaluate.
 */
const ROLES_BY_ORG_TYPE: Record<OrgType, MembershipRole[]> = {
  inspection_company: ['owner', 'admin', 'inspector'],
  client: ['owner', 'admin', 'member'],
};

function assertRoleValidFor(orgType: OrgType, role: MembershipRole) {
  if (!ROLES_BY_ORG_TYPE[orgType].includes(role)) {
    throw badRequest(
      `Role "${role}" is not valid for a ${orgType.replace('_', ' ')}. Allowed: ${ROLES_BY_ORG_TYPE[orgType].join(', ')}`,
    );
  }
}

/** Resolves an org the caller may administer, or 404s rather than confirming it exists. */
async function loadOrgForAdmin(
  principal: ReturnType<typeof requirePrincipal>,
  orgId: string,
) {
  const membership = principal.memberships.find((m) => m.orgId === orgId);
  if (!membership) throw notFound('Organization');
  if (!canManageMembers(principal, orgId)) {
    throw forbidden('Only an owner or admin can manage members');
  }

  const { db } = await getDb();
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw notFound('Organization');
  return { org, db, membership };
}

/** An org must never lose its last owner - nobody could administer it again. */
async function assertNotLastOwner(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  orgId: string,
  userId: string,
) {
  const [target] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!target || target.role !== 'owner') return;

  const [remaining] = await db
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.role, 'owner'),
        ne(memberships.userId, userId),
      ),
    );

  if ((remaining?.n ?? 0) === 0) {
    throw conflict(
      'This is the only owner. Promote someone else to owner first.',
    );
  }
}

export async function orgRoutes(app: FastifyInstance) {
  /** Every org the caller belongs to, with their role in each. */
  app.get('/api/orgs', async (req) => {
    const p = requirePrincipal(req);
    return { organizations: p.memberships, accountId: p.accountId };
  });

  app.get<{ Params: { orgId: string } }>('/api/orgs/:orgId/members', async (req) => {
    const p = requirePrincipal(req);
    // Any member may see the roster; only admins may change it.
    if (!p.memberships.some((m) => m.orgId === req.params.orgId)) {
      throw notFound('Organization');
    }
    const { db } = await getDb();

    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        accountId: users.accountId,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, req.params.orgId))
      .orderBy(memberships.role, users.name);

    return { members: rows };
  });

  /**
   * The account-ID path: the person already signed up and read their ID off
   * their screen. No email, no waiting - they are in the roster immediately.
   */
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/members/by-account-id',
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { org, db } = await loadOrgForAdmin(p, req.params.orgId);
      const body = addMemberByAccountIdSchema.parse(req.body);
      assertRoleValidFor(org.type, body.role);

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.accountId, body.accountId))
        .limit(1);
      if (!user) {
        throw notFound(
          'No account with that ID. Ask them to sign up first, then re-send you their ID',
        );
      }

      const [already] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(eq(memberships.orgId, org.id), eq(memberships.userId, user.id)),
        )
        .limit(1);
      if (already) throw conflict('That account is already in this organization');

      await db.insert(memberships).values({
        userId: user.id,
        orgId: org.id,
        role: body.role,
      });

      reply.code(201);
      return {
        member: {
          userId: user.id,
          name: user.name,
          email: user.email,
          accountId: user.accountId,
          role: body.role,
        },
      };
    },
  );

  /** The email path: for people who have not signed up yet. */
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/invites',
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { org, db } = await loadOrgForAdmin(p, req.params.orgId);
      const body = inviteMemberSchema.parse(req.body);
      assertRoleValidFor(org.type, body.role);

      const { token, tokenHash } = generateToken();
      const expiresAt = new Date(Date.now() + env.INVITE_TTL_DAYS * 86_400_000);

      await db.insert(invites).values({
        orgId: org.id,
        email: body.email,
        role: body.role,
        tokenHash,
        expiresAt,
        invitedBy: p.userId,
      });

      const link = `${env.PUBLIC_APP_URL}/accept-invite?token=${token}`;
      const sent = await sendInviteEmail({
        to: body.email,
        link,
        orgName: org.name,
        inviterName: p.name,
        roleLabel: body.role,
      });

      reply.code(201);
      return {
        invited: body.email,
        role: body.role,
        expiresAt,
        emailDelivered: sent.delivered,
        // Only populated by the console driver, for local development.
        previewLink: sent.previewLink,
      };
    },
  );

  app.get<{ Params: { orgId: string } }>('/api/orgs/:orgId/invites', async (req) => {
    const p = requirePrincipal(req);
    const { db } = await loadOrgForAdmin(p, req.params.orgId);

    const rows = await db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        expiresAt: invites.expiresAt,
        createdAt: invites.createdAt,
        newClientOrgName: invites.createsClientOrgName,
      })
      .from(invites)
      .where(
        and(
          eq(invites.orgId, req.params.orgId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .orderBy(invites.createdAt);

    return { invites: rows };
  });

  app.delete<{ Params: { orgId: string; inviteId: string } }>(
    '/api/orgs/:orgId/invites/:inviteId',
    async (req) => {
      const p = requirePrincipal(req);
      const { db } = await loadOrgForAdmin(p, req.params.orgId);
      await db
        .delete(invites)
        .where(
          and(
            eq(invites.id, req.params.inviteId),
            eq(invites.orgId, req.params.orgId),
          ),
        );
      return { revoked: true };
    },
  );

  app.patch<{ Params: { orgId: string; userId: string } }>(
    '/api/orgs/:orgId/members/:userId',
    async (req) => {
      const p = requirePrincipal(req);
      const { org, db } = await loadOrgForAdmin(p, req.params.orgId);
      const body = updateMemberRoleSchema.parse(req.body);
      assertRoleValidFor(org.type, body.role);

      if (body.role !== 'owner') {
        await assertNotLastOwner(db, org.id, req.params.userId);
      }

      const [updated] = await db
        .update(memberships)
        .set({ role: body.role, updatedAt: new Date() })
        .where(
          and(
            eq(memberships.orgId, org.id),
            eq(memberships.userId, req.params.userId),
          ),
        )
        .returning();
      if (!updated) throw notFound('Member');

      return { member: updated };
    },
  );

  app.delete<{ Params: { orgId: string; userId: string } }>(
    '/api/orgs/:orgId/members/:userId',
    async (req) => {
      const p = requirePrincipal(req);
      const { org, db } = await loadOrgForAdmin(p, req.params.orgId);
      await assertNotLastOwner(db, org.id, req.params.userId);

      await db
        .delete(memberships)
        .where(
          and(
            eq(memberships.orgId, org.id),
            eq(memberships.userId, req.params.userId),
          ),
        );
      return { removed: true };
    },
  );

  // --- Client roster (inspecting companies only) ----------------------------

  app.get<{ Params: { orgId: string } }>('/api/orgs/:orgId/clients', async (req) => {
    const p = requirePrincipal(req);
    if (!p.memberships.some((m) => m.orgId === req.params.orgId)) {
      throw notFound('Organization');
    }
    const { db } = await getDb();

    const rows = await db
      .select({
        clientOrgId: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        linkedAt: clientRelationships.createdAt,
      })
      .from(clientRelationships)
      .innerJoin(
        organizations,
        eq(clientRelationships.clientOrgId, organizations.id),
      )
      .where(eq(clientRelationships.companyOrgId, req.params.orgId))
      .orderBy(organizations.name);

    return { clients: rows };
  });

  /**
   * Adding a client by account ID links their whole ORGANIZATION, not just the
   * one person - which is what makes "5 people in charge of reports" work
   * without the inspecting company adding each of them individually.
   */
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/clients/by-account-id',
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { org, db } = await loadOrgForAdmin(p, req.params.orgId);
      if (org.type !== 'inspection_company') {
        throw forbidden('Only an inspecting company keeps a client roster');
      }
      const body = addClientByAccountIdSchema.parse(req.body);

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.accountId, body.accountId))
        .limit(1);
      if (!user) throw notFound('No account with that ID');

      const [clientMembership] = await db
        .select({ orgId: organizations.id, name: organizations.name })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.orgId, organizations.id))
        .where(
          and(eq(memberships.userId, user.id), eq(organizations.type, 'client')),
        )
        .limit(1);

      if (!clientMembership) {
        throw badRequest(
          'That account does not belong to a client company. Ask them to sign up as a client, or invite them by email instead.',
        );
      }

      const [already] = await db
        .select({ id: clientRelationships.id })
        .from(clientRelationships)
        .where(
          and(
            eq(clientRelationships.companyOrgId, org.id),
            eq(clientRelationships.clientOrgId, clientMembership.orgId),
          ),
        )
        .limit(1);
      if (already) throw conflict('That client is already on your roster');

      await db.insert(clientRelationships).values({
        companyOrgId: org.id,
        clientOrgId: clientMembership.orgId,
      });

      reply.code(201);
      return {
        client: { clientOrgId: clientMembership.orgId, name: clientMembership.name },
      };
    },
  );

  /** Invite a client company that has no InspectorOne account at all yet. */
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/clients/invite',
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { org, db } = await loadOrgForAdmin(p, req.params.orgId);
      if (org.type !== 'inspection_company') {
        throw forbidden('Only an inspecting company keeps a client roster');
      }
      const body = inviteClientSchema.parse(req.body);

      const { token, tokenHash } = generateToken();
      const expiresAt = new Date(Date.now() + env.INVITE_TTL_DAYS * 86_400_000);

      await db.insert(invites).values({
        orgId: org.id,
        email: body.email,
        role: 'owner',
        tokenHash,
        expiresAt,
        invitedBy: p.userId,
        // Accepting creates this client org and links it back to us.
        createsClientOrgName: body.organizationName,
        linkToCompanyOrgId: org.id,
      });

      const link = `${env.PUBLIC_APP_URL}/accept-invite?token=${token}`;
      const sent = await sendInviteEmail({
        to: body.email,
        link,
        orgName: org.name,
        inviterName: p.name,
        roleLabel: `owner of ${body.organizationName}`,
      });

      reply.code(201);
      return {
        invited: body.email,
        organizationName: body.organizationName,
        expiresAt,
        emailDelivered: sent.delivered,
        previewLink: sent.previewLink,
      };
    },
  );
}
