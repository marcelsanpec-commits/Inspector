import {
  clientOrgIds,
  companyStaffOrgIds,
  createObjectSchema,
  createSiteSchema,
  inspectorOrgIds,
  updateObjectSchema,
  type Principal,
} from '@inspectorone/shared';
import { and, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/index.js';
import { badRequest, forbidden, notFound } from '../authz.js';
import { getDb } from '../db/client.js';
import {
  clientRelationships,
  jobObjects,
  jobs,
  objects,
  organizations,
  photos,
  sites,
} from '../db/schema.js';
import { loadJobContext, resolveCompanyOrg } from '../lib/job-context.js';
import { canWriteJobContent } from '../authz.js';

const DENY_ALL: SQL = sql`false`;

/** Same union-of-memberships shape as `jobScope`, applied to sites. */
function siteScope(p: Principal): SQL {
  const clauses: SQL[] = [];

  const staffOrgs = companyStaffOrgIds(p);
  if (staffOrgs.length) clauses.push(inArray(sites.companyOrgId, staffOrgs));

  // An inspector can see a site only through a job they were assigned to.
  const inspectorOrgs = inspectorOrgIds(p);
  if (inspectorOrgs.length) {
    const viaJob = and(
      inArray(sites.companyOrgId, inspectorOrgs),
      sql`EXISTS (SELECT 1 FROM jobs j JOIN job_inspectors ji ON ji.job_id = j.id WHERE j.site_id = ${sites.id} AND ji.user_id = ${p.userId})`,
    );
    if (viaJob) clauses.push(viaJob);
  }

  const clients = clientOrgIds(p);
  if (clients.length) clauses.push(inArray(sites.clientOrgId, clients));

  if (!clauses.length) return DENY_ALL;
  if (clauses.length === 1) return clauses[0] as SQL;
  return or(...clauses) ?? DENY_ALL;
}

export async function siteRoutes(app: FastifyInstance) {
  app.get('/api/sites', async (req) => {
    const p = requirePrincipal(req);
    const { db } = await getDb();

    const rows = await db
      .select({
        id: sites.id,
        name: sites.name,
        addressLine1: sites.addressLine1,
        city: sites.city,
        state: sites.state,
        postalCode: sites.postalCode,
        lat: sites.lat,
        lng: sites.lng,
        clientOrgId: sites.clientOrgId,
        clientName: organizations.name,
        companyOrgId: sites.companyOrgId,
      })
      .from(sites)
      .innerJoin(organizations, eq(sites.clientOrgId, organizations.id))
      .where(siteScope(p))
      .orderBy(sites.name);

    return { sites: rows };
  });

  app.post('/api/sites', async (req, reply) => {
    const p = requirePrincipal(req);
    const body = createSiteSchema.parse(req.body);
    const companyOrgId = resolveCompanyOrg(p, body.companyOrgId);
    const { db } = await getDb();

    // The client must already be on this company's roster - otherwise a site
    // could be filed against an organization the company has no relationship
    // with, and its members would immediately gain visibility.
    const [linked] = await db
      .select({ id: clientRelationships.id })
      .from(clientRelationships)
      .where(
        and(
          eq(clientRelationships.companyOrgId, companyOrgId),
          eq(clientRelationships.clientOrgId, body.clientOrgId),
        ),
      )
      .limit(1);
    if (!linked) {
      throw badRequest('That client is not on your roster yet - add them first');
    }

    const [created] = await db
      .insert(sites)
      .values({
        companyOrgId,
        clientOrgId: body.clientOrgId,
        name: body.name,
        addressLine1: body.addressLine1 ?? null,
        city: body.city ?? null,
        state: body.state ?? null,
        postalCode: body.postalCode ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
      })
      .returning();

    reply.code(201);
    return { site: created };
  });

  /** Every serial-numbered asset recorded at a site, newest activity first. */
  app.get<{ Params: { siteId: string } }>(
    '/api/sites/:siteId/objects',
    async (req) => {
      const p = requirePrincipal(req);
      const { db } = await getDb();

      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, req.params.siteId), siteScope(p)))
        .limit(1);
      if (!site) throw notFound('Site');

      const rows = await db
        .select({
          id: objects.id,
          serialNumber: objects.serialNumber,
          label: objects.label,
          objectType: objects.objectType,
          notes: objects.notes,
          createdAt: objects.createdAt,
          photoCount: count(photos.id),
        })
        .from(objects)
        .leftJoin(
          photos,
          and(eq(photos.objectId, objects.id), eq(photos.status, 'ready')),
        )
        .where(eq(objects.siteId, req.params.siteId))
        .groupBy(objects.id)
        .orderBy(objects.serialNumber);

      return { objects: rows };
    },
  );

  /**
   * "New Object" in the field.
   *
   * Objects persist on a site across jobs, so an existing serial number returns
   * the existing object rather than erroring or duplicating. That is what makes
   * year-over-year history for a given serial possible, and it is forgiving
   * when someone re-enters a serial they already recorded this morning.
   */
  app.post('/api/objects', async (req, reply) => {
    const p = requirePrincipal(req);
    const body = createObjectSchema.parse(req.body);
    const { db } = await getDb();

    const [site] = await db
      .select()
      .from(sites)
      .where(and(eq(sites.id, body.siteId), siteScope(p)))
      .limit(1);
    if (!site) throw notFound('Site');

    // Creating objects is field work, so it needs write access to a job at this
    // site rather than mere visibility.
    if (body.jobId) {
      const { ctx } = await loadJobContext(p, body.jobId);
      if (!canWriteJobContent(p, ctx)) {
        throw forbidden('This job is no longer editable');
      }
    } else if (!companyStaffOrgIds(p).includes(site.companyOrgId)) {
      throw forbidden('Provide the job you are working on');
    }

    const [existing] = await db
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.siteId, body.siteId),
          eq(objects.serialNumber, body.serialNumber),
        ),
      )
      .limit(1);

    let object = existing;
    if (!object) {
      const [created] = await db
        .insert(objects)
        .values({
          companyOrgId: site.companyOrgId,
          siteId: body.siteId,
          serialNumber: body.serialNumber,
          label: body.label ?? null,
          objectType: body.objectType ?? null,
          notes: body.notes ?? null,
          createdBy: p.userId,
        })
        .returning();
      object = created!;
    }

    if (body.jobId) {
      const [maxPos] = await db
        .select({ n: count() })
        .from(jobObjects)
        .where(eq(jobObjects.jobId, body.jobId));

      await db
        .insert(jobObjects)
        .values({
          jobId: body.jobId,
          objectId: object.id,
          position: maxPos?.n ?? 0,
        })
        .onConflictDoNothing();
    }

    reply.code(existing ? 200 : 201);
    return { object, reused: !!existing };
  });

  /** One object plus its cross-job history - the payoff of persistent objects. */
  app.get<{ Params: { objectId: string } }>(
    '/api/objects/:objectId',
    async (req) => {
      const p = requirePrincipal(req);
      const { db } = await getDb();

      const [object] = await db
        .select({
          id: objects.id,
          serialNumber: objects.serialNumber,
          label: objects.label,
          objectType: objects.objectType,
          notes: objects.notes,
          siteId: objects.siteId,
          siteName: sites.name,
          createdAt: objects.createdAt,
        })
        .from(objects)
        .innerJoin(sites, eq(objects.siteId, sites.id))
        .where(and(eq(objects.id, req.params.objectId), siteScope(p)))
        .limit(1);
      if (!object) throw notFound('Object');

      const history = await db
        .select({
          jobId: jobs.id,
          jobNumber: jobs.jobNumber,
          title: jobs.title,
          status: jobs.status,
          scheduledFor: jobs.scheduledFor,
          photoCount: count(photos.id),
        })
        .from(jobObjects)
        .innerJoin(jobs, eq(jobObjects.jobId, jobs.id))
        .leftJoin(
          photos,
          and(
            eq(photos.jobId, jobs.id),
            eq(photos.objectId, req.params.objectId),
            eq(photos.status, 'ready'),
          ),
        )
        .where(eq(jobObjects.objectId, req.params.objectId))
        .groupBy(jobs.id)
        .orderBy(desc(jobs.scheduledFor));

      return { object, history };
    },
  );

  app.patch<{ Params: { objectId: string } }>(
    '/api/objects/:objectId',
    async (req) => {
      const p = requirePrincipal(req);
      const body = updateObjectSchema.parse(req.body);
      const { db } = await getDb();

      const [object] = await db
        .select()
        .from(objects)
        .innerJoin(sites, eq(objects.siteId, sites.id))
        .where(and(eq(objects.id, req.params.objectId), siteScope(p)))
        .limit(1);
      if (!object) throw notFound('Object');

      const [updated] = await db
        .update(objects)
        .set({
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.objectType !== undefined ? { objectType: body.objectType } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(objects.id, req.params.objectId))
        .returning();

      return { object: updated };
    },
  );
}
