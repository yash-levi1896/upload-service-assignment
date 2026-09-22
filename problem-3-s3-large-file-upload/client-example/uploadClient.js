/**
 * Example client for the S3 pre-signed multipart upload API.
 * Demonstrates: initiate -> ask for a presigned URL per part -> PUT each
 * part's bytes directly to S3 (never through our API server) -> resume by
 * checking /status for missing parts -> complete -> get a download URL.
 *
 * Uses only Node's built-ins (fs, path) plus the global `fetch` available
 * in Node 18+ - no extra client-side dependencies needed.
 *
 * Usage:
 *   node client-example/uploadClient.js /path/to/file.mp4 [uploadId]
 *
 * If uploadId is omitted, a new upload session is started. If provided,
 * the script resumes that session (only uploads parts that are missing).
 */
const fs = require('fs');
const path = require('path');

const API_BASE_URL = process.env.UPLOAD_API_URL || 'http://localhost:4002';
const CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || 4);

async function api(method, urlPath, body) {
  const res = await fetch(API_BASE_URL + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function readPart(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { start, end: end - 1 });
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function uploadPart(uploadId, filePath, partNumber, start, end) {
  const { url } = await api('POST', `/uploads/${uploadId}/presigned-url`, { partNumber });
  const body = await readPart(filePath, start, end);

  const putRes = await fetch(url, { method: 'PUT', body });
  if (!putRes.ok) {
    throw new Error(`PUT part ${partNumber} failed: HTTP ${putRes.status}`);
  }
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

  let partSize;
  let totalParts;
  let missingParts;

  if (uploadId) {
    console.log(`Resuming upload ${uploadId}...`);
    const status = await api('GET', `/uploads/${uploadId}/status`);
    totalParts = status.totalParts;
    missingParts = status.missingParts;
    console.log(`Resuming: ${totalParts - missingParts.length}/${totalParts} parts already uploaded.`);
    // We don't get partSize back from /status, so re-derive it the same
    // way the server did (ceil-division), which is safe since totalParts
    // and file size are both already fixed for this session.
    partSize = Math.ceil(stat.size / totalParts);
  } else {
    const initRes = await api('POST', '/uploads/initiate', { fileName, fileSize: stat.size });
    uploadId = initRes.uploadId;
    partSize = initRes.partSize;
    totalParts = initRes.totalParts;
    missingParts = Array.from({ length: totalParts }, (_, i) => i + 1); // 1-based
    console.log(`Started upload ${uploadId} (${totalParts} parts of ~${partSize} bytes).`);
  }

  await runPool(
    missingParts,
    async (partNumber) => {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, stat.size);
      await uploadPart(uploadId, filePath, partNumber, start, end);
      console.log(`Uploaded part ${partNumber}/${totalParts}`);
    },
    CONCURRENCY
  );

  const result = await api('POST', `/uploads/${uploadId}/complete`);
  console.log('Upload complete:', result);

  const download = await api('GET', `/uploads/${uploadId}/download-url`);
  console.log('Download URL (temporary):', download.url);
}

main().catch((err) => {
  console.error('Upload failed:', err.message);
  console.error(`Re-run with the same uploadId to resume: node uploadClient.js "${process.argv[2]}" <uploadId>`);
  process.exit(1);
});
