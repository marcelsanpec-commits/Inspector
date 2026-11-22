import {
  createJobSchema,
  listJobsQuerySchema,
  setJobClientViewersSchema,
  setJobInspectorsSchema,
  updateJobSchema,
} from '@inspectorone/shared';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/index.js';
import {
  badRequest,
  canManageJob,
  canSubmitJob,
  canWriteJobContent,
  forbidden,
  jobScope,
  notFound,
} from '../authz.js';
import { getDb } from '../db/client.js';
import {
  clientRelationships,
  jobClientViewers,
  jobInspectors,
  jobObjects,
  jobs,
  memberships,
  objects,
  organizations,
  photos,
  sites,
  users,
} from '../db/schema.js';
import { loadJobContext, resolveCompanyOrg } from '../lib/job-context.js';

/** Every id must be an inspector at this company - not merely a real user. */
async function assertInspectorsBelong(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  companyOrgId: string,
  ids: string[],
) {
  if (!ids.length) return;
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, companyOrgId),
        inArray(memberships.userId, ids),
        inArray(memberships.role, ['inspector', 'owner', 'admin']),
      ),
    );
  if (rows.length !== new Set(ids).size) {
    throw badRequest('One or more inspectors are not members of your company');
  }
}

/** Named client viewers must actually belong to the job's client org. */
async function assertViewersBelong(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  clientOrgId: string,
  ids: string[],
) {
  if (!ids.length) return;
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, clientOrgId), inArray(memberships.userId, ids)));
  if (rows.length !== new Set(ids).size) {
    throw badRequest('One or more people are not members of that client company');
  }
}

export async function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs', async (req) => {
    const p = requirePrincipal(req);
    const q = listJobsQuerySchema.parse(req.query);
    const { db } = await getDb();

    const filters = [jobScope(p)];
    if (q.status) filters.push(eq(jobs.status, q.status));
    if (q.clientOrgId) filters.push(eq(jobs.clientOrgId, q.clientOrgId));
    if (q.siteId) filters.push(eq(jobs.siteId, q.siteId));

    const rows = await db
      .select({
        id: jobs.id,
        jobNumber: jobs.jobNumber,
        title: jobs.title,
        status: jobs.status,
        clientAccess: jobs.clientAccess,
        scheduledFor: jobs.scheduledFor,
        deliveredAt: jobs.deliveredAt,
        createdAt: jobs.createdAt,
        siteId: sites.id,
        siteName: sites.name,
        siteCity: sites.city,
        clientOrgId: organizations.id,
        clientName: organizations.name,
      })
      .from(jobs)
      .innerJoin(sites, eq(jobs.siteId, sites.id))
      .innerJoin(organizations, eq(jobs.clientOrgId, organizations.id))
      .where(and(...filters))
      .orderBy(desc(jobs.scheduledFor), desc(jobs.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    return { jobs: rows };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);

    const [site] = await db.select().from(sites).where(eq(sites.id, job.siteId)).limit(1);
    const [client] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, job.clientOrgId))
      .limit(1);

    const inspectors = await db
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(jobInspectors)
      .innerJoin(users, eq(jobInspectors.userId, users.id))
      .where(eq(jobInspectors.jobId, job.id));

    // Structures worked on this job, each with how many photos it carries.
    const jobObjectRows = await db
      .select({
        structureId: jobObjects.id,
        objectId: objects.id,
        serialNumber: objects.serialNumber,
        label: objects.label,
        objectType: objects.objectType,
        position: jobObjects.position,
        notes: jobObjects.notes,
        finishedAt: jobObjects.finishedAt,
        photoCount: count(photos.id),
      })
      .from(jobObjects)
      .innerJoin(objects, eq(jobObjects.objectId, objects.id))
      .leftJoin(
        photos,
        and(
          eq(photos.objectId, objects.id),
          eq(photos.jobId, job.id),
          eq(photos.status, 'ready'),
        ),
      )
      .where(eq(jobObjects.jobId, job.id))
      .groupBy(jobObjects.id, objects.id)
      .orderBy(jobObjects.position, jobObjects.createdAt);

    const [photoTotal] = await db
      .select({ n: count() })
      .from(photos)
      .where(and(eq(photos.jobId, job.id), eq(photos.status, 'ready')));

    return {
      job,
      site,
      client,
      inspectors,
      objects: jobObjectRows,
      photoCount: photoTotal?.n ?? 0,
      /** Lets the portal hide controls the caller cannot use. */
      permissions: {
        canWriteContent: canWriteJobContent(p, ctx),
        canManage: canManageJob(p, ctx),
        canSubmit: canSubmitJob(p, ctx),
      },
    };
  });

  app.post('/api/jobs', async (req, reply) => {
    const p = requirePrincipal(req);
    const body = createJobSchema.parse(req.body);
    const companyOrgId = resolveCompanyOrg(p, body.companyOrgId);
    const { db } = await getDb();

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
    if (!linked) throw badRequest('That client is not on your roster');

    const [site] = await db
      .select()
      .from(sites)
      .where(
        and(
          eq(sites.id, body.siteId),
          eq(sites.companyOrgId, companyOrgId),
          eq(sites.clientOrgId, body.clientOrgId),
        ),
      )
      .limit(1);
    if (!site) throw notFound('Site');

    await assertInspectorsBelong(db, companyOrgId, body.inspectorIds);
    await assertViewersBelong(db, body.clientOrgId, body.clientViewerIds);

    const year = new Date().getFullYear();
    const [existing] = await db
      .select({ n: count() })
      .from(jobs)
      .where(eq(jobs.companyOrgId, companyOrgId));
    const jobNumber = `JOB-${year}-${String((existing?.n ?? 0) + 1).padStart(4, '0')}`;

    const job = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(jobs)
        .values({
          companyOrgId,
          clientOrgId: body.clientOrgId,
          siteId: body.siteId,
          jobNumber,
          title: body.title,
          status: body.inspectorIds.length ? 'scheduled' : 'draft',
          clientAccess: body.clientAccess,
          scheduledFor: body.scheduledFor ?? null,
          notes: body.notes ?? null,
        })
        .returning();

      if (body.inspectorIds.length) {
        await tx
          .insert(jobInspectors)
          .values(body.inspectorIds.map((userId) => ({ jobId: created!.id, userId })));
      }
      if (body.clientAccess === 'restricted' && body.clientViewerIds.length) {
        await tx
          .insert(jobClientViewers)
          .values(body.clientViewerIds.map((userId) => ({ jobId: created!.id, userId })));
      }

      return created!;
    });

    reply.code(201);
    return { job };
  });

  app.patch<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);
    const body = updateJobSchema.parse(req.body);

    // Status and visibility are company-staff decisions; an inspector may only
    // edit descriptive fields, and only while the job is open.
    const managementFields =
      body.status !== undefined || body.clientAccess !== undefined;
    if (managementFields) {
      if (!canManageJob(p, ctx)) throw forbidden('Only company staff can change this');
    } else if (!canWriteJobContent(p, ctx)) {
      throw forbidden('This job is no longer editable');
    }

    const [updated] = await db
      .update(jobs)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.clientAccess !== undefined ? { clientAccess: body.clientAccess } : {}),
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id))
      .returning();

    return { job: updated };
  });

  app.put<{ Params: { id: string } }>('/api/jobs/:id/inspectors', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);
    if (!canManageJob(p, ctx)) throw forbidden('Only company staff can assign inspectors');

    const body = setJobInspectorsSchema.parse(req.body);
    await assertInspectorsBelong(db, job.companyOrgId, body.inspectorIds);

    await db.transaction(async (tx) => {
      await tx.delete(jobInspectors).where(eq(jobInspectors.jobId, job.id));
      if (body.inspectorIds.length) {
        await tx
          .insert(jobInspectors)
          .values(body.inspectorIds.map((userId) => ({ jobId: job.id, userId })));
      }
    });

    return { inspectorIds: body.inspectorIds };
  });

  app.put<{ Params: { id: string } }>('/api/jobs/:id/client-viewers', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);
    if (!canManageJob(p, ctx)) throw forbidden('Only company staff can change client access');

    const body = setJobClientViewersSchema.parse(req.body);
    await assertViewersBelong(db, job.clientOrgId, body.clientViewerIds);

    await db.transaction(async (tx) => {
      await tx.delete(jobClientViewers).where(eq(jobClientViewers.jobId, job.id));
      if (body.clientViewerIds.length) {
        await tx
          .insert(jobClientViewers)
          .values(body.clientViewerIds.map((userId) => ({ jobId: job.id, userId })));
      }
    });

    return { clientViewerIds: body.clientViewerIds };
  });

  // --- Workflow transitions -------------------------------------------------

  /**
   * "Start Inspection". Safe to press twice: an inspection already under way
   * is returned untouched, and `startedAt` keeps the first start rather than
   * moving to whenever somebody last opened the screen.
   */
  app.post<{ Params: { id: string } }>('/api/jobs/:id/start', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);
    if (!canWriteJobContent(p, ctx)) throw forbidden('Cannot start this job');
    if (job.status === 'in_progress') return { job };

    const [updated] = await db
      .update(jobs)
      .set({
        status: 'in_progress',
        startedAt: job.startedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id))
      .returning();
    return { job: updated };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/submit', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);
    if (!canSubmitJob(p, ctx)) throw forbidden('Cannot submit this job');

    const [updated] = await db
      .update(jobs)
      .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .returning();
    return { job: updated };
  });

  /**
   * Delivery is the moment a job becomes visible to the client, so it is a
   * deliberate company-staff action rather than a side effect of an inspector
   * finishing their day.
   */
  app.post<{ Params: { id: string } }>('/api/jobs/:id/deliver', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.id);
    if (!canManageJob(p, ctx)) throw forbidden('Only company staff can deliver a job');

    const [updated] = await db
      .update(jobs)
      .set({ status: 'delivered', deliveredAt: new Date(), updatedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .returning();
    return { job: updated };
  });

  /** Inspectors available to assign, for the company portal's job form. */
  app.get('/api/inspectors', async (req) => {
    const p = requirePrincipal(req);
    const companyOrgId = resolveCompanyOrg(
      p,
      (req.query as { companyOrgId?: string }).companyOrgId,
    );
    const { db } = await getDb();

    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        accountId: users.accountId,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.orgId, companyOrgId),
          inArray(memberships.role, ['inspector', 'owner', 'admin']),
        ),
      )
      .orderBy(users.name);

    return { inspectors: rows };
  });
}
