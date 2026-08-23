import { randomUUID } from 'node:crypto';
import {
  confirmPhotoUploadSchema,
  galleryQuerySchema,
  requestPhotoUploadSchema,
  updatePhotoSchema,
} from '@inspectorone/shared';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/index.js';
import {
  badRequest,
  canWriteJobContent,
  forbidden,
  HttpError,
  jobScope,
  notFound,
} from '../authz.js';
import { getDb } from '../db/client.js';
import { jobObjects, jobs, objects, organizations, photos, sites } from '../db/schema.js';
import { loadJobContext } from '../lib/job-context.js';
import { getStorage, photoKey } from '../storage/index.js';

export async function photoRoutes(app: FastifyInstance) {
  /**
   * Step 1 of the upload handshake.
   *
   * The client has already resized, compressed, and read EXIF off the image. It
   * sends metadata only and receives a URL it PUTs the bytes to directly - the
   * API never handles image data, which is what stops a small Render instance
   * from falling over when an inspector syncs forty photos at once.
   */
  app.post('/api/photos/upload-url', async (req, reply) => {
    const p = requirePrincipal(req);
    const body = requestPhotoUploadSchema.parse(req.body);
    const { job, ctx, db } = await loadJobContext(p, body.jobId);
    if (!canWriteJobContent(p, ctx)) {
      throw forbidden('This job is no longer accepting photos');
    }

    // An object must belong to this job's site, or a photo could be filed
    // against equipment at somebody else's building.
    if (body.objectId) {
      const [object] = await db
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.id, body.objectId), eq(objects.siteId, job.siteId)))
        .limit(1);
      if (!object) throw notFound('Object');

      await db
        .insert(jobObjects)
        .values({ jobId: job.id, objectId: body.objectId })
        .onConflictDoNothing();
    }

    const storage = await getStorage();

    /**
     * Idempotency for offline retries: an inspector who loses signal mid-upload
     * retries with the same clientRef and gets the same row plus a fresh
     * ticket, rather than a duplicate photo in the gallery.
     */
    if (body.clientRef) {
      const [existing] = await db
        .select()
        .from(photos)
        .where(and(eq(photos.jobId, job.id), eq(photos.clientRef, body.clientRef)))
        .limit(1);

      if (existing) {
        if (existing.status === 'ready') {
          return { photoId: existing.id, alreadyUploaded: true };
        }
        const ticket = await storage.createUploadUrl({
          key: existing.storageKey,
          contentType: existing.contentType,
          maxBytes: body.byteSize,
        });
        return { photoId: existing.id, ...ticket };
      }
    }

    // Generate the id first so the storage key is known before insert.
    const photoId = randomUUID();
    const key = photoKey({
      orgId: job.companyOrgId,
      jobId: job.id,
      photoId,
      contentType: body.contentType,
    });

    await db.insert(photos).values({
      id: photoId,
      companyOrgId: job.companyOrgId,
      jobId: job.id,
      objectId: body.objectId ?? null,
      storageKey: key,
      contentType: body.contentType,
      byteSize: body.byteSize,
      width: body.width ?? null,
      height: body.height ?? null,
      takenAt: body.takenAt ?? null,
      gpsLat: body.gpsLat ?? null,
      gpsLng: body.gpsLng ?? null,
      caption: body.caption ?? null,
      voiceNote: body.voiceNote ?? null,
      voiceNoteIsDictated: body.voiceNoteIsDictated,
      includeInReport: body.includeInReport,
      status: 'pending',
      uploadedBy: p.userId,
      clientRef: body.clientRef ?? null,
    });

    const ticket = await storage.createUploadUrl({
      key,
      contentType: body.contentType,
      maxBytes: body.byteSize,
    });

    reply.code(201);
    return { photoId, ...ticket };
  });

  /**
   * Step 3. Verifies against storage rather than trusting the client - a photo
   * only becomes `ready` once the bytes are demonstrably there.
   */
  app.post('/api/photos/confirm', async (req) => {
    const p = requirePrincipal(req);
    const { photoId } = confirmPhotoUploadSchema.parse(req.body);
    const { db } = await getDb();

    const [photo] = await db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
    if (!photo) throw notFound('Photo');

    const { ctx } = await loadJobContext(p, photo.jobId);
    if (!canWriteJobContent(p, ctx)) throw forbidden('This job is no longer editable');

    const storage = await getStorage();
    const stat = await storage.statObject(photo.storageKey);
    if (!stat) {
      throw new HttpError(
        400,
        'upload_not_found',
        'No object at that storage key - the upload did not complete. Retry with the same clientRef.',
      );
    }

    const [updated] = await db
      .update(photos)
      .set({ status: 'ready', byteSize: stat.size, updatedAt: new Date() })
      .where(eq(photos.id, photo.id))
      .returning();

    return { photo: updated };
  });

  /**
   * Everything the inspector can change afterwards: the caption, the dictated
   * note, which object it belongs to, and whether it reaches the report. The
   * include toggle is deliberately editable long after capture - the decision
   * is usually clearer back at the office than on a ladder.
   */
  app.patch<{ Params: { id: string } }>('/api/photos/:id', async (req) => {
    const p = requirePrincipal(req);
    const body = updatePhotoSchema.parse(req.body);
    const { db } = await getDb();

    const [photo] = await db
      .select()
      .from(photos)
      .where(eq(photos.id, req.params.id))
      .limit(1);
    if (!photo) throw notFound('Photo');

    const { job, ctx } = await loadJobContext(p, photo.jobId);
    if (!canWriteJobContent(p, ctx)) throw forbidden('This job is no longer editable');

    if (body.objectId) {
      const [object] = await db
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.id, body.objectId), eq(objects.siteId, job.siteId)))
        .limit(1);
      if (!object) throw badRequest('That object is not at this job site');

      await db
        .insert(jobObjects)
        .values({ jobId: job.id, objectId: body.objectId })
        .onConflictDoNothing();
    }

    const [updated] = await db
      .update(photos)
      .set({
        ...(body.caption !== undefined ? { caption: body.caption } : {}),
        ...(body.voiceNote !== undefined ? { voiceNote: body.voiceNote } : {}),
        ...(body.voiceNoteIsDictated !== undefined
          ? { voiceNoteIsDictated: body.voiceNoteIsDictated }
          : {}),
        ...(body.includeInReport !== undefined
          ? { includeInReport: body.includeInReport }
          : {}),
        ...(body.objectId !== undefined ? { objectId: body.objectId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(photos.id, photo.id))
      .returning();

    return { photo: updated };
  });

  app.delete<{ Params: { id: string } }>('/api/photos/:id', async (req) => {
    const p = requirePrincipal(req);
    const { db } = await getDb();

    const [photo] = await db
      .select()
      .from(photos)
      .where(eq(photos.id, req.params.id))
      .limit(1);
    if (!photo) throw notFound('Photo');

    const { ctx } = await loadJobContext(p, photo.jobId);
    if (!canWriteJobContent(p, ctx)) throw forbidden('This job is no longer editable');

    const storage = await getStorage();
    await storage.deleteObject(photo.storageKey);
    await db.delete(photos).where(eq(photos.id, photo.id));

    return { deleted: true };
  });

  /**
   * The gallery - every photo the caller may see, filterable by job, jobsite,
   * object, client, and capture date.
   *
   * This is separate from the report on purpose: most photos never reach a
   * report, but the company and the client still need to browse everything that
   * was documented. Access rides on `jobScope`, so a client sees only delivered
   * work for their own organization and nothing else.
   */
  app.get('/api/gallery', async (req) => {
    const p = requirePrincipal(req);
    const q = galleryQuerySchema.parse(req.query);
    const { db } = await getDb();
    const storage = await getStorage();

    const filters = [jobScope(p), eq(photos.status, 'ready')];
    if (q.jobId) filters.push(eq(photos.jobId, q.jobId));
    if (q.siteId) filters.push(eq(jobs.siteId, q.siteId));
    if (q.objectId) filters.push(eq(photos.objectId, q.objectId));
    if (q.clientOrgId) filters.push(eq(jobs.clientOrgId, q.clientOrgId));
    if (q.takenFrom) filters.push(gte(photos.takenAt, q.takenFrom));
    if (q.takenTo) filters.push(lte(photos.takenAt, q.takenTo));
    if (q.includeInReport !== undefined) {
      filters.push(eq(photos.includeInReport, q.includeInReport));
    }

    const rows = await db
      .select({
        id: photos.id,
        storageKey: photos.storageKey,
        contentType: photos.contentType,
        width: photos.width,
        height: photos.height,
        takenAt: photos.takenAt,
        gpsLat: photos.gpsLat,
        gpsLng: photos.gpsLng,
        caption: photos.caption,
        voiceNote: photos.voiceNote,
        includeInReport: photos.includeInReport,
        createdAt: photos.createdAt,
        jobId: jobs.id,
        jobNumber: jobs.jobNumber,
        jobTitle: jobs.title,
        siteId: sites.id,
        siteName: sites.name,
        clientOrgId: organizations.id,
        clientName: organizations.name,
        objectId: objects.id,
        objectSerial: objects.serialNumber,
        objectLabel: objects.label,
      })
      .from(photos)
      .innerJoin(jobs, eq(photos.jobId, jobs.id))
      .innerJoin(sites, eq(jobs.siteId, sites.id))
      .innerJoin(organizations, eq(jobs.clientOrgId, organizations.id))
      .leftJoin(objects, eq(photos.objectId, objects.id))
      .where(and(...filters))
      .orderBy(desc(photos.takenAt), desc(photos.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    // Signed, short-lived URLs. The bucket itself stays entirely private.
    const withUrls = await Promise.all(
      rows.map(async ({ storageKey, ...row }) => ({
        ...row,
        url: await storage.createDownloadUrl({ key: storageKey }),
      })),
    );

    return { photos: withUrls, limit: q.limit, offset: q.offset };
  });

  /** Photos for one job, grouped by object - the inspector's working view. */
  app.get<{ Params: { id: string } }>('/api/jobs/:id/photos', async (req) => {
    const p = requirePrincipal(req);
    const { job, db } = await loadJobContext(p, req.params.id);
    const storage = await getStorage();

    const rows = await db
      .select({
        photo: photos,
        objectSerial: objects.serialNumber,
        objectLabel: objects.label,
      })
      .from(photos)
      .leftJoin(objects, eq(photos.objectId, objects.id))
      .where(and(eq(photos.jobId, job.id), eq(photos.status, 'ready')))
      .orderBy(asc(objects.serialNumber), desc(photos.takenAt));

    const withUrls = await Promise.all(
      rows.map(async (row) => ({
        ...row.photo,
        objectSerial: row.objectSerial,
        objectLabel: row.objectLabel,
        url: await storage.createDownloadUrl({ key: row.photo.storageKey }),
      })),
    );

    return { photos: withUrls };
  });
}
