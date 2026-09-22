# Problem 1: Large File Upload API (Basic Streaming) — Express + PostgreSQL

Uploads 1–5 GB files without buffering them into memory, using Node.js
Streams end to end. Metadata is stored in PostgreSQL; files are stored on
local disk.

## How the memory-safety works

- The multipart request is parsed with **Busboy**, which hands you the file
  as a readable stream as bytes arrive off the socket — nothing is buffered
  in RAM by Express/body-parser first.
- That stream is piped straight to `fs.createWriteStream()` using
  `stream/promises`' `pipeline()`, which handles backpressure automatically
  (if disk writes are slower than network reads, Node pauses the socket).
- Downloads are streamed back out with `fs.createReadStream()` (with HTTP
  Range support), never `fs.readFile()`.
- Result: memory usage stays roughly constant (a few MB of buffers) no
  matter whether the file is 10 MB or 5 GB.

## Stability under concurrent uploads

- `MAX_CONCURRENT_UPLOADS` (env var) caps how many uploads can stream to
  disk at once; extra requests get a fast `429` instead of piling up and
  contending for disk I/O / file descriptors.
- `server.requestTimeout` / `headersTimeout` are disabled so slow, large
  uploads aren't killed by Node's default 5-minute request timeout.
- Busboy's own `fileSize` limit is a second guard against a spoofed
  `Content-Length` header.

## Project structure

```
config/         DB pool + tunable constants (max size, allowed types, dir)
controllers/    Route handlers (the actual streaming logic)
middleware/     Concurrency limiter
routes/         Express router
utils/          Filename sanitizing + in-memory progress tracker
db/             schema.sql + a tiny migration runner
storage/uploads Local file storage (created automatically)
app.js          Express app wiring
server.js       Entry point
```

## Setup

```bash
cd problem-1-basic-streaming-upload
npm install
cp .env.example .env      # then edit DB credentials etc.

# Create the database once, e.g.:
createdb file_upload_db

# Apply schema
npm run migrate           # or: psql -U postgres -d file_upload_db -f db/schema.sql

npm start                 # or: npm run dev (nodemon)
```

Server listens on `PORT` (default `4000`).

## API

### 1. Upload a file
```
POST /files/upload
Content-Type: multipart/form-data
Field name: "file"
```
```bash
curl -X POST http://localhost:4000/files/upload \
  -F "file=@/path/to/movie.mp4"
```
Response:
```json
{ "id": "b3d9...", "originalName": "movie.mp4", "mimeType": "video/mp4", "size": 3123456789, "status": "completed" }
```

**Polling progress on a still-in-flight upload:** because a single POST only
responds once the upload is fully done, use the two-step flow if you want to
poll `/status` from another terminal/tab *while* a big file is still going up:

```bash
# 1) reserve an id
FILE_ID=$(curl -s -X POST http://localhost:4000/files/upload/init | jq -r .fileId)

# 2) upload using that id (run this in the background)
curl -X POST "http://localhost:4000/files/upload?fileId=$FILE_ID" -F "file=@/path/to/movie.mp4" &

# 3) from another terminal, poll while it uploads
watch -n1 curl -s http://localhost:4000/files/$FILE_ID/status
```

### 2. Check status
```
GET /files/:id/status
```
```json
{ "id": "b3d9...", "status": "uploading", "uploadedBytes": 512000000, "totalBytes": 3123456789, "percent": 16 }
```

### 3. Get metadata
```
GET /files/:id
```

### 4. Download
```
GET /files/:id/download
```
Supports `Range` headers for resumable/partial downloads.

### 5. Delete
```
DELETE /files/:id
```

## Validation implemented

- **Size**: rejects requests whose `Content-Length` exceeds
  `MAX_FILE_SIZE_BYTES` up front (413), plus a stream-level Busboy limit as
  a backstop against a spoofed header.
- **Type**: checked against `ALLOWED_MIME_TYPES` and `ALLOWED_EXTENSIONS`
  (both configurable via `.env`; leave empty to allow all — not recommended).
- **Name**: sanitized to strip directory components, reject `..`/empty/
  control characters/overly long names before it's used to build the disk
  path (prevents path traversal).

## Notes / things you could extend for production

- Swap the in-memory `progressStore` for Redis if you run multiple
  instances behind a load balancer.
- Add a disk-space pre-check before accepting an upload.
- Add auth/ownership checks on all endpoints (currently open, for the
  purposes of this assignment).
- For network-drop resilience, see **Problem 2** in this repo, which
  implements chunked/resumable uploads.
