import {
  CLIENT_VISIBLE_FROM,
  clientOrgIds,
  companyStaffOrgIds,
  inspectorOrgIds,
  type Principal,
} from '@inspectorone/shared';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { jobs } from './db/schema.js';

/**
 * Authorization expressed as SQL predicates rather than post-fetch checks.
 *
 * Every read of job-scoped data composes `jobScope()` into its WHERE clause, so
 * a row the caller may not see is never loaded. That removes the "forgot to
 * check before returning" failure mode entirely - the bug class that would let
 * one client see another client's inspection photos.
 */

/** Matches nothing. Used wherever a caller structurally has no access. */
const DENY_ALL: SQL = sql`false`;

/**
 * The union of everything this person can see, across every org they belong to.
 * One account can inspect for two firms, or be an inspector at one company and
 * a client contact at another, and each membership contributes its own clause.
 */
export function jobScope(p: Principal): SQL {
  const clauses: SQL[] = [];

  // Company staff see every job in their own inspecting company.
  const staffOrgs = companyStaffOrgIds(p);
  if (staffOrgs.length) {
    clauses.push(inArray(jobs.companyOrgId, staffOrgs));
  }

  // Inspectors see only jobs they are actually assigned to.
  const inspectorOrgs = inspectorOrgIds(p);
  if (inspectorOrgs.length) {
    const assigned = and(
      inArray(jobs.companyOrgId, inspectorOrgs),
      sql`EXISTS (SELECT 1 FROM job_inspectors ji WHERE ji.job_id = ${jobs.id} AND ji.user_id = ${p.userId})`,
    );
    if (assigned) clauses.push(assigned);
  }

  // Client members see delivered work for their own org, org-wide unless that
  // job was narrowed to named people.
  const clientOrgs = clientOrgIds(p);
  if (clientOrgs.length) {
    const visible = and(
      inArray(jobs.clientOrgId, clientOrgs),
      eq(jobs.status, CLIENT_VISIBLE_FROM),
      or(
        eq(jobs.clientAccess, 'org_wide'),
        sql`EXISTS (SELECT 1 FROM job_client_viewers jcv WHERE jcv.job_id = ${jobs.id} AND jcv.user_id = ${p.userId})`,
      ),
    );
    if (visible) clauses.push(visible);
  }

  if (!clauses.length) return DENY_ALL;
  if (clauses.length === 1) return clauses[0] as SQL;
  return or(...clauses) ?? DENY_ALL;
}

/** Everything a route needs to decide access, resolved by the job loader. */
export interface JobContext {
  id: string;
  companyOrgId: string;
  clientOrgId: string;
  status: string;
  clientAccess: string;
  /** Whether THIS caller has a job_inspectors row. */
  isAssignedInspector: boolean;
  /** Whether THIS caller has a job_client_viewers row. */
  isNamedClientViewer: boolean;
}

export function canReadJob(p: Principal, job: JobContext): boolean {
  if (companyStaffOrgIds(p).includes(job.companyOrgId)) return true;

  if (inspectorOrgIds(p).includes(job.companyOrgId) && job.isAssignedInspector) {
    return true;
  }

  if (clientOrgIds(p).includes(job.clientOrgId)) {
    if (job.status !== CLIENT_VISIBLE_FROM) return false;
    return job.clientAccess === 'org_wide' || job.isNamedClientViewer;
  }

  return false;
}

/**
 * Field work is writable only while the job is open. Once submitted, an
 * inspector can no longer alter photos or notes - that boundary is what makes a
 * delivered report mean something.
 */
const INSPECTOR_WRITABLE = new Set(['draft', 'scheduled', 'in_progress']);

export function canWriteJobContent(p: Principal, job: JobContext): boolean {
  // Company staff can correct their own work up until it ships to the client.
  if (companyStaffOrgIds(p).includes(job.companyOrgId)) {
    return job.status !== 'delivered';
  }

  if (inspectorOrgIds(p).includes(job.companyOrgId)) {
    return job.isAssignedInspector && INSPECTOR_WRITABLE.has(job.status);
  }

  // The client portal is strictly read-only.
  return false;
}

/** Scheduling, assignment, and delivery are company-staff powers. */
export function canManageJob(p: Principal, job: JobContext): boolean {
  return companyStaffOrgIds(p).includes(job.companyOrgId);
}

export function canCreateJobFor(p: Principal, companyOrgId: string): boolean {
  return companyStaffOrgIds(p).includes(companyOrgId);
}

/** An inspector submits a job they worked; company staff may submit any. */
export function canSubmitJob(p: Principal, job: JobContext): boolean {
  if (companyStaffOrgIds(p).includes(job.companyOrgId)) return true;
  return (
    inspectorOrgIds(p).includes(job.companyOrgId) && job.isAssignedInspector
  );
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Deliberately 404 rather than 403 for rows outside the caller's scope.
 * Answering "that job exists but is not yours" leaks the existence of another
 * client's work, which is itself commercially sensitive.
 */
export function notFound(what = 'Resource'): HttpError {
  return new HttpError(404, 'not_found', `${what} not found`);
}

export function forbidden(message = 'Not permitted'): HttpError {
  return new HttpError(403, 'forbidden', message);
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, 'bad_request', message, details);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, 'conflict', message);
}
