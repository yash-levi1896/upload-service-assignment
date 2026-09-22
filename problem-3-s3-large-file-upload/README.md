# Problem 3: Large File Upload to AWS S3 — Express + PostgreSQL

A scalable upload service where **file bytes never pass through this
server**. The Express API only does two things: (1) talks to S3's
multipart-upload APIs to create/track/complete uploads, and (2) hands the
client short-lived, pre-signed URLs so the client (browser, mobile app,
CLI) uploads/downloads directly against S3. This is the standard AWS
pattern for scaling file uploads — your API server's bandwidth and memory
are no longer a bottleneck no matter how large the file or how many
uploads happen concurrently.

## How it works end to end

1. **`POST /uploads/initiate`** — client sends `fileName`, `fileSize`,
   (optional) `mimeType`/`partSize`. Server calls S3's
   `CreateMultipartUpload`, stores session metadata in Postgres, and
   returns `uploadId`, `partSize`, `totalParts`.
2. **`POST /uploads/:id/presigned-url`** — client asks for a pre-signed
   `UploadPart` URL for a specific `partNumber` (1-based, S3's own
   convention). The client then `PUT`s that part's raw bytes **directly to
   S3** using that URL — this call never reaches our server.
3. **`GET /uploads/:id/status`** — calls S3's `ListParts` to see exactly
   which parts have landed. Returns `missingParts` so a client that lost
   its connection (or crashed) can resume by requesting new pre-signed
   URLs only for what's missing.
4. **`POST /uploads/:id/complete`** — re-fetches the definitive part list
   from S3 (`ListParts`), validates every part `1..totalParts` is present,
   then calls `CompleteMultipartUpload` with that list. The client never
   has to collect or report ETags itself — S3 already knows them.
5. **`GET /uploads/:id/download-url`** — once completed, returns a
   pre-signed `GetObject` URL so the client can download straight from S3.
6. **`DELETE /uploads/:id`** — aborts the S3 multipart upload (or deletes
   the completed object) and removes the DB record.

A background script (`npm run cleanup:expired`) finds sessions that were
started but never completed within `UPLOAD_TTL_HOURS` and aborts them on
the S3 side too — see **"Expiring abandoned uploads"** below for why this
matters.

## Why there's no "parts" table (unlike Problem 2)

In Problem 2 we kept our own `upload_chunks` table because we were storing
chunks ourselves. Here, **S3 is already the source of truth**: an
in-progress multipart upload remembers every part you've successfully
`PUT`, along with its ETag and size, and `ListParts` lets us read that
back at any time. Duplicating that bookkeeping in Postgres would just be
another thing that could drift out of sync with reality — so `/status` and
`/complete` both query S3 directly instead.

This also gives you "handle duplicate parts" and "support concurrent part
uploads" for free: re-uploading `partNumber` 4 just overwrites that slot in
S3, and uploading parts 1-10 in parallel from 10 different connections is
exactly how S3 multipart upload is designed to be used.

## Project structure

```
config/
  db.js            PostgreSQL pool
  s3Client.js       AWS S3 client (env creds, or default provider chain)
  constants.js      S3 limits, bucket name, expiry settings
controllers/
  uploadsController.js   all 6 endpoints
routes/
  uploads.js
utils/
  fileHelpers.js    filename sanitizing
  partMath.js       part-count math + S3 limit validation
  s3Parts.js         paginated ListParts helper (shared by status/complete)
db/
  schema.sql, migrate.js, cleanupExpired.js
client-example/
  uploadClient.js    end-to-end demo: split, upload parts in parallel
                      directly to S3, resume, complete, get download URL
```

## Setup

### 1. AWS side
- Create an S3 bucket (private is fine and recommended — pre-signed URLs
  work against private buckets; you don't need to make anything public).
- **CORS** (required if a browser will `PUT` parts directly to S3): add a
  CORS rule on the bucket allowing your web app's origin, `PUT`/`GET`
  methods, and the headers your uploads send (at minimum
  `Content-Type`). Example bucket CORS config:
  ```json
  [
    {
      "AllowedOrigins": ["https://your-app.example.com"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"]
    }
  ]
  ```
- **Lifecycle rule (recommended)**: add `AbortIncompleteMultipartUpload`
  (e.g. after 2 days) on the bucket. This is a backstop that cleans up
  abandoned multipart uploads even if `cleanupExpired.js` is never
  scheduled, crashes, or this service is decommissioned — see below.
- **IAM permissions** the API server's credentials/role need on the
  bucket: `s3:CreateMultipartUpload`, `s3:UploadPart` (only needed if you
  ever sign it, which we do), `s3:ListMultipartUploadParts`,
  `s3:CompleteMultipartUpload`, `s3:AbortMultipartUpload`, `s3:GetObject`,
  `s3:DeleteObject`.

### 2. This service
```bash
cd problem-3-s3-large-file-upload
npm install
cp .env.example .env      # fill in AWS_REGION, S3_BUCKET_NAME, DB creds
                           # (leave AWS_ACCESS_KEY_ID/SECRET blank to use
                           # an IAM role / default credential chain instead)

createdb s3_upload_db
npm run migrate

npm start                 # listens on PORT (default 4002)
```

## API walkthrough (curl)

### 1. Initiate
```bash
curl -X POST http://localhost:4002/uploads/initiate \
  -H "Content-Type: application/json" \
  -d '{"fileName": "movie.mp4", "fileSize": 52428800, "mimeType": "video/mp4"}'
```
```json
{ "uploadId": "a1b2...", "key": "uploads/a1b2.../movie.mp4", "partSize": 10485760, "totalParts": 5 }
```

### 2. Get a pre-signed URL for a part, then upload directly to S3
```bash
curl -X POST http://localhost:4002/uploads/a1b2.../presigned-url \
  -H "Content-Type: application/json" -d '{"partNumber": 1}'
# -> { "url": "https://your-bucket.s3.amazonaws.com/...&X-Amz-Signature=...", ... }

curl -X PUT "<that url>" --data-binary @part1.bin
```
Repeat for each part — these can run concurrently from multiple
connections, and out of order.

### 3. Check status / resume
```bash
curl http://localhost:4002/uploads/a1b2.../status
```
```json
{
  "uploadId": "a1b2...",
  "status": "uploading",
  "totalParts": 5,
  "uploadedParts": [1, 2, 4],
  "missingParts": [3, 5],
  "uploadedBytes": 31457280,
  "totalBytes": 52428800,
  "percent": 60
}
```
If your process crashed or the connection dropped, just call `/status`
again later (even from a different machine) and re-request presigned URLs
for whatever's in `missingParts`.

### 4. Complete
```bash
curl -X POST http://localhost:4002/uploads/a1b2.../complete
```

### 5. Get a download URL
```bash
curl http://localhost:4002/uploads/a1b2.../download-url
```
```json
{ "uploadId": "a1b2...", "url": "https://your-bucket.s3.amazonaws.com/...", "expiresIn": 3600 }
```

### 6. Cancel / cleanup
```bash
curl -X DELETE http://localhost:4002/uploads/a1b2...
```

## Using the example client

```bash
# fresh upload - splits the file, uploads parts in parallel straight to S3, completes it
node client-example/uploadClient.js /path/to/movie.mp4

# if it fails partway, resume with the printed uploadId:
node client-example/uploadClient.js /path/to/movie.mp4 <uploadId>
```

## Expiring abandoned uploads

An S3 multipart upload that's started but never completed or aborted
**keeps its uploaded parts in storage indefinitely, and you keep paying
for them** — this is a well-known AWS gotcha. Two layers handle it here:

1. **App-level**: every session gets an `expires_at` (default 24h from
   `initiate`). Run `npm run cleanup:expired` on a schedule (cron, a
   scheduled Lambda, etc.) to abort any session past that TTL that never
   completed, marking it `expired` in the DB.
2. **Bucket-level (the real backstop)**: configure the bucket's
   `AbortIncompleteMultipartUpload` lifecycle rule (see Setup above). This
   runs inside S3 itself, independent of whether this app or its cron job
   is even running — so it's the layer to actually rely on in production;
   the app-level script is mainly there to keep the DB's `status` in sync.

## Notes / things you could extend for production

- Add auth/ownership checks (currently open, for assignment scope).
- Validate `Content-MD5` or a per-part checksum if you want to catch
  corruption in transit before `/complete` (S3 supports signing
  `Content-MD5` into the pre-signed URL as an extra integrity check).
- For very large numbers of concurrent uploads, consider moving session
  metadata to a table partitioned by date, and paginating `/status`'s part
  list response for uploads with thousands of parts.
- If clients are trusted backends rather than browsers, you could
  alternatively use `@aws-sdk/lib-storage`'s `Upload` helper for
  server-to-S3 transfers — pre-signed URLs are specifically the right
  choice here because the goal is letting an *untrusted client* (browser)
  upload directly without ever holding AWS credentials.
