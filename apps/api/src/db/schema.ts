import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tenancy model
 * -------------
 * An `organization` is either an inspecting company or a client company. Both
 * kinds have multiple human members, which is why a client is an org and not a
 * contact row - "5 people in charge of inspection reports" all need logins.
 *
 * A `user` is a person, with a unique `accountId` they can read off a screen so
 * an inspecting company can add them by ID. Users join orgs through
 * `memberships`, so one person can belong to more than one org (a contractor
 * inspecting for two firms) without duplicate accounts.
 */

export const orgType = pgEnum('org_type', ['inspection_company', 'client']);

/**
 * Role WITHIN an org, not globally.
 *  inspection_company: owner/admin run the business; inspector does field work
 *  client:             owner/admin can add colleagues; member is view-only
 */
export const membershipRole = pgEnum('membership_role', [
  'owner',
  'admin',
  'inspector',
  'member',
]);

/** What the person chose on the signup screen. Drives onboarding, not access. */
export const signupRole = pgEnum('signup_role', [
  'inspector',
  'inspection_company',
  'client',
]);

export const jobStatus = pgEnum('job_status', [
  'draft',
  'scheduled',
  'in_progress',
  'submitted',
  'delivered',
]);

/** Whether the whole client org sees a job, or only named people. */
export const clientAccess = pgEnum('client_access', ['org_wide', 'restricted']);

export const photoStatus = pgEnum('photo_status', ['pending', 'ready', 'failed']);

export const reportStatus = pgEnum('report_status', [
  'pending',
  'generating',
  'ready',
  'failed',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// --- Identity ---------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: orgType('type').notNull(),
    name: text('name').notNull(),
    /** Short human-readable handle, also usable when adding an org by ID. */
    slug: text('slug').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('organizations_slug_unique').on(t.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** scrypt, encoded with its parameters and salt. Never a bare digest. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    /**
     * Short, unambiguous, human-transcribable id (e.g. IO-7K3M9Q). This is what
     * an inspecting company types to add someone to their roster, so it avoids
     * characters people confuse: no O/0, I/1, or U/V.
     */
    accountId: text('account_id').notNull(),
    signupRole: signupRole('signup_role').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_account_id_unique').on(t.accountId),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('memberships_user_org_unique').on(t.userId, t.orgId),
    index('memberships_org_idx').on(t.orgId),
  ],
);

/**
 * Which client orgs an inspecting company works for. Separate from `jobs` so a
 * company can add a client to their roster before any work exists, and so a
 * client org could in principle be served by two different firms.
 */
export const clientRelationships = pgTable(
  'client_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyOrgId: uuid('company_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clientOrgId: uuid('client_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('client_rel_unique').on(t.companyOrgId, t.clientOrgId),
    index('client_rel_company_idx').on(t.companyOrgId),
  ],
);

/** Email-invite path. The account-ID path needs no row - it links immediately. */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: membershipRole('role').notNull(),
    /**
     * SHA-256 of the token. The raw token exists only in the emailed link, so a
     * database leak cannot be replayed into account access.
     */
    tokenHash: text('token_hash').notNull(),
    /**
     * Set when an inspecting company invites a NEW client company: accepting
     * creates that client org and makes the invitee its owner.
     */
    createsClientOrgName: text('creates_client_org_name'),
    /** The inspecting company that issued a client invite, for auto-linking. */
    linkToCompanyOrgId: uuid('link_to_company_org_id').references(
      () => organizations.id,
      { onDelete: 'cascade' },
    ),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invites_token_unique').on(t.tokenHash),
    index('invites_org_idx').on(t.orgId),
    index('invites_email_idx').on(t.email),
  ],
);

/** Opaque server-side sessions - revocable, unlike a stateless JWT. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_token_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

// --- Work -------------------------------------------------------------------

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyOrgId: uuid('company_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clientOrgId: uuid('client_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    ...timestamps,
  },
  (t) => [
    index('sites_company_idx').on(t.companyOrgId),
    index('sites_client_idx').on(t.clientOrgId),
  ],
);

/**
 * A serial-numbered asset that LIVES on a jobsite and is re-inspected over
 * time. Because objects persist between jobs, you can pull up everything ever
 * photographed for a given serial number - which is the point of recording
 * serials at all. Uniqueness is per site, so two sites may hold identically
 * numbered equipment without colliding.
 */
export const objects = pgTable(
  'objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyOrgId: uuid('company_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    serialNumber: text('serial_number').notNull(),
    /** Optional friendly name - "Rooftop AHU-3" alongside the serial. */
    label: text('label'),
    objectType: text('object_type'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('objects_site_serial_unique').on(t.siteId, t.serialNumber),
    index('objects_site_idx').on(t.siteId),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyOrgId: uuid('company_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clientOrgId: uuid('client_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    jobNumber: text('job_number').notNull(),
    title: text('title').notNull(),
    status: jobStatus('status').notNull().default('draft'),
    /** org_wide by default; restricted narrows to jobClientViewers. */
    clientAccess: clientAccess('client_access').notNull().default('org_wide'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('jobs_company_number_unique').on(t.companyOrgId, t.jobNumber),
    index('jobs_company_status_idx').on(t.companyOrgId, t.status),
    index('jobs_client_idx').on(t.clientOrgId),
    index('jobs_site_idx').on(t.siteId),
  ],
);

/** Many-to-many: a job can carry more than one inspector. */
export const jobInspectors = pgTable(
  'job_inspectors',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.userId] }),
    index('job_inspectors_user_idx').on(t.userId),
  ],
);

/** Only consulted when jobs.clientAccess = 'restricted'. */
export const jobClientViewers = pgTable(
  'job_client_viewers',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.userId] }),
    index('job_client_viewers_user_idx').on(t.userId),
  ],
);

/** Which persistent objects were actually worked during a given job. */
export const jobObjects = pgTable(
  'job_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('job_objects_unique').on(t.jobId, t.objectId),
    index('job_objects_job_idx').on(t.jobId, t.position),
  ],
);

export const photos = pgTable(
  'photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyOrgId: uuid('company_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Nullable so a shot can be taken before the object is chosen. */
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'set null' }),

    /** Bytes live in R2 or on local disk - never in Postgres. */
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width'),
    height: integer('height'),

    /**
     * Capture time and location read from EXIF before the client strips it.
     * "Photographed at this spot, at this time" is what makes an inspection
     * record defensible, and naive resizing destroys it.
     */
    takenAt: timestamp('taken_at', { withTimezone: true }),
    gpsLat: doublePrecision('gps_lat'),
    gpsLng: doublePrecision('gps_lng'),

    caption: text('caption'),
    /** Dictated on-device via the Web Speech API, always editable afterwards. */
    voiceNote: text('voice_note'),
    /** Whether the inspector dictated this note or typed it. */
    voiceNoteIsDictated: boolean('voice_note_is_dictated').notNull().default(false),

    /**
     * The inspector's include/exclude toggle. Not all photos reach the report,
     * but every photo stays browsable in the gallery - which is exactly why the
     * gallery is separate from the report.
     */
    includeInReport: boolean('include_in_report').notNull().default(true),

    status: photoStatus('status').notNull().default('pending'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    /** Stable across retries, so a dropped signal cannot duplicate a photo. */
    clientRef: text('client_ref'),
    ...timestamps,
  },
  (t) => [
    index('photos_job_idx').on(t.jobId),
    index('photos_object_idx').on(t.objectId),
    index('photos_company_taken_idx').on(t.companyOrgId, t.takenAt),
    index('photos_report_idx').on(t.jobId, t.includeInReport),
    uniqueIndex('photos_job_client_ref_unique').on(t.jobId, t.clientRef),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyOrgId: uuid('company_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Template key - one built-in for now, custom templates later. */
    templateKey: text('template_key').notNull().default('standard'),
    status: reportStatus('status').notNull().default('pending'),
    storageKey: text('storage_key'),
    version: integer('version').notNull().default(1),
    error: text('error'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    generatedBy: uuid('generated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('reports_job_idx').on(t.jobId),
    uniqueIndex('reports_job_version_unique').on(t.jobId, t.version),
  ],
);

// --- Relations --------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  sites: many(sites),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  org: one(organizations, {
    fields: [memberships.orgId],
    references: [organizations.id],
  }),
}));

export const sitesRelations = relations(sites, ({ one, many }) => ({
  company: one(organizations, {
    fields: [sites.companyOrgId],
    references: [organizations.id],
  }),
  objects: many(objects),
  jobs: many(jobs),
}));

export const objectsRelations = relations(objects, ({ one, many }) => ({
  site: one(sites, { fields: [objects.siteId], references: [sites.id] }),
  photos: many(photos),
  jobObjects: many(jobObjects),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  site: one(sites, { fields: [jobs.siteId], references: [sites.id] }),
  inspectors: many(jobInspectors),
  clientViewers: many(jobClientViewers),
  objects: many(jobObjects),
  photos: many(photos),
  reports: many(reports),
}));

export const jobInspectorsRelations = relations(jobInspectors, ({ one }) => ({
  job: one(jobs, { fields: [jobInspectors.jobId], references: [jobs.id] }),
  user: one(users, { fields: [jobInspectors.userId], references: [users.id] }),
}));

export const jobObjectsRelations = relations(jobObjects, ({ one }) => ({
  job: one(jobs, { fields: [jobObjects.jobId], references: [jobs.id] }),
  object: one(objects, { fields: [jobObjects.objectId], references: [objects.id] }),
}));

export const photosRelations = relations(photos, ({ one }) => ({
  job: one(jobs, { fields: [photos.jobId], references: [jobs.id] }),
  object: one(objects, { fields: [photos.objectId], references: [objects.id] }),
}));

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type InspectionObject = typeof objects.$inferSelect;
export type Photo = typeof photos.$inferSelect;
