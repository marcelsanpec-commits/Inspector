import type { MembershipSummary, Principal } from '@inspectorone/shared';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../authz.js';
import { getDb } from '../db/client.js';
import { memberships, organizations, sessions, users } from '../db/schema.js';
import { env } from '../env.js';
import { generateToken, hashToken } from '../lib/ids.js';

/**
 * Opaque server-side sessions.
 *
 * A random 256-bit token goes to the client; only its SHA-256 is stored. That
 * makes sessions revocable (unlike a stateless JWT) and makes a database leak
 * useless for impersonation.
 *
 * The token travels as `Authorization: Bearer`. Three portals on three origins
 * would otherwise need cross-site cookies, which are fragile and increasingly
 * blocked by default. The trade-off is that a token in browser storage is
 * reachable by XSS, so the portals must never inject untrusted HTML.
 */

export async function createSession(userId: string, userAgent?: string) {
  const { db } = await getDb();
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);

  await db.insert(sessions).values({
    userId,
    tokenHash,
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });

  // Opportunistic cleanup - cheap, and avoids a cron for an early-stage app.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));

  return { token, expiresAt };
}

export async function destroySession(token: string) {
  const { db } = await getDb();
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function destroyAllSessionsForUser(userId: string) {
  const { db } = await getDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Loads the person plus every org they belong to. */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const { db } = await getDb();

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const rows = await db
    .select({
      orgId: organizations.id,
      orgType: organizations.type,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, userId));

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    accountId: user.accountId,
    signupRole: user.signupRole,
    memberships: rows as MembershipSummary[],
  };
}

function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

export async function authenticate(req: FastifyRequest): Promise<Principal | null> {
  const token = bearerFrom(req);
  if (!token) return null;

  const { db } = await getDb();
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);

  if (!session) return null;
  return loadPrincipal(session.userId);
}

export function requirePrincipal(req: FastifyRequest): Principal {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  return p;
}

/**
 * A signed-up inspector with no org yet can authenticate but has nothing to
 * see. Routes that need an org say so, rather than returning a confusing empty
 * list.
 */
export function requireAnyOrg(req: FastifyRequest): Principal {
  const p = requirePrincipal(req);
  if (p.memberships.length === 0) {
    throw new HttpError(
      403,
      'no_organization',
      'Your account is not part of an organization yet. Give your account ID to the inspecting company so they can add you.',
    );
  }
  return p;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    sessionToken?: string;
  }
}

export { bearerFrom };
