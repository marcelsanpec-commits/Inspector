/**
 * Roles and identity, shared by the API, all three portals, and the future
 * native app. The API is still the only thing that ENFORCES access; the
 * client-side copies exist to hide UI a person cannot use.
 */

export const ORG_TYPES = ['inspection_company', 'client'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'inspector', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const SIGNUP_ROLES = ['inspector', 'inspection_company', 'client'] as const;
export type SignupRole = (typeof SIGNUP_ROLES)[number];

export const JOB_STATUSES = [
  'draft',
  'scheduled',
  'in_progress',
  'submitted',
  'delivered',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const CLIENT_ACCESS_MODES = ['org_wide', 'restricted'] as const;
export type ClientAccessMode = (typeof CLIENT_ACCESS_MODES)[number];

export const PHOTO_STATUSES = ['pending', 'ready', 'failed'] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];

/**
 * The status from which a client can see a job at all.
 *
 * Deliberately a single named constant: clients seeing half-finished
 * inspections is a business decision, not a scattered condition. Change it in
 * one place if you decide clients should watch work in progress.
 */
export const CLIENT_VISIBLE_FROM: JobStatus = 'delivered';

export interface MembershipSummary {
  orgId: string;
  orgType: OrgType;
  orgName: string;
  orgSlug: string;
  role: MembershipRole;
}

/**
 * A person plus every org they belong to. Access is the union of what their
 * memberships permit - one account can inspect for two firms, or be an
 * inspector at one company and a client contact elsewhere, without a second
 * login.
 */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  accountId: string;
  signupRole: SignupRole;
  memberships: MembershipSummary[];
}

// --- Capability helpers -----------------------------------------------------

/** Company staff: can run the business inside an inspecting company. */
export function companyStaffOrgIds(p: Principal): string[] {
  return p.memberships
    .filter(
      (m) =>
        m.orgType === 'inspection_company' &&
        (m.role === 'owner' || m.role === 'admin'),
    )
    .map((m) => m.orgId);
}

/** Inspecting companies where this person does field work. */
export function inspectorOrgIds(p: Principal): string[] {
  return p.memberships
    .filter((m) => m.orgType === 'inspection_company' && m.role === 'inspector')
    .map((m) => m.orgId);
}

/** Client orgs this person belongs to, in any role. */
export function clientOrgIds(p: Principal): string[] {
  return p.memberships.filter((m) => m.orgType === 'client').map((m) => m.orgId);
}

/** Client orgs where this person can add or remove colleagues. */
export function clientAdminOrgIds(p: Principal): string[] {
  return p.memberships
    .filter(
      (m) => m.orgType === 'client' && (m.role === 'owner' || m.role === 'admin'),
    )
    .map((m) => m.orgId);
}

export function isCompanyStaff(p: Principal, orgId: string): boolean {
  return companyStaffOrgIds(p).includes(orgId);
}

export function isInspectorAt(p: Principal, orgId: string): boolean {
  return inspectorOrgIds(p).includes(orgId);
}

/** Anyone who can administer members of the given org, whatever its type. */
export function canManageMembers(p: Principal, orgId: string): boolean {
  return p.memberships.some(
    (m) => m.orgId === orgId && (m.role === 'owner' || m.role === 'admin'),
  );
}

/**
 * True when the person has no org yet - a freshly signed-up inspector waiting
 * to be added to a company. The UI shows them their account ID to hand over.
 */
export function isUnaffiliated(p: Principal): boolean {
  return p.memberships.length === 0;
}
