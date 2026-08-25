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
npm run dev       # API on :3000, app on :5173
npm test          # 57 API tests
npm run typecheck # all three workspaces
npm run build     # shared -> api -> web
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
   deleted on every deploy. R2 is the next infrastructure job.

## Status

**Done:** schema (14 tables), signup/login/sessions, invites by email and by
account ID, roster management for companies and clients, sites, persistent
objects, jobs with multi-inspector assignment and restrictable client access,
photo upload handshake (direct to storage, EXIF + GPS preserved), on-device
dictation, include-in-report toggle, gallery with filters, per-object history,
and the web app for all three roles. 57 tests plus a 32-step end-to-end flow
check.

**Next, in order:**
1. Cloudflare R2, so photos survive a deploy
2. Report template and PDF generation (owner wants one fixed template first,
   custom templates later — ask for their actual template, don't invent one)
3. Offline capture queue for poor signal on site
4. Resend, to turn email invites back on
