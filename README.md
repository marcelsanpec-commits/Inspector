# InspectorOne

Field inspection platform for engineering inspectors, with three perspectives:
**inspecting company**, **inspector**, and **client**.

## Quick start

No accounts, no API keys, no Docker.

```bash
npm install          # also builds @inspectorone/shared
npm run seed         # migrate + load demo data
npm run dev          # API on http://localhost:3000
```

`npm test` runs 57 tests. `npm run db:reset` wipes local data; follow with `npm run seed`.

Every seeded account uses the password **`inspector-demo-2026`**:

| Account | Role | Sees |
|---|---|---|
| `dana@sanpec.example` | company owner | all 5 jobs |
| `marcus@sanpec.example` | inspector | jobs 1, 2 |
| `priya@sanpec.example` | inspector | jobs 3, 4, 5 |
| `jamie@harborpoint.example` | client owner | jobs 4, 5 |
| `alex@harborpoint.example` | client member | job 4 only |
| `sam@westline.example` | client owner | nothing (their job isn't delivered) |
| `owner@rival.example` | other company | nothing |
| `newhire@example.com` | unaffiliated inspector | nothing — account ID `IO-J2RD4N` |

The last two exist so isolation is testable against something real.

## How the model works

**Organizations** are either an inspecting company or a client company. Both have
multiple members, which is why a client is an org and not a contact row — five
people at a client all need their own logins.

**Users** are people with a unique, human-transcribable account ID (`IO-7K3M9Q`).
The alphabet omits `0/1/I/O/U/V` because someone reads these aloud in a parking
lot. **Memberships** join users to orgs, so one person can inspect for two firms
on one account.

**Objects** are serial-numbered assets that live on a **jobsite** and persist
across jobs. Re-entering a known serial returns the existing object rather than
duplicating it — that's what makes year-over-year history per serial possible,
and it's forgiving when someone types with gloves on.

### Who sees what

| Role | Access |
|---|---|
| Company owner/admin | Everything in their company |
| Inspector | Only jobs they're assigned to; writable while the job is open |
| Client member | Only **delivered** jobs for their org; strictly read-only |

Client access is org-wide by default. A job can be set to `restricted` and
narrowed to named people — the seed's job 5 shows this: Jamie can see it, Alex
(same client org) cannot.

Authorization is written as **SQL predicates** (`src/authz.ts`) composed into
every job-scoped query, so a row the caller may not see is never loaded. There's
no "forgot to check before returning" failure mode. Out-of-scope rows return
**404, not 403** — a 403 confirms another client's job exists.

### Getting people onto a roster

Two paths, both supported:

- **By account ID** — they sign up, read their ID off their screen, you type it
- **By email invite** — they get a link, set a password, and land in your org

Inviting a brand-new *client company* creates that org, makes the invitee its
owner, and links it to your company in one step.

### Photos

Uploads are a three-step handshake:

1. Client resizes/compresses, reads EXIF, asks `POST /api/photos/upload-url`
2. Client `PUT`s bytes **directly** to the signed URL
3. `POST /api/photos/confirm` — the API verifies the object exists before the
   photo leaves `pending`

The API never handles image data, so a small instance survives an inspector
syncing forty photos. Locally the signed URL points at the API's own
`/storage/*` routes; in production it points at R2. Client code is identical.

`takenAt` + GPS are read from EXIF **before** the client strips it. `clientRef`
makes uploads idempotent, so a dropped signal can't duplicate a photo.

**Voice notes** are dictated on-device via the Web Speech API into
`photo.voiceNote`, always editable afterwards. Free, no keys, no transcription
service.

**`includeInReport`** is a per-photo toggle, editable long after capture — the
call is usually clearer at the office than on a ladder. The **gallery**
(`GET /api/gallery`) is deliberately separate from the report and filters by
job, jobsite, object, client, capture date, and report inclusion.

## Local vs production

| Concern | Local (now) | Production (later) |
|---|---|---|
| Database | PGlite — real Postgres, in-process | Neon or Supabase |
| Photos | Local disk, `storage/` | Cloudflare R2 |
| Email | Console driver, prints invite links | Resend |
| Auth | scrypt + opaque DB sessions | same |

Each is a driver behind an interface, so production changes environment
variables, not code. PGlite is genuine Postgres compiled to WASM, so local and
production share one schema and one set of migrations — that equivalence is why
this isn't SQLite.

`env.ts` refuses to boot in production without `DATABASE_URL` and
`SIGNING_SECRET`, and refuses the console email driver there, since a live
invite link sitting in a log is a credential.

## Deploying

`render.yaml` is a Blueprint: Render dashboard → New → Blueprint → pick the repo.
Push to `main` afterwards and it redeploys automatically.

Before the first deploy: a Postgres (Neon/Supabase — **not** Render's free tier,
which is deleted after 30 days), an R2 bucket with **CORS configured in the
Cloudflare dashboard** (the local driver won't surface that requirement), and
`SIGNING_SECRET` from `openssl rand -hex 32`.

Compress images client-side. Phone photos are ~4MB; at 1600px JPEG q80 they're
~350KB. Across five inspectors that's 24GB/month versus 2GB/month.

## Status

**Done:** schema (14 tables), signup/login/sessions, invites both ways, roster
management for companies and clients, sites, persistent objects, jobs with
multi-inspector assignment and restrictable client access, photo upload
handshake, voice notes, report-inclusion toggle, gallery with filters, 57 tests.

**Next:** the three portals (login → role-aware shell, inspector capture screen
with camera + dictation, company job management, client gallery), then the
report template and PDF generation, then the offline queue.
