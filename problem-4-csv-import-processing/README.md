# Problem 4: Large CSV Upload + Background Processing — Express + PostgreSQL + Redis/BullMQ

Accepts a 500MB-2GB CSV, streams it to disk, and processes it **entirely
in a separate worker process** so the API server is never blocked -
uploading, checking status, downloading errors, and starting a *new*
import all keep working instantly no matter how large or slow the current
import is.

## Why BullMQ here (and not in Problems 1-3)

This is the one problem in the set where the requirement is genuinely
"real background work with retries and progress" (parse gigabytes, run
batched inserts, potentially take minutes) rather than "clean up some old
rows once a day." That's exactly BullMQ's use case, so:

- `server.js` (the API) only ever **uploads a file and calls `queue.add()`**
  — it returns `202 Accepted` immediately.
- `worker.js` is a **separate Node process** that pulls jobs off the queue
  and does 100% of the CSV parsing/validation/DB work. If you kill the API
  process, in-flight processing keeps running; if the worker crashes, the
  API keeps accepting uploads (they just queue up until a worker is
  available again).
- Retries with backoff come for free from BullMQ, and — importantly — are
  **safe to actually use** here (see "Idempotent retries" below).

## How it works end to end

1. **`POST /imports`** — CSV is streamed to disk with the same memory-safe
   pattern as Problem 1 (Busboy → `pipeline()` → `fs.createWriteStream`,
   nothing buffered in RAM). An `imports` row is created with status
   `UPLOADED`, a BullMQ job is enqueued, and the response returns
   immediately — **before** any processing happens.
2. **Worker picks up the job** → sets status to `PROCESSING` → does a fast
   line-count pass (for accurate progress %) → streams the CSV through
   `csv-parse` → groups rows into batches of ~1000.
3. **Per batch**: validate each row's fields, catch duplicate phone numbers
   *within the batch*, then bulk-insert the survivors with
   `INSERT ... ON CONFLICT (phone) DO NOTHING RETURNING phone` — anything
   NOT returned was a duplicate against data already in the table (from an
   earlier batch of this import, or a completely different import).
   Anything invalid or duplicate is streamed into an error CSV as it's
   found; the `imports` row's progress counters are updated once per batch.
4. **On completion**: status → `COMPLETED`, final counts saved, error CSV
   path saved (or discarded if there were zero errors).
5. **On an unhandled error**: status → `FAILED`, message saved, and BullMQ
   retries the job automatically (see below) up to 3 times with backoff.

## Idempotent retries (why re-running a failed job is safe)

If the worker crashes partway through (say, after 300 of 1000 batches),
BullMQ will retry the whole job from scratch. That's normally scary for a
job with side effects — but here it's safe:

- The unique constraint on `contacts.phone` + `ON CONFLICT DO NOTHING`
  means re-inserting rows that already made it into the DB on attempt #1
  just gets silently skipped on attempt #2. **No duplicate rows, ever.**
- The one side effect is that already-successfully-imported rows get
  reported as "duplicate" in the second attempt's error CSV instead of
  "valid" — a minor cosmetic quirk, not a correctness problem.
- The error CSV and progress counters are simply overwritten by whichever
  attempt actually finishes, so the final state is always consistent.

## Design decisions worth calling out

- **"Duplicate phone number" is a global rule**, not per-file: `phone` is
  `UNIQUE` across the whole `contacts` table. This treats a phone number as
  identifying one contact system-wide, which felt like the more realistic
  interpretation for a real system - and it's what makes the idempotent
  retry story above work cleanly. If you actually want per-file-only
  dedup, drop the `UNIQUE` constraint in `db/schema.sql` and do the dedup
  purely in application code in `services/csvProcessor.js` (there's a
  comment at the exact spot).
- **Memory-bounded duplicate detection**: duplicate checking never needs an
  in-memory set of "every phone seen so far in a 2GB file" (which could
  itself become a memory problem on huge files) — within-batch duplicates
  are caught with a `Set` bounded to ~1000 entries, and everything else is
  caught by the database's own unique index.
- **Streaming end to end**: the CSV is read via `csv-parse`'s stream
  interface with `for await...of` (which respects backpressure
  automatically — awaiting a batch's DB work pauses the underlying file
  read without any manual `.pause()`/`.resume()`), and the error CSV is
  written incrementally via a backpressure-aware writer. Memory stays flat
  whether the file is 10MB or 2GB.
- **Flexible CSV headers**: column names are matched case/spacing
  -insensitively against common aliases (`phone`/`phone_number`/`mobile`,
  etc. — see `utils/validators.js`), so the exact header spelling in the
  source file doesn't matter much.
- **Progress accuracy trade-off**: a fast up-front byte-scan counts total
  rows (for an accurate `percent`) before the real parse begins, which
  means reading the file twice. It's a fast, allocation-free scan
  (nowhere near as expensive as the real parse+insert pass), and the
  trade-off is explained in `utils/lineCounter.js` along with the
  alternative if you'd rather avoid it.

## Project structure

```
config/
  db.js          PostgreSQL pool
  redis.js       shared ioredis connection (used by both API and worker)
  queue.js       the BullMQ Queue definition
  constants.js   batch size, dirs, limits
controllers/
  importsController.js   the 5 API endpoints
services/
  csvProcessor.js         the actual streaming parse/validate/batch/insert logic
utils/
  fileHelpers.js   filename sanitizing
  validators.js    header aliasing + field validation
  csvWriter.js     CSV field escaping
  errorCsvWriter.js  streaming, backpressure-aware error-file writer
  lineCounter.js   fast row-count pre-pass for progress
middleware/
  uploadLimiter.js   concurrency limiter for POST /imports
db/
  schema.sql, migrate.js
sample-data/
  sample.csv    tiny CSV covering valid/invalid/duplicate cases, for a quick demo
app.js / server.js   the API process (upload + enqueue only)
worker.js             the SEPARATE worker process (all the heavy lifting)
```

## Setup

```bash
cd problem-4-csv-import-processing
npm install
cp .env.example .env      # DB creds, Redis host, etc.

createdb csv_import_db
npm run migrate

# Redis must be running (e.g. `redis-server`, or a managed Redis in prod)

# Terminal 1: the API
npm start                 # listens on PORT (default 4003)

# Terminal 2: the worker - REQUIRED for anything to actually get processed
npm run worker
```

## API walkthrough (curl)

### 1. Upload a CSV
```bash
curl -X POST http://localhost:4003/imports -F "file=@sample-data/sample.csv"
```
```json
{
  "id": "c1d2...",
  "originalFilename": "sample.csv",
  "size": 274,
  "status": "UPLOADED",
  "message": "File uploaded successfully. Processing has been queued and will run in the background."
}
```
Notice this responds instantly — try it against a genuinely large file and
you'll see the same near-instant response, because the response doesn't
wait for any row to actually be processed.

### 2. Poll status
```bash
curl http://localhost:4003/imports/c1d2.../status
```
```json
{
  "id": "c1d2...",
  "status": "PROCESSING",
  "totalRows": 6,
  "processedRows": 6,
  "validRows": 3,
  "invalidRows": 2,
  "duplicateRows": 1,
  "percent": 100,
  "startedAt": "...",
  "completedAt": null
}
```

### 3. Get metadata
```bash
curl http://localhost:4003/imports/c1d2...
```

### 4. Download the error CSV
```bash
curl http://localhost:4003/imports/c1d2.../errors -o errors.csv
```
For `sample-data/sample.csv`, this contains the "Bad Row" (invalid phone +
email), the missing-phone row, and the repeated-phone row, each with a
`reason` column.

### 5. Delete an import
```bash
curl -X DELETE http://localhost:4003/imports/c1d2...
```
Removes the DB row, the original file, and the error file. If the job
hasn't started yet it's also removed from the queue; if it's mid-run, the
worker notices the row is gone (checked once per batch) and stops early.

## Testing with the sample file

`sample-data/sample.csv` has 6 rows deliberately covering every case: two
clean rows, one row with both an invalid phone and invalid email, one
missing-phone row, and one row that's a straight duplicate of an earlier
row's phone number. Expected result after processing: `validRows: 3`,
`invalidRows: 2`, `duplicateRows: 1`.

## Notes / things you could extend for production

- Add auth/ownership checks (currently open, for assignment scope).
- If you need visibility into the queue itself (retries, failed jobs,
  timing), add [Bull Board](https://github.com/felixmosh/bull-board) - it
  mounts a small dashboard UI on top of the same BullMQ queue with almost
  no extra code.
- For files with an unknown/inconsistent set of columns beyond
  name/email/phone, consider storing the full raw row as JSONB alongside
  the normalized columns (an easy addition to the `contacts` table and
  `insertBatch()`).
- Horizontal scaling: run multiple `worker.js` processes/containers -
  BullMQ handles distributing jobs between them safely with no code
  changes needed here.
