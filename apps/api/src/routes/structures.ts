import {
  createStructureSchema,
  updateStructureSchema,
  uuid,
} from '@inspectorone/shared';
import { and, asc, count, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/index.js';
import { canWriteJobContent, forbidden, HttpError, notFound } from '../authz.js';
import type { Db } from '../db/client.js';
import { jobObjects, objects, photos, type Photo } from '../db/schema.js';
import { loadJobContext } from '../lib/job-context.js';
import { getStorage, type StorageAdapter } from '../storage/index.js';

/**
 * Structures: the unit an inspection is organised by.
 *
 * "New Structure" in the field photographs the ID plate, records the serial
 * and what the thing is, and from then on every photo and comment for it files
 * under that one structure. A structure is a persistent object (serial, type -
 * true of the thing forever) seen through one job (comments, finished or not -
 * true of this inspection only), which is exactly the objects / job_objects
 * split the schema already had. Re-inspecting a serial next year therefore
 * links to the same object and its history.
 *
 * Every route here loads the job through `loadJobContext`, and every structure
 * query is constrained to that job's id, so the job scope covers structures
 * too - a structure on a job you cannot see is a 404 like the job itself.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

const CLOSED = 'This inspection is no longer open for changes';

function structureIdParam(value: string): string {
  // A malformed id is simply a structure that does not exist - not a 500 from
  // Postgres refusing to cast it.
  if (!uuid.safeParse(value).success) throw notFound('Structure');
  return value;
}

function alreadyInInspection(serialNumber: string, structureId: string | undefined) {
  return new HttpError(
    409,
    'structure_exists',
    `${serialNumber} is already a structure in this inspection`,
    { structureId },
  );
}

/** One row per structure, with the counts the inspection screen shows. */
function loadStructures(db: Executor, jobId: string, structureId?: string) {
  return db
    .select({
      id: jobObjects.id,
      objectId: objects.id,
      serialNumber: objects.serialNumber,
      structureType: objects.objectType,
      label: objects.label,
      comments: jobObjects.notes,
      position: jobObjects.position,
      finishedAt: jobObjects.finishedAt,
      createdAt: jobObjects.createdAt,
      updatedAt: jobObjects.updatedAt,
      photoCount: sql<number>`count(${photos.id})::int`,
      includedCount: sql<number>`(count(${photos.id}) filter (where ${photos.includeInReport}))::int`,
      nonConformingCount: sql<number>`(count(${photos.id}) filter (where ${photos.nonConforming}))::int`,
    })
    .from(jobObjects)
    .innerJoin(objects, eq(jobObjects.objectId, objects.id))
    .leftJoin(
      photos,
      and(
        eq(photos.jobId, jobObjects.jobId),
        eq(photos.objectId, jobObjects.objectId),
        eq(photos.status, 'ready'),
      ),
    )
    .where(
      structureId
        ? and(eq(jobObjects.jobId, jobId), eq(jobObjects.id, structureId))
        : eq(jobObjects.jobId, jobId),
    )
    .groupBy(jobObjects.id, objects.id)
    .orderBy(asc(jobObjects.position), asc(jobObjects.createdAt));
}

type StructureRow = Awaited<ReturnType<typeof loadStructures>>[number];

interface Cover {
  photoId: string;
  url: string;
  isSerialPlate: boolean;
}

/**
 * Each structure's thumbnail: its serial plate photo, or - when the plate was
 * skipped because there was none to photograph - its first photo, so the tile
 * is never blank while the structure has any pictures at all.
 */
async function loadCovers(db: Executor, jobId: string, storage: StorageAdapter) {
  const rows = await db
    .selectDistinctOn([photos.objectId], {
      objectId: photos.objectId,
      photoId: photos.id,
      storageKey: photos.storageKey,
      isSerialPlate: photos.isSerialPlate,
    })
    .from(photos)
    .where(and(eq(photos.jobId, jobId), eq(photos.status, 'ready'), isNotNull(photos.objectId)))
    .orderBy(photos.objectId, desc(photos.isSerialPlate), asc(photos.takenAt), asc(photos.createdAt));

  const covers = new Map<string, Cover>();
  await Promise.all(
    rows.map(async (r) => {
      if (!r.objectId) return;
      covers.set(r.objectId, {
        photoId: r.photoId,
        url: await storage.createDownloadUrl({ key: r.storageKey }),
        isSerialPlate: r.isSerialPlate,
      });
    }),
  );
  return covers;
}

function toStructure(row: StructureRow, cover: Cover | null | undefined) {
  return { ...row, cover: cover ?? null };
}

/** What a photo looks like to the inspection screens - no storage internals. */
function photoView(row: Photo, url: string) {
  return {
    id: row.id,
    url,
    width: row.width,
    height: row.height,
    caption: row.caption,
    voiceNote: row.voiceNote,
    includeInReport: row.includeInReport,
    nonConforming: row.nonConforming,
    isSerialPlate: row.isSerialPlate,
    takenAt: row.takenAt,
    gpsLat: row.gpsLat,
    gpsLng: row.gpsLng,
    createdAt: row.createdAt,
  };
}

/**
 * What this company has called its structures before - "Anchor bolt cage",
 * "Pole section" - offered as suggestions so the same kind of thing gets the
 * same name every time. Only for people who can write: a client reading a
 * delivered job has no business seeing the vocabulary of other clients' work.
 */
async function structureTypeSuggestions(db: Executor, companyOrgId: string) {
  const rows = await db
    .select({ type: objects.objectType })
    .from(objects)
    .where(and(eq(objects.companyOrgId, companyOrgId), isNotNull(objects.objectType)))
    .groupBy(objects.objectType)
    .orderBy(desc(count()), asc(objects.objectType))
    .limit(40);
  return rows.map((r) => r.type).filter((t): t is string => !!t);
}

async function findObjectBySerial(db: Executor, siteId: string, serialNumber: string) {
  const [row] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.siteId, siteId), eq(objects.serialNumber, serialNumber)))
    .limit(1);
  return row ?? null;
}

/** Insert-or-fetch, so two inspectors entering one new serial at once share it. */
async function createObjectIfMissing(
  db: Executor,
  values: typeof objects.$inferInsert,
) {
  const [created] = await db
    .insert(objects)
    .values(values)
    .onConflictDoNothing({ target: [objects.siteId, objects.serialNumber] })
    .returning();
  if (created) return created;

  const existing = await findObjectBySerial(db, values.siteId, values.serialNumber);
  if (!existing) throw new Error('Object conflict without an existing row');
  return existing;
}

/**
 * Removes an object nothing refers to any more - in practice, the record a
 * mistyped serial created minutes earlier. An object with history on another
 * job, or photos anywhere, is left alone.
 */
async function deleteObjectIfOrphaned(db: Executor, objectId: string) {
  await db
    .delete(objects)
    .where(
      and(
        eq(objects.id, objectId),
        sql`NOT EXISTS (SELECT 1 FROM job_objects jo WHERE jo.object_id = ${objectId})`,
        sql`NOT EXISTS (SELECT 1 FROM photos ph WHERE ph.object_id = ${objectId})`,
      ),
    );
}

async function loadCurrent(db: Executor, jobId: string, structureId: string) {
  const [row] = await db
    .select({
      id: jobObjects.id,
      objectId: jobObjects.objectId,
      finishedAt: jobObjects.finishedAt,
      serialNumber: objects.serialNumber,
      objectType: objects.objectType,
      label: objects.label,
    })
    .from(jobObjects)
    .innerJoin(objects, eq(jobObjects.objectId, objects.id))
    .where(and(eq(jobObjects.id, structureId), eq(jobObjects.jobId, jobId)))
    .limit(1);
  if (!row) throw notFound('Structure');
  return row;
}

export async function structureRoutes(app: FastifyInstance) {
  /** The inspection screen: every structure on the job, as tiles. */
  app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId/structures', async (req) => {
    const p = requirePrincipal(req);
    const { job, ctx, db } = await loadJobContext(p, req.params.jobId);
    const storage = await getStorage();
    const canWriteContent = canWriteJobContent(p, ctx);

    const [rows, covers, structureTypes] = await Promise.all([
      loadStructures(db, job.id),
      loadCovers(db, job.id, storage),
      canWriteContent ? structureTypeSuggestions(db, job.companyOrgId) : [],
    ]);

    return {
      structures: rows.map((r) => toStructure(r, covers.get(r.objectId))),
      structureTypes,
      permissions: { canWriteContent },
    };
  });

  /** One structure with every photo of it on this job, plate first. */
  app.get<{ Params: { jobId: string; structureId: string } }>(
    '/api/jobs/:jobId/structures/:structureId',
    async (req) => {
      const p = requirePrincipal(req);
      const { job, ctx, db } = await loadJobContext(p, req.params.jobId);
      const structureId = structureIdParam(req.params.structureId);
      const storage = await getStorage();
      const canWriteContent = canWriteJobContent(p, ctx);

      const [row] = await loadStructures(db, job.id, structureId);
      if (!row) throw notFound('Structure');

      const photoRows = await db
        .select()
        .from(photos)
        .where(
          and(
            eq(photos.jobId, job.id),
            eq(photos.objectId, row.objectId),
            eq(photos.status, 'ready'),
          ),
        )
        // Plate first, then the order things were photographed - which is the
        // order they will appear under this structure in the report.
        .orderBy(desc(photos.isSerialPlate), asc(photos.takenAt), asc(photos.createdAt));

      const photoList = await Promise.all(
        photoRows.map(async (ph) =>
          photoView(ph, await storage.createDownloadUrl({ key: ph.storageKey })),
        ),
      );
      const first = photoList[0];

      return {
        structure: toStructure(
          row,
          first ? { photoId: first.id, url: first.url, isSerialPlate: first.isSerialPlate } : null,
        ),
        photos: photoList,
        structureTypes: canWriteContent
          ? await structureTypeSuggestions(db, job.companyOrgId)
          : [],
        permissions: { canWriteContent },
      };
    },
  );

  /**
   * "New Structure".
   *
   * A serial this site already knows links to that object, so its history
   * carries over; one already on THIS job is a 409 carrying the existing
   * structure's id, so the app can offer to open it instead of duplicating it.
   * The plate photo follows as an ordinary upload with `serialPlate: true`.
   */
  app.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/structures',
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { job, ctx, db } = await loadJobContext(p, req.params.jobId);
      if (!canWriteJobContent(p, ctx)) throw forbidden(CLOSED);
      const body = createStructureSchema.parse(req.body);

      const existing = await findObjectBySerial(db, job.siteId, body.serialNumber);
      if (existing) {
        const [linked] = await db
          .select({ id: jobObjects.id })
          .from(jobObjects)
          .where(and(eq(jobObjects.jobId, job.id), eq(jobObjects.objectId, existing.id)))
          .limit(1);
        if (linked) throw alreadyInInspection(body.serialNumber, linked.id);
      }

      const structureId = await db.transaction(async (tx) => {
        let objectId: string;
        if (existing) {
          // The inspector is standing in front of it, so what they call it now
          // wins over whatever an earlier inspection recorded.
          if (existing.objectType !== body.structureType) {
            await tx
              .update(objects)
              .set({ objectType: body.structureType, updatedAt: new Date() })
              .where(eq(objects.id, existing.id));
          }
          objectId = existing.id;
        } else {
          const created = await createObjectIfMissing(tx, {
            companyOrgId: job.companyOrgId,
            siteId: job.siteId,
            serialNumber: body.serialNumber,
            objectType: body.structureType,
            createdBy: p.userId,
          });
          objectId = created.id;
        }

        const [pos] = await tx
          .select({ next: sql<number>`(coalesce(max(${jobObjects.position}) + 1, 0))::int` })
          .from(jobObjects)
          .where(eq(jobObjects.jobId, job.id));

        const [row] = await tx
          .insert(jobObjects)
          .values({
            jobId: job.id,
            objectId,
            position: pos?.next ?? 0,
            notes: body.comments?.trim() ? body.comments : null,
            createdBy: p.userId,
          })
          .onConflictDoNothing()
          .returning({ id: jobObjects.id });

        if (!row) {
          // Someone else on this job added the same serial a moment ago.
          const [linked] = await tx
            .select({ id: jobObjects.id })
            .from(jobObjects)
            .where(and(eq(jobObjects.jobId, job.id), eq(jobObjects.objectId, objectId)))
            .limit(1);
          throw alreadyInInspection(body.serialNumber, linked?.id);
        }
        return row.id;
      });

      const [row] = await loadStructures(db, job.id, structureId);
      reply.code(201);
      return { structure: toStructure(row!, null), reusedObject: !!existing };
    },
  );

  /**
   * Edit a structure: correct the serial or the type, update the comments, or
   * finish (or reopen) it.
   */
  app.patch<{ Params: { jobId: string; structureId: string } }>(
    '/api/jobs/:jobId/structures/:structureId',
    async (req) => {
      const p = requirePrincipal(req);
      const { job, ctx, db } = await loadJobContext(p, req.params.jobId);
      const structureId = structureIdParam(req.params.structureId);
      const current = await loadCurrent(db, job.id, structureId);
      if (!canWriteJobContent(p, ctx)) throw forbidden(CLOSED);
      const body = updateStructureSchema.parse(req.body);

      await db.transaction(async (tx) => {
        let objectId = current.objectId;

        /**
         * A serial is identity, not a label. Correcting it re-points THIS
         * inspection's structure (and its photos) at the object that really
         * carries that serial, instead of renaming the old object - which
         * would rewrite the history of every other job that inspected it.
         */
        if (body.serialNumber !== undefined && body.serialNumber !== current.serialNumber) {
          const target = await findObjectBySerial(tx, job.siteId, body.serialNumber);
          if (target) {
            const [clash] = await tx
              .select({ id: jobObjects.id })
              .from(jobObjects)
              .where(and(eq(jobObjects.jobId, job.id), eq(jobObjects.objectId, target.id)))
              .limit(1);
            if (clash) throw alreadyInInspection(body.serialNumber, clash.id);
          }

          const next =
            target ??
            (await createObjectIfMissing(tx, {
              companyOrgId: job.companyOrgId,
              siteId: job.siteId,
              serialNumber: body.serialNumber,
              objectType: body.structureType ?? current.objectType,
              label: current.label,
              createdBy: p.userId,
            }));

          await tx
            .update(jobObjects)
            .set({ objectId: next.id, updatedAt: new Date() })
            .where(eq(jobObjects.id, current.id));
          await tx
            .update(photos)
            .set({ objectId: next.id, updatedAt: new Date() })
            .where(and(eq(photos.jobId, job.id), eq(photos.objectId, current.objectId)));
          await deleteObjectIfOrphaned(tx, current.objectId);
          objectId = next.id;
        }

        if (body.structureType !== undefined) {
          await tx
            .update(objects)
            .set({ objectType: body.structureType, updatedAt: new Date() })
            .where(eq(objects.id, objectId));
        }

        await tx
          .update(jobObjects)
          .set({
            ...(body.comments !== undefined
              ? { notes: body.comments?.trim() ? body.comments : null }
              : {}),
            ...(body.finished !== undefined
              ? { finishedAt: body.finished ? (current.finishedAt ?? new Date()) : null }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(jobObjects.id, current.id));
      });

      const storage = await getStorage();
      const [row] = await loadStructures(db, job.id, current.id);
      const covers = await loadCovers(db, job.id, storage);
      return { structure: toStructure(row!, covers.get(row!.objectId)) };
    },
  );

  /**
   * Removes a structure from this inspection along with every photo taken of
   * it on this job. The object itself survives if any other job has seen it.
   */
  app.delete<{ Params: { jobId: string; structureId: string } }>(
    '/api/jobs/:jobId/structures/:structureId',
    async (req) => {
      const p = requirePrincipal(req);
      const { job, ctx, db } = await loadJobContext(p, req.params.jobId);
      const structureId = structureIdParam(req.params.structureId);
      const current = await loadCurrent(db, job.id, structureId);
      if (!canWriteJobContent(p, ctx)) throw forbidden(CLOSED);

      const removed = await db.transaction(async (tx) => {
        const gone = await tx
          .delete(photos)
          .where(and(eq(photos.jobId, job.id), eq(photos.objectId, current.objectId)))
          .returning({ storageKey: photos.storageKey });
        await tx.delete(jobObjects).where(eq(jobObjects.id, current.id));
        await deleteObjectIfOrphaned(tx, current.objectId);
        return gone;
      });

      // Rows first, bytes second: a failure here strands an unreferenced file,
      // never a photo row pointing at nothing.
      const storage = await getStorage();
      for (const { storageKey } of removed) {
        await storage.deleteObject(storageKey).catch((err: unknown) => {
          req.log.warn({ err, storageKey }, 'Could not delete photo of removed structure');
        });
      }

      return { deleted: true, photosDeleted: removed.length };
    },
  );
}
