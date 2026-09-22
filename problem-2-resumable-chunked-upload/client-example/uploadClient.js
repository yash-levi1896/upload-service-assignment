/**
 * Example client for the resumable/chunked upload API.
 * Demonstrates: splitting a file into chunks, uploading them (with limited
 * concurrency), resuming from a previous session's status, and completing.
 *
 * Usage:
 *   node client-example/uploadClient.js /path/to/file.mp4 [uploadId]
 *
 * If uploadId is omitted, a new upload session is started. If provided,
 * the script resumes that session (only uploads chunks that are missing).
 *
 * No external dependencies - uses only Node's built-in fs and http/https.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE_URL = process.env.UPLOAD_API_URL || 'http://localhost:4001';
const CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || 4);

function request(method, urlPath, { headers = {}, body, isStream = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
        });
      }
    );
    req.on('error', reject);

    if (isStream && body) {
      body.pipe(req);
    } else if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    } else {
      req.end();
    }
  });
}

async function uploadChunk(uploadId, filePath, chunkIndex, start, end) {
  const stream = fs.createReadStream(filePath, { start, end: end - 1 });
  return request('POST', `/uploads/${uploadId}/chunk?chunkIndex=${chunkIndex}`, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start,
    },
    body: stream,
    isStream: true,
  });
}

async function runPool(items, worker, concurrency) {
  const queue = [...items];
  const workers = new Array(concurrency).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const filePath = process.argv[2];
  let uploadId = process.argv[3];

  if (!filePath) {
    console.error('Usage: node uploadClient.js <filePath> [uploadId]');
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);

  let chunkSize;
  let totalChunks;
  let missingChunks;

  if (uploadId) {
    console.log(`Resuming upload ${uploadId}...`);
    const status = await request('GET', `/uploads/${uploadId}/status`);
    chunkSize = status.chunkSize;
    totalChunks = status.totalChunks;
    missingChunks = status.missingChunks;
    console.log(`Resuming: ${status.uploadedChunks.length}/${totalChunks} chunks already uploaded.`);
  } else {
    const initRes = await request('POST', '/uploads/initiate', {
      headers: { 'Content-Type': 'application/json' },
      body: { fileName, fileSize: stat.size },
    });
    uploadId = initRes.uploadId;
    chunkSize = initRes.chunkSize;
    totalChunks = initRes.totalChunks;
    missingChunks = Array.from({ length: totalChunks }, (_, i) => i);
    console.log(`Started upload ${uploadId} (${totalChunks} chunks of ${chunkSize} bytes).`);
  }

  await runPool(
    missingChunks,
    async (chunkIndex) => {
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, stat.size);
      await uploadChunk(uploadId, filePath, chunkIndex, start, end);
      console.log(`Uploaded chunk ${chunkIndex + 1}/${totalChunks}`);
    },
    CONCURRENCY
  );

  const result = await request('POST', `/uploads/${uploadId}/complete`);
  console.log('Upload complete:', result);
}

main().catch((err) => {
  console.error('Upload failed:', err.message);
  console.error(`Re-run with the same uploadId to resume: node uploadClient.js "${process.argv[2]}" <uploadId>`);
  process.exit(1);
});
