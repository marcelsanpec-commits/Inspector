import {
  badRequest,
  canReadJob,
  forbidden,
  notFound,
  type JobContext,
} from '../authz.js';
import { companyStaffOrgIds, type Principal } from '@inspectorone/shared';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { jobClientViewers, jobInspectors, jobs } from '../db/schema.js';

/**
 * Single entry point for "load this job, for this person".
 *
 * Every job-scoped route goes through here, so no handler has to remember the
 * access check. Returns 404 rather than 403 for out-of-scope jobs - see
 * `notFound` in authz.ts.
 */
export async function loadJobContext(principal: Principal, jobId: string) {
  const { db } = await getDb();

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw notFound('Job');

  const [assignment] = await db
    .select({ userId: jobInspectors.userId })
    .from(jobInspectors)
    .where(
      and(eq(jobInspectors.jobId, job.id), eq(jobInspectors.userId, principal.userId)),
    )
    .limit(1);

  const [namedViewer] = await db
    .select({ userId: jobClientViewers.userId })
    .from(jobClientViewers)
    .where(
      and(
        eq(jobClientViewers.jobId, job.id),
        eq(jobClientViewers.userId, principal.userId),
      ),
    )
    .limit(1);

  const ctx: JobContext = {
    id: job.id,
    companyOrgId: job.companyOrgId,
    clientOrgId: job.clientOrgId,
    status: job.status,
    clientAccess: job.clientAccess,
    isAssignedInspector: !!assignment,
    isNamedClientViewer: !!namedViewer,
  };

  if (!canReadJob(principal, ctx)) throw notFound('Job');

  return { job, ctx, db };
}

/**
 * Which inspecting company is this action for?
 *
 * Most people are staff at exactly one, so the client need not send it. Anyone
 * working for two firms must be explicit - silently picking one would file work
 * under the wrong company.
 */
export function resolveCompanyOrg(p: Principal, explicit?: string): string {
  const staffOrgs = companyStaffOrgIds(p);

  if (explicit) {
    if (!staffOrgs.includes(explicit)) {
      throw forbidden('You are not staff at that inspecting company');
    }
    return explicit;
  }

  if (staffOrgs.length === 1) return staffOrgs[0] as string;
  if (staffOrgs.length === 0) {
    throw forbidden('Only inspecting-company staff can do this');
  }
  throw badRequest(
    'You are staff at more than one inspecting company - include companyOrgId',
  );
}
