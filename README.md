# File Upload Systems — Assignment Submission

Each problem is a **separate, independently runnable** Express +
PostgreSQL service, in its own folder with its own `package.json`,
`.env.example`, DB schema, and README. They don't share a database or a
process — run whichever one you're grading on its own port.

| Folder | Problem | Port (default) |
|---|---|---|
| [`problem-1-basic-streaming-upload/`](./problem-1-basic-streaming-upload) | Large File Upload API — Basic Streaming | 4000 |
| [`problem-2-resumable-chunked-upload/`](./problem-2-resumable-chunked-upload) | Resumable / Chunked File Upload | 4001 |

More problems will be added here as they're completed (`problem-3-...`,
`problem-4-...`), following the same structure.

## Quick start (either problem)

```bash
cd problem-<n>-.../
npm install
cp .env.example .env        # edit DB credentials
createdb <db_name>          # see that problem's .env.example for the name
npm run migrate             # applies db/schema.sql
npm start
```

See each folder's own `README.md` for full API docs, curl examples, and
design notes specific to that problem.

## Shared design principles across both problems

- **Streaming end to end** — uploads are piped from socket to disk and
  downloads/assembly are piped from disk to socket/disk; nothing is fully
  buffered in memory regardless of file size.
- **PostgreSQL for metadata**, local disk for file bytes.
- **Stability under concurrent load** — each service has a concurrency
  limiter middleware so a burst of simultaneous large transfers gets a
  clean `429` instead of exhausting disk I/O / file descriptors.
- **Defensive validation** — filenames are sanitized against path
  traversal, sizes and types are checked against configurable allow-lists,
  and every ID is UUID-validated before touching the database.
