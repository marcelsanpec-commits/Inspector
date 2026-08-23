import { z } from 'zod';
import {
  CLIENT_ACCESS_MODES,
  JOB_STATUSES,
  MEMBERSHIP_ROLES,
  SIGNUP_ROLES,
} from './roles.js';

/**
 * Request contracts shared by the API and every client. The API validates with
 * these and the portals reuse them for form validation, so the two cannot
 * drift. The native app will import this same file.
 */

export const uuid = z.string().uuid();

/**
 * Query-string booleans. NOT `z.coerce.boolean()` - that runs `Boolean(value)`,
 * and `Boolean("false")` is `true`, so a `?flag=false` filter would silently
 * match everything.
 */
export const booleanParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));
export const email = z.string().email().max(320).toLowerCase().trim();

/**
 * Long enough to matter, with no composition rules. Forced symbols push people
 * toward Password1! and a sticky note; length is what actually helps.
 */
export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200);

/** e.g. IO-7K3M9Q. Case-insensitive on input, normalised to upper. */
export const accountIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^IO-[23456789ABCDEFGHJKLMNPQRSTWXYZ]{6}$/, 'Not a valid account ID');

// --- Signup and login -------------------------------------------------------

export const signupSchema = z
  .object({
    email,
    password,
    name: z.string().min(1).max(120).trim(),
    role: z.enum(SIGNUP_ROLES),
    /**
     * Required when signing up as an inspecting company or a client, since both
     * create an organization. An inspector creates no org and waits to be
     * added, so they must not send one.
     */
    organizationName: z.string().min(1).max(160).trim().optional(),
  })
  .refine(
    (v) => v.role === 'inspector' || !!v.organizationName,
    {
      message: 'An organization name is required for companies and clients',
      path: ['organizationName'],
    },
  )
  .refine((v) => v.role !== 'inspector' || !v.organizationName, {
    message: 'Inspectors join an existing company rather than creating one',
    path: ['organizationName'],
  });
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

/** Signing up through an invite link joins the inviting org immediately. */
export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  password: password.optional(),
  name: z.string().min(1).max(120).trim().optional(),
});

// --- Org membership ---------------------------------------------------------

/** Add an existing account to your org by the ID they read off their screen. */
export const addMemberByAccountIdSchema = z.object({
  accountId: accountIdSchema,
  role: z.enum(MEMBERSHIP_ROLES),
});

export const inviteMemberSchema = z.object({
  email,
  role: z.enum(MEMBERSHIP_ROLES),
});

/** An inspecting company adding a client company that already has an account. */
export const addClientByAccountIdSchema = z.object({
  accountId: accountIdSchema,
});

/** An inspecting company inviting a client company that has no account yet. */
export const inviteClientSchema = z.object({
  email,
  organizationName: z.string().min(1).max(160).trim(),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(MEMBERSHIP_ROLES),
});

// --- Sites and objects ------------------------------------------------------

export const createSiteSchema = z.object({
  /** Optional when you are staff at exactly one inspecting company. */
  companyOrgId: uuid.optional(),
  clientOrgId: uuid,
  name: z.string().min(1).max(200).trim(),
  addressLine1: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

/**
 * "New Object" in the field. Objects persist on a site across jobs, so
 * submitting an existing serial number returns that object rather than
 * creating a duplicate - a typo-tolerant path matters when someone is typing
 * with gloves on.
 */
export const createObjectSchema = z.object({
  siteId: uuid,
  serialNumber: z.string().min(1).max(120).trim(),
  label: z.string().max(200).trim().optional(),
  objectType: z.string().max(120).trim().optional(),
  notes: z.string().max(5000).optional(),
  /** When present, the object is also attached to this job. */
  jobId: uuid.optional(),
});
export type CreateObjectInput = z.infer<typeof createObjectSchema>;

export const updateObjectSchema = z.object({
  label: z.string().max(200).trim().optional(),
  objectType: z.string().max(120).trim().optional(),
  notes: z.string().max(5000).optional(),
});

// --- Jobs -------------------------------------------------------------------

export const createJobSchema = z.object({
  /** Optional when you are staff at exactly one inspecting company. */
  companyOrgId: uuid.optional(),
  clientOrgId: uuid,
  siteId: uuid,
  title: z.string().min(1).max(200).trim(),
  scheduledFor: z.coerce.date().nullable().optional(),
  notes: z.string().max(5000).optional(),
  inspectorIds: z.array(uuid).max(20).default([]),
  clientAccess: z.enum(CLIENT_ACCESS_MODES).default('org_wide'),
  /** Only meaningful when clientAccess is 'restricted'. */
  clientViewerIds: z.array(uuid).max(50).default([]),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  scheduledFor: z.coerce.date().nullable().optional(),
  notes: z.string().max(5000).optional(),
  clientAccess: z.enum(CLIENT_ACCESS_MODES).optional(),
});

export const setJobInspectorsSchema = z.object({
  inspectorIds: z.array(uuid).max(20),
});

export const setJobClientViewersSchema = z.object({
  clientViewerIds: z.array(uuid).max(50),
});

export const listJobsQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  clientOrgId: uuid.optional(),
  siteId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Photos -----------------------------------------------------------------

/**
 * Step 1 of the upload handshake. The client has already resized, compressed,
 * and read EXIF off the image; it sends metadata only and gets back a URL it
 * PUTs the bytes to directly. The API never touches image data.
 */
export const requestPhotoUploadSchema = z.object({
  jobId: uuid,
  objectId: uuid.nullable().optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** Byte length of the COMPRESSED file about to be sent. */
  byteSize: z
    .number()
    .int()
    .positive()
    .max(15 * 1024 * 1024, 'Compress before uploading - 15MB hard ceiling'),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Original capture time from EXIF, not upload time. */
  takenAt: z.coerce.date().nullable().optional(),
  gpsLat: z.number().min(-90).max(90).nullable().optional(),
  gpsLng: z.number().min(-180).max(180).nullable().optional(),
  caption: z.string().max(1000).optional(),
  voiceNote: z.string().max(10000).optional(),
  voiceNoteIsDictated: z.boolean().default(false),
  includeInReport: z.boolean().default(true),
  /**
   * Client-generated and stable across retries. Lets an inspector who loses
   * signal mid-upload retry without creating a duplicate photo.
   */
  clientRef: z.string().min(1).max(100).optional(),
});
export type RequestPhotoUploadInput = z.infer<typeof requestPhotoUploadSchema>;

export const confirmPhotoUploadSchema = z.object({ photoId: uuid });

/** Everything about a photo an inspector can change after the fact. */
export const updatePhotoSchema = z.object({
  caption: z.string().max(1000).nullable().optional(),
  voiceNote: z.string().max(10000).nullable().optional(),
  voiceNoteIsDictated: z.boolean().optional(),
  includeInReport: z.boolean().optional(),
  objectId: uuid.nullable().optional(),
});

/** The gallery: everything ever shot, filterable the four ways you asked for. */
export const galleryQuerySchema = z.object({
  jobId: uuid.optional(),
  siteId: uuid.optional(),
  objectId: uuid.optional(),
  clientOrgId: uuid.optional(),
  /** ISO dates, inclusive, matched against capture time. */
  takenFrom: z.coerce.date().optional(),
  takenTo: z.coerce.date().optional(),
  includeInReport: booleanParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Errors -----------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
