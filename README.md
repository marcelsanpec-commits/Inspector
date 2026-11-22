# InspectorOne

Field inspection platform for engineering inspectors, with three perspectives:
**inspecting company**, **inspector**, and **client**.

## Quick start

No accounts, no API keys, no Docker.

```bash
npm install          # also builds @inspectorone/shared
npm run seed         # migrate + load demo data
npm run dev          # API on :3000, app on :5173
```

Open **http://localhost:5173** and sign in.

To try the camera and dictation properly you need a real phone: `npm run dev`
binds to your network, so open `http://<your-computer's-IP>:5173` on the handset
while it's on the same wifi. A desktop browser cannot honestly test either one.

`npm test` runs 98 tests. `npm run db:reset` wipes local data; follow with `npm run seed`.

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

### Inspections and structures

An inspector opens a job and taps **Start Inspection** (the job moves to
`in_progress`). The inspection is organised by **structure** — one pole
section, one anchor bolt cage:

1. **New Structure** asks for a photo of the serial number plate first, then
   the serial and what the structure is ("Pole section").
2. Every photo taken on the structure's screen files under it. Each one can be
   marked **non-conforming** (a finding) and **include in report**.
3. **Comments** for the structure are typed or dictated and save themselves.
4. **Finish Structure** puts it on the inspection screen as a tile: plate photo
   as the picture, structure type as the title. It stays editable — serial,
   type, comments, photos — until the job is submitted.

A structure is an *object* (serial, type — persistent, with history across
jobs) seen through one *job* (comments, finished or not). A serial the site
already knows links to its existing record.

**Non-conforming photos are always in the report.** The app locks the toggle,
the API refuses the combination, and a database check constraint backs both.

**Every photo is 4:3** — landscape, or 3:4 if the phone was upright — the frame
the company's reports already use. The app crops before upload (with a slider
when a 16:9 camera leaves something to trim) and the API rejects anything else.
`PHOTO_ASPECT_LONG`/`SHORT` in `packages/shared/src/photos.ts` set it.

### Photos

Uploads are a three-step handshake:

1. Client crops/resizes/compresses, reads EXIF, asks `POST /api/photos/upload-url`
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
job, jobsite, structure, client, capture date, report inclusion, and findings.

### Photo storage (R2)

The code is ready for Cloudflare R2; switching is configuration only. Until
then production keeps photos on the Render instance, which loses them on every
deploy.

1. **Cloudflare dashboard → R2 → Create bucket**, named `inspectorone-media`.
2. **The bucket → Settings → CORS policy → Edit**, and paste:

   ```json
   [
     {
       "AllowedOrigins": ["https://inspectorone-web.onrender.com", "http://localhost:5173"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Phones upload straight to the bucket, so without this every upload fails
   with a vague network error.
3. **R2 → Manage API tokens → Create API token**: *Object Read & Write*,
   limited to that bucket. Note the Access Key ID, the Secret Access Key, and
   your Account ID.
4. **Render → `inspector-qp70` → Environment**: set `STORAGE_DRIVER=s3`,
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET=inspectorone-media`. Saving redeploys.
5. **Check it from your computer**: put the same five values in `.env.local`
   and run
   `CORS_ORIGINS=https://inspectorone-web.onrender.com npm run storage:check`.
   It uploads, reads back, and deletes one tiny test photo the way a phone
   would, and says which step failed if one does.

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
Cloudflare dashboard** (see *Photo storage* above — the local driver won't
surface that requirement), and `SIGNING_SECRET` from `openssl rand -hex 32`.

Compress images client-side. Phone photos are ~4MB; at 1600px JPEG q80 they're
~350KB. Across five inspectors that's 24GB/month versus 2GB/month.

## Status

**Done — back end:** schema (14 tables), signup/login/sessions, invites both
ways, roster management for companies and clients, sites, persistent objects,
jobs with multi-inspector assignment and restrictable client access, photo
upload handshake, voice notes, report-inclusion toggle, gallery with filters,
structures (create, edit, finish, remove, correct a serial), serial plate
photos, non-conforming findings, the 4:3 photo frame, R2-ready storage with
`npm run storage:check`. 98 tests.

**Done — app:** one React app with role-aware navigation. Login and a
three-way signup; the inspection flow (Start Inspection, New Structure from
the serial plate, camera with 4:3 framing, non-conforming and include-in-report
per photo, dictated comments, Finish Structure, structure tiles); company job
creation, team roster, clients, sites; client-facing job list and gallery;
per-structure inspection history.

**Next:** Cloudflare R2 (code ready — needs the bucket and keys above), then
the report template and PDF generation, then the offline capture queue.
