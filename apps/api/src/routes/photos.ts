import { randomUUID } from 'node:crypto';
import {
  confirmPhotoUploadSchema,
  galleryQuerySchema,
  NON_CONFORMING_IN_REPORT,
  requestPhotoUploadSchema,
  updatePhotoSchema,
} from '@inspectorone/shared';
import { and, asc, desc, eq, gte, lte, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/index.js';
import {
  badRequest,
  canWriteJobContent,
  conflict,
  forbidden,
  HttpError,
  jobScope,
  notFound,
} from '../authz.js';
import { getDb } from '../db/client.js';
import { jobObjects, jobs, objects, organizations, photos, sites } from '../db/schema.js';
import { loadJobContext } from '../lib/job-context.js';
import { getStorage, photoKey } from '../storage/index.js';

/** The Postgres error code, whether the driver throws it bare or wrapped. */
function pgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return (
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
  );
}

/** Postgres unique_violation - here, two plate photos confirmed at once. */
function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

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
      nonConforming: body.nonConforming,
      isSerialPlate: body.serialPlate,
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

    /**
     * A new serial plate photo is a retake, so it replaces the structure's
     * previous one outright rather than leaving a blurry first attempt behind
     * as an ordinary photo that would then land in the report. Replacement
     * happens here, at the moment the new bytes are proven to exist - never
     * earlier, so a failed retake cannot cost the structure its plate.
     */
    let result;
    try {
      result = await db.transaction(async (tx) => {
        const replaced =
          photo.isSerialPlate && photo.objectId
            ? await tx
                .delete(photos)
                .where(
                  and(
                    eq(photos.jobId, photo.jobId),
                    eq(photos.objectId, photo.objectId),
                    eq(photos.isSerialPlate, true),
                    ne(photos.id, photo.id),
                  ),
                )
                .returning({ storageKey: photos.storageKey })
            : [];

        const [updated] = await tx
          .update(photos)
          .set({ status: 'ready', byteSize: stat.size, updatedAt: new Date() })
          .where(eq(photos.id, photo.id))
          .returning();

        return { updated, replaced };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('Another serial plate photo was saved at the same moment. Try again.');
      }
      throw err;
    }

    // Bytes go only after the rows are gone, so a failure here strands a file
    // nobody references rather than a row pointing at nothing.
    for (const { storageKey } of result.replaced) {
      await storage.deleteObject(storageKey).catch((err: unknown) => {
        req.log.warn({ err, storageKey }, 'Could not delete replaced plate photo');
      });
    }

    return { photo: result.updated };
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

    // Flagging a finding pulls the photo into the report; trying to take a
    // finding out of the report is refused rather than silently ignored, so
    // the inspector learns why the toggle did not move.
    const nonConforming = body.nonConforming ?? photo.nonConforming;
    const includeInReport =
      body.includeInReport ?? (body.nonConforming === true ? true : photo.includeInReport);
    if (nonConforming && !includeInReport) {
      throw badRequest(`${NON_CONFORMING_IN_REPORT}. Clear the non-conforming flag first.`);
    }

    const objectId = body.objectId !== undefined ? body.objectId : photo.objectId;
    const moved = objectId !== photo.objectId;
    // A plate photo moved to another structure is not that structure's plate.
    const isSerialPlate = body.serialPlate ?? (moved ? false : photo.isSerialPlate);
    if (isSerialPlate && !objectId) {
      throw badRequest('A serial plate photo must belong to a structure');
    }
    const becomesPlate = isSerialPlate && (!photo.isSerialPlate || moved);

    let updated;
    try {
      updated = await db.transaction(async (tx) => {
        // Unlike a retake, choosing an existing photo as the plate keeps the
        // old plate - it simply becomes an ordinary photo of the structure.
        if (becomesPlate && objectId) {
          await tx
            .update(photos)
            .set({ isSerialPlate: false, updatedAt: new Date() })
            .where(
              and(
                eq(photos.jobId, photo.jobId),
                eq(photos.objectId, objectId),
                eq(photos.isSerialPlate, true),
                ne(photos.id, photo.id),
              ),
            );
        }

        // Only what this request changes is written. Writing back every flag
        // from the row read above would let a caption save that overlaps a
        // tap on "Non-conforming" quietly undo the flag.
        const [row] = await tx
          .update(photos)
          .set({
            ...(body.caption !== undefined ? { caption: body.caption } : {}),
            ...(body.voiceNote !== undefined ? { voiceNote: body.voiceNote } : {}),
            ...(body.voiceNoteIsDictated !== undefined
              ? { voiceNoteIsDictated: body.voiceNoteIsDictated }
              : {}),
            ...(includeInReport !== photo.includeInReport ? { includeInReport } : {}),
            ...(body.nonConforming !== undefined ? { nonConforming } : {}),
            ...(isSerialPlate !== photo.isSerialPlate ? { isSerialPlate } : {}),
            ...(body.objectId !== undefined ? { objectId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(photos.id, photo.id))
          .returning();
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('Another photo was made the serial plate at the same moment. Try again.');
      }
      // Two overlapping edits can still combine into a finding outside the
      // report; the check constraint stops it, and this says why.
      if (pgErrorCode(err) === '23514') {
        throw badRequest(`${NON_CONFORMING_IN_REPORT}. Clear the non-conforming flag first.`);
      }
      throw err;
    }

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
    if (q.nonConforming !== undefined) {
      filters.push(eq(photos.nonConforming, q.nonConforming));
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
        nonConforming: photos.nonConforming,
        isSerialPlate: photos.isSerialPlate,
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
