const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const { v4: uuidv4, validate: isUuid } = require('uuid');

const pool = require('../config/db');
const {
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  DEFAULT_CHUNK_SIZE,
  COMPLETED_DIR,
} = require('../config/constants');
const { sanitizeFilename } = require('../utils/fileHelpers');
const { assembleChunks, sha256File } = require('../utils/chunkAssembler');
const {
  uploadChunkDir,
  chunkPartPath,
  completedFilePath,
  expectedChunkSize,
} = require('../utils/uploadPaths');

/**
 * POST /uploads/initiate
 * Body: { fileName, fileSize, mimeType?, chunkSize?, checksum? }
 *
 * Creates an upload session and tells the client how to split the file
 * (chunkSize, totalChunks). The client is responsible for splitting the
 * file client-side and uploading each chunk independently.
 */
async function initiateUpload(req, res) {
  const { fileName, fileSize, mimeType, chunkSize, checksum } = req.body || {};

  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'fileName is required' });
  }
  const cleanName = sanitizeFilename(fileName);
  if (!cleanName) return res.status(400).json({ error: 'Invalid fileName' });

  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'fileSize must be a positive number of bytes' });
  }
  if (size > MAX_FILE_SIZE) {
    return res.status(413).json({ error: `fileSize exceeds max allowed size of ${MAX_FILE_SIZE} bytes` });
  }

  const extension = path.extname(cleanName).toLowerCase();
  if (ALLOWED_EXTENSIONS.length && !ALLOWED_EXTENSIONS.includes(extension)) {
    return res.status(400).json({ error: `File extension "${extension}" is not allowed` });
  }
  if (mimeType && ALLOWED_MIME_TYPES.length && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return res.status(400).json({ error: `Mime type "${mimeType}" is not allowed` });
  }

  const finalChunkSize = Number(chunkSize) > 0 ? Number(chunkSize) : DEFAULT_CHUNK_SIZE;
  const totalChunks = Math.ceil(size / finalChunkSize);
  const uploadId = uuidv4();

  await pool.query(
    `INSERT INTO uploads
       (id, file_name, mime_type, extension, total_size, chunk_size, total_chunks, checksum, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'initiated')`,
    [uploadId, cleanName, mimeType || null, extension, size, finalChunkSize, totalChunks, checksum || null]
  );

  fs.mkdirSync(uploadChunkDir(uploadId), { recursive: true });

  res.status(201).json({
    uploadId,
    fileName: cleanName,
    chunkSize: finalChunkSize,
    totalChunks,
  });
}

/**
 * POST /uploads/:uploadId/chunk?chunkIndex=N
 * Content-Type: application/octet-stream
 * Body: raw bytes of exactly one chunk
 *
 * The request body IS the chunk - no multipart parsing needed, so it's
 * piped directly from the socket to disk. A PassThrough tap computes the
 * byte count + sha256 as the data flows through, without buffering it.
 *
 * Duplicate-safe: chunks are written to a temp file first, then atomically
 * renamed into place, and the DB row is an UPSERT keyed on
 * (upload_id, chunk_index) - so re-sending the same chunk (e.g. a client
 * retry after a timeout) simply overwrites the same slot, never corrupts
 * state or creates duplicates.
 *
 * Concurrency-safe: different chunk indexes write to different files, so
 * parallel chunk uploads for the same upload session don't contend with
 * each other on disk.
 */
async function uploadChunk(req, res) {
  const { uploadId } = req.params;
  if (!isUuid(uploadId)) return res.status(400).json({ error: 'Invalid upload id' });

  const chunkIndex = Number(req.query.chunkIndex);
  if (req.query.chunkIndex === undefined || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return res.status(400).json({ error: 'chunkIndex query parameter is required and must be a non-negative integer' });
  }

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [uploadId]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  if (upload.status === 'completed' || upload.status === 'aborted') {
    return res.status(409).json({ error: `Upload session is already ${upload.status}` });
  }
  if (chunkIndex >= upload.total_chunks) {
    return res.status(400).json({ error: `chunkIndex out of range (0-${upload.total_chunks - 1})` });
  }

  const expectedSize = expectedChunkSize(
    chunkIndex,
    upload.total_chunks,
    Number(upload.chunk_size),
    Number(upload.total_size)
  );

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength && declaredLength !== expectedSize) {
    return res.status(400).json({
      error: 'Chunk size mismatch (Content-Length header)',
      expectedBytes: expectedSize,
      declaredBytes: declaredLength,
    });
  }

  fs.mkdirSync(uploadChunkDir(uploadId), { recursive: true });
  const partPath = chunkPartPath(uploadId, chunkIndex);
  const tempPath = `${partPath}.tmp-${process.pid}-${Date.now()}`;
  const writeStream = fs.createWriteStream(tempPath);

  const hash = crypto.createHash('sha256');
  let receivedBytes = 0;
  let aborted = false;

  const counter = new PassThrough();
  counter.on('data', (chunk) => {
    receivedBytes += chunk.length;
    hash.update(chunk);
    if (receivedBytes > expectedSize) {
      // Guard against a client sending more bytes than the declared chunk
      // size (protects disk from being filled by a malformed/malicious request).
      aborted = true;
      counter.destroy(new Error('Chunk exceeds expected size'));
    }
  });

  try {
    await pipeline(req, counter, writeStream);
  } catch (err) {
    fs.unlink(tempPath, () => {});
    const status = aborted ? 400 : 400;
    return res.status(status).json({ error: 'Failed to receive chunk', details: err.message });
  }

  if (receivedBytes !== expectedSize) {
    fs.unlink(tempPath, () => {});
    return res.status(400).json({
      error: 'Chunk size mismatch',
      expectedBytes: expectedSize,
      receivedBytes,
    });
  }

  const computedChecksum = hash.digest('hex');
  const clientChecksum = req.headers['x-chunk-checksum'];
  if (clientChecksum && String(clientChecksum).toLowerCase() !== computedChecksum) {
    fs.unlink(tempPath, () => {});
    return res.status(400).json({
      error: 'Chunk checksum mismatch',
      expected: clientChecksum,
      computed: computedChecksum,
    });
  }

  // Atomic move into its final slot - this is also what makes a duplicate
  // resend of the same chunkIndex safe: it just replaces the file cleanly.
  fs.renameSync(tempPath, partPath);

  await pool.query(
    `INSERT INTO upload_chunks (upload_id, chunk_index, size_bytes, checksum)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (upload_id, chunk_index)
     DO UPDATE SET size_bytes = EXCLUDED.size_bytes, checksum = EXCLUDED.checksum, received_at = now()`,
    [uploadId, chunkIndex, receivedBytes, computedChecksum]
  );

  if (upload.status === 'initiated') {
    await pool.query(`UPDATE uploads SET status = 'uploading' WHERE id = $1`, [uploadId]);
  }

  res.status(200).json({
    uploadId,
    chunkIndex,
    receivedBytes,
    checksum: computedChecksum,
  });
}

/**
 * GET /uploads/:uploadId/status
 * Reports which chunks have been received and which are still missing,
 * so a client can resume by only re-sending the missing ones.
 */
async function getStatus(req, res) {
  const { uploadId } = req.params;
  if (!isUuid(uploadId)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [uploadId]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  const { rows: chunkRows } = await pool.query(
    'SELECT chunk_index, size_bytes FROM upload_chunks WHERE upload_id = $1 ORDER BY chunk_index ASC',
    [uploadId]
  );

  const uploadedChunks = chunkRows.map((r) => r.chunk_index);
  const uploadedSet = new Set(uploadedChunks);
  const missingChunks = [];
  for (let i = 0; i < upload.total_chunks; i += 1) {
    if (!uploadedSet.has(i)) missingChunks.push(i);
  }

  const uploadedBytes = chunkRows.reduce((sum, r) => sum + Number(r.size_bytes), 0);
  const totalBytes = Number(upload.total_size);

  res.json({
    uploadId,
    fileName: upload.file_name,
    status: upload.status,
    chunkSize: Number(upload.chunk_size),
    totalChunks: upload.total_chunks,
    uploadedChunks,
    missingChunks,
    uploadedBytes,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0,
  });
}

/**
 * POST /uploads/:uploadId/complete
 * Validates every chunk is present, contiguous, and correctly sized, then
 * streams them together (in order) into the final assembled file.
 * Verifies total size (and checksum, if one was supplied at initiate time)
 * before marking the upload completed.
 */
async function completeUpload(req, res) {
  const { uploadId } = req.params;
  if (!isUuid(uploadId)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [uploadId]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  if (upload.status === 'completed') {
    return res.status(200).json({
      uploadId,
      status: 'completed',
      message: 'Upload was already completed',
      finalPath: upload.final_storage_path,
    });
  }
  if (upload.status === 'aborted') {
    return res.status(409).json({ error: 'Upload session was aborted' });
  }

  const { rows: chunkRows } = await pool.query(
    'SELECT chunk_index, size_bytes FROM upload_chunks WHERE upload_id = $1 ORDER BY chunk_index ASC',
    [uploadId]
  );

  const totalChunks = upload.total_chunks;

  if (chunkRows.length !== totalChunks) {
    const received = new Set(chunkRows.map((r) => r.chunk_index));
    const missing = [];
    for (let i = 0; i < totalChunks; i += 1) if (!received.has(i)) missing.push(i);
    return res.status(400).json({
      error: 'Upload incomplete: missing chunks',
      missingChunks: missing,
      receivedChunks: chunkRows.length,
      totalChunks,
    });
  }

  // Validate contiguous 0..N-1 sequence and correct per-chunk sizes
  for (let i = 0; i < totalChunks; i += 1) {
    const row = chunkRows[i];
    if (row.chunk_index !== i) {
      return res.status(400).json({ error: `Chunk sequence broken at index ${i}` });
    }
    const expected = expectedChunkSize(i, totalChunks, Number(upload.chunk_size), Number(upload.total_size));
    if (Number(row.size_bytes) !== expected) {
      return res.status(400).json({
        error: `Chunk ${i} has an incorrect recorded size`,
        expectedBytes: expected,
        actualBytes: Number(row.size_bytes),
      });
    }
  }

  const partPaths = [];
  for (let i = 0; i < totalChunks; i += 1) {
    const p = chunkPartPath(uploadId, i);
    if (!fs.existsSync(p)) {
      return res.status(400).json({ error: `Chunk file missing on disk for index ${i}; please re-upload that chunk` });
    }
    partPaths.push(p);
  }

  fs.mkdirSync(COMPLETED_DIR, { recursive: true });
  const destPath = completedFilePath(uploadId, upload.extension);

  try {
    await assembleChunks(partPaths, destPath);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to assemble file', details: err.message });
  }

  const stat = fs.statSync(destPath);
  if (stat.size !== Number(upload.total_size)) {
    fs.unlink(destPath, () => {});
    return res.status(500).json({
      error: 'Assembled file size does not match declared total size',
      expectedBytes: Number(upload.total_size),
      actualBytes: stat.size,
    });
  }

  if (upload.checksum) {
    const actualChecksum = await sha256File(destPath);
    if (actualChecksum !== String(upload.checksum).toLowerCase()) {
      fs.unlink(destPath, () => {});
      return res.status(500).json({
        error: 'Assembled file checksum mismatch',
        expected: upload.checksum,
        actual: actualChecksum,
      });
    }
  }

  await pool.query(
    `UPDATE uploads SET status = 'completed', final_storage_path = $1, completed_at = now() WHERE id = $2`,
    [destPath, uploadId]
  );

  // Chunk parts are no longer needed once assembled into the final file
  fs.rm(uploadChunkDir(uploadId), { recursive: true, force: true }, () => {});

  res.status(200).json({
    uploadId,
    status: 'completed',
    fileName: upload.file_name,
    size: stat.size,
    finalPath: destPath,
  });
}

/**
 * DELETE /uploads/:uploadId
 * Cancels/cleans up an upload session: removes chunk parts, the assembled
 * file (if any), and the DB rows (upload_chunks cascade-deletes).
 */
async function deleteUpload(req, res) {
  const { uploadId } = req.params;
  if (!isUuid(uploadId)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [uploadId]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  fs.rm(uploadChunkDir(uploadId), { recursive: true, force: true }, () => {});
  if (upload.final_storage_path && fs.existsSync(upload.final_storage_path)) {
    fs.unlink(upload.final_storage_path, () => {});
  }

  await pool.query('DELETE FROM uploads WHERE id = $1', [uploadId]);

  res.status(200).json({ message: 'Upload session deleted', uploadId });
}

module.exports = {
  initiateUpload,
  uploadChunk,
  getStatus,
  completeUpload,
  deleteUpload,
};
