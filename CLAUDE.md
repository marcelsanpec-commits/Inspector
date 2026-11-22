# InspectorOne

Field inspection platform for an engineering business. Three perspectives —
**inspecting company**, **inspector**, **client** — in one app.

Owner: Marcel (marcel.sanpec@gmail.com). Not a professional developer; explain
terminal steps concretely and say plainly what to type versus what to just look
at. Run git/npm commands rather than handing them over, except anything needing
a browser sign-in.

## Commands

```bash
npm install       # also builds @inspectorone/shared
npm run seed      # migrate + demo data (see the guard below)
npm run dev       # API on :3000, app on :5173 (see gotcha 9 first)
npm test          # 98 API tests
npm run typecheck # all three workspaces
npm run build     # shared -> api -> web
npm run storage:check  # real upload round trip against the configured storage
```

## Layout

```
packages/shared     types + Zod schemas, used by API and web (and a future native app)
apps/api            Fastify + Drizzle + Postgres
  src/authz.ts      authorization as SQL predicates
  src/db/           schema, migrations, seed
  src/storage/      StorageAdapter: local | s3
  src/auth/         sessions (scrypt + opaque tokens)
  src/lib/          password, ids, email, job-context
apps/web            React + Vite, one app with role-aware routing
```

## Model

- **Organization** is either `inspection_company` or `client`. Both have many
  members — a client is an org, not a contact row, because several people at a
  client need logins.
- **User** is a person with a short account ID (`IO-7K3M9Q`). The alphabet omits
  `0/1/I/O/U/V` because it gets read aloud in a parking lot. Users join orgs via
  **memberships**, so one account can inspect for two firms.
- **Object** is a serial-numbered asset that lives on a **site** and persists
  across jobs. Re-entering a known serial returns the existing object rather
  than duplicating — that's what makes per-serial history work.
- **Job** links company + client org + site, with many inspectors.
- **Structure** is what the inspection screens call an object as worked on one
  job: a `job_objects` row (comments in `notes`, `finished_at`) joined to its
  object (serial, `object_type`). Routes in `src/routes/structures.ts`, nested
  under the job so `loadJobContext` scopes them. Correcting a serial re-points
  the structure to the right object rather than renaming the old one.
- **Photos** carry `non_conforming` (a finding) and `is_serial_plate` (the
  structure's ID-plate photo and tile thumbnail; a new one replaces the old on
  confirm).

### Who sees what

| Role | Access |
|---|---|
| Company owner/admin | Everything in their company |
| Inspector | Only assigned jobs; writable while open |
| Client member | Only **delivered** jobs for their org; read-only |

Client access is org-wide by default, restrictable to named people per job.

## Conventions worth keeping

- **Authorization is SQL predicates** (`jobScope` in `src/authz.ts`) composed
  into every job-scoped query, so an out-of-scope row is never loaded. Don't
  replace this with post-fetch checks.
- **Out-of-scope rows return 404, not 403.** A 403 confirms another client's job
  exists.
- **Drivers behind interfaces** for storage, email, and database, so local
  development needs no accounts. Keep new external services to this shape.
- **Comments explain why, not what.** Several in the codebase record decisions
  (EXIF read before resize, idempotent `clientRef`, the ID alphabet).
- `CLIENT_VISIBLE_FROM` in shared/roles.ts is the single constant controlling
  when clients can see a job. Currently `delivered`.
- **Every photo is 4:3, either orientation** — the frame of the owner's report
  examples. `PHOTO_ASPECT_LONG/SHORT` in shared/photos.ts; the web crops with
  `reportPhotoCrop`, the API rejects other shapes (`isReportAspect`).
- **Non-conforming implies included in the report**, enforced three times: the
  UI locks the toggle, the API refuses it, and the `photos_non_conforming_in_report`
  check constraint backs both. Keep all three.

## Deployment

Render, auto-deploys on push to `main`.

| Service | URL |
|---|---|
| API (`inspector-qp70`) | https://inspector-qp70.onrender.com |
| App (`inspectorone-web`) | https://inspectorone-web.onrender.com |

Database is Neon Postgres. `render.yaml` describes both services, but the
services were created by hand in the dashboard, so **dashboard settings win** —
changing `render.yaml` alone does not change the live build.

## Gotchas that have already bitten

1. **`.gitignore` patterns need a leading slash.** A bare `storage/` matched
   `apps/api/src/storage/` and silently kept four source files out of the repo.
   Root-only patterns are `/storage/` and `/.data/`.
2. **`NODE_ENV=production` makes npm skip devDependencies**, including
   TypeScript. Build commands must pass `npm ci --include=dev`.
3. **`VITE_API_URL` is baked in at build time.** Changing it needs a rebuild,
   not just a save.
4. **CORS**: the API's `CORS_ORIGINS` must exactly match the web URL —
   `https://`, no trailing slash.
5. **Seeding wipes the database first.** Against a configured `DATABASE_URL`
   holding accounts it now refuses unless `--force`. Don't remove that guard.
6. **Photos are still on `STORAGE_DRIVER=local` in production**, so uploads are
   deleted on every deploy. The R2 code is ready; the owner needs to create the
   bucket, CORS policy, and keys (README, "Photo storage (R2)").
7. **Zod can load twice on Windows.** A terminal whose working directory starts
   `c:\` (VS Code's does) loads zod as `file:///c:/...` for the API but as
   `file:///C:/...` through the `@inspectorone/shared` symlink, so
   `instanceof ZodError` fails and bad requests became 500s - in some terminals
   only. `isZodError` in app.ts checks the shape too. Don't revert it.
8. **The AWS SDK (3.729+) puts an empty-body CRC32 in presigned upload URLs**,
   so every real upload would fail its checksum on R2. `s3.ts` sets
   `requestChecksumCalculation: 'WHEN_REQUIRED'`. Don't remove it.
9. **`.env.local` holds the production `DATABASE_URL`.** Anything that boots
   the API from this machine - `npm run dev`, `db:migrate` - runs migrations
   against live Neon. For local work, override it to empty (bash:
   `DATABASE_URL= npm run dev`), which falls back to PGlite. Tests already
   ignore it.

## Status

**Done:** schema (14 tables), signup/login/sessions, invites by email and by
account ID, roster management for companies and clients, sites, persistent
objects, jobs with multi-inspector assignment and restrictable client access,
photo upload handshake (direct to storage, EXIF + GPS preserved), on-device
dictation, include-in-report toggle, gallery with filters, per-object history,
and the web app for all three roles. The inspection flow: Start Inspection,
New Structure from a serial plate photo, camera with 4:3 framing,
non-conforming findings, auto-saving dictated comments, Finish Structure,
structure tiles, edit/remove/serial correction. R2-ready storage. 98 tests.

**Next, in order:**
1. Cloudflare R2 — code done; waiting on the owner's bucket and keys
2. Report template and PDF generation (owner wants one fixed template first,
   custom templates later — ask for their actual template, don't invent one).
   The model is "Inspection Report - LADWP MCC-VIC - Anchor Bolt Cages - NUCOR
   at Madden Bolt", which has NOT been received yet - ask for it. Two other
   examples were shared (Boardman to Hemingway field report; TFI LADWP
   witnessing report) and share one Sanpec layout: logo + Tomball, TX address
   header; title and dates; a GENERAL table (project, report title, spec #,
   file name, supplier, date, fabricator/shop, # of inspectors, location,
   report by, references); FINDINGS major/minor/none, ACTION REQUIRED
   project/supplier/other, DISCUSSION NEEDED yes/no; Inspection Purpose;
   per-structure sections (bold ID line, text, 4:3 photos 2-3 across, the ID
   plate first); Conclusion; "Page X of Y" footer.
3. Offline capture queue for poor signal on site
4. Resend, to turn email invites back on
