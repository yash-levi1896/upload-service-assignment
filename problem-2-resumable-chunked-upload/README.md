# Problem 2: Resumable / Chunked File Upload — Express + PostgreSQL

Uploads a large file as many small, independent chunks (default 10 MB) so
that a dropped connection only costs you the current chunk, not the whole
transfer. The client tracks (or re-fetches) which chunks have landed and
resumes by sending only what's missing.

## How it works end to end

1. **`POST /uploads/initiate`** — client tells the server the file name,
   total size, and (optionally) desired chunk size. Server creates an
   `uploads` session row, computes `totalChunks`, and returns an `uploadId`.
2. **`POST /uploads/:uploadId/chunk?chunkIndex=N`** — client uploads chunk
   `N` as a raw binary body (`Content-Type: application/octet-stream`).
   Chunks can be sent **in any order** and **in parallel**. Each chunk is
   streamed directly to a temp file, size + sha256 are computed on the fly
   (no buffering), then atomically renamed into its slot and recorded in
   `upload_chunks` via an **UPSERT** keyed on `(upload_id, chunk_index)`.
3. **`GET /uploads/:uploadId/status`** — at any point (including after a
   crash/disconnect), the client can ask which chunks are missing and
   resume by re-sending only those.
4. **`POST /uploads/:uploadId/complete`** — server verifies every chunk
   index `0..totalChunks-1` is present with the correct size, then streams
   them together in order into the final file, verifies the final size
   (and checksum, if provided), and marks the upload `completed`.
5. **`DELETE /uploads/:uploadId`** — cancels a session, removing chunk
   files, the assembled file (if any), and the DB rows.

## Why this handles the specific requirements

| Requirement | How it's implemented |
|---|---|
| Split into chunks (e.g. 10MB) | `DEFAULT_CHUNK_SIZE_BYTES` env var (10MB default); client controls actual splitting, server tells it the chunk size to use |
| Upload chunks independently | Each chunk is its own HTTP request, own file on disk (`storage/chunks/<uploadId>/<index>.part`) |
| Track uploaded chunks | `upload_chunks` table, one row per received chunk |
| Resume from failed chunk | `GET /status` returns `missingChunks`; client re-sends only those |
| Validate chunk completeness | At `/complete`: checks chunk count, contiguous `0..N-1` sequence, correct size per chunk, correct total assembled size, optional whole-file checksum |
| Handle duplicate chunks | `ON CONFLICT (upload_id, chunk_index) DO UPDATE` — resending the same index just overwrites cleanly, never duplicates |
| Concurrent chunk uploads | Different chunk indexes write to different files (no contention); Postgres row-locking serializes any true duplicate-index race; a `chunkUploadLimiter` middleware caps total concurrent chunk streams server-wide |
| Upload progress | `GET /status` returns `uploadedBytes` / `totalBytes` / `percent` / the exact list of missing chunk indexes |

## Project structure

```
config/           DB pool + tunable constants (chunk size, dirs, limits)
controllers/      initiate / chunk / status / complete / delete logic
middleware/       chunk-upload concurrency limiter
routes/           Express router
utils/
  fileHelpers.js    filename sanitizing
  uploadPaths.js    chunk/final file path + expected-size math
  chunkAssembler.js streaming chunk concatenation + sha256
db/               schema.sql, migration runner, optional stale-session cleanup
client-example/   a small Node script that splits a file, uploads chunks
                  concurrently, and demonstrates resuming
storage/
  chunks/<uploadId>/<index>.part   in-progress chunk parts
  completed/<uploadId>.<ext>       assembled final files
```

## Setup

```bash
cd problem-2-resumable-chunked-upload
npm install
cp .env.example .env      # edit DB credentials, ports, chunk size, etc.

createdb chunked_upload_db
npm run migrate           # or: psql -U postgres -d chunked_upload_db -f db/schema.sql

npm start                 # listens on PORT (default 4001)
```

## API walkthrough (curl)

### 1. Initiate
```bash
curl -X POST http://localhost:4001/uploads/initiate \
  -H "Content-Type: application/json" \
  -d '{"fileName": "movie.mp4", "fileSize": 52428800, "mimeType": "video/mp4"}'
```
```json
{ "uploadId": "a1b2...", "fileName": "movie.mp4", "chunkSize": 10485760, "totalChunks": 5 }
```

### 2. Upload chunks (split the file yourself, e.g. with `split` or the example client)
```bash
# chunk 0: bytes 0-10485759
dd if=movie.mp4 bs=10485760 skip=0 count=1 2>/dev/null | \
  curl -X POST "http://localhost:4001/uploads/a1b2.../chunk?chunkIndex=0" \
  -H "Content-Type: application/octet-stream" --data-binary @-
```
Chunks can be sent concurrently and in any order — try firing off several
`curl` calls for different `chunkIndex` values in the background.

### 3. Check status / find what's missing
```bash
curl http://localhost:4001/uploads/a1b2.../status
```
```json
{
  "uploadId": "a1b2...",
  "status": "uploading",
  "totalChunks": 5,
  "uploadedChunks": [0, 1, 3],
  "missingChunks": [2, 4],
  "uploadedBytes": 31457280,
  "totalBytes": 52428800,
  "percent": 60
}
```
On resume after a connection drop, re-run step 2 only for the indexes in
`missingChunks`.

### 4. Complete
```bash
curl -X POST http://localhost:4001/uploads/a1b2.../complete
```

### 5. Cancel / cleanup
```bash
curl -X DELETE http://localhost:4001/uploads/a1b2...
```

## Using the example client (handles splitting + concurrency + resume for you)

```bash
# fresh upload
node client-example/uploadClient.js /path/to/movie.mp4

# if it fails partway (e.g. you kill it with Ctrl+C), resume with the same uploadId:
node client-example/uploadClient.js /path/to/movie.mp4 <uploadId>
```
The script prints the `uploadId` up front specifically so you can copy it
and resume later.

## Design notes / things to highlight if asked

- **Chunk endpoint takes raw bytes, not multipart** — the whole request
  body *is* the chunk (`application/octet-stream`), so it's piped straight
  from the socket to disk with zero parsing overhead, via a `PassThrough`
  tap that computes size + sha256 as bytes flow through.
- **Duplicate-safety comes from the data model, not a special-case check**
  — because `(upload_id, chunk_index)` is `UNIQUE` and every chunk write is
  an `ON CONFLICT ... DO UPDATE`, "handle duplicate chunks" and "support
  concurrent chunk uploads" are really the same guarantee: whatever order
  or however many times a given index arrives, the row (and the file, via
  atomic rename) ends up in one consistent final state.
- **Assembly never buffers the whole file** — `assembleChunks()` streams
  each part file into the destination write stream one at a time using
  `.pipe(dest, { end: false })`, so a 5GB file made of 500 chunks is
  reassembled with roughly constant memory.
- **Extending to network resilience**: this implementation assumes the
  client itself decides when to retry a chunk (e.g. after a timeout). For
  a production system you'd typically add: per-chunk retry/backoff in the
  client, an upload session TTL/expiry (the `cleanupStale.js` script is a
  starting point), and possibly presigned direct-to-storage chunk uploads
  (e.g. S3 multipart) if you want to take the Node process out of the
  data path entirely.
