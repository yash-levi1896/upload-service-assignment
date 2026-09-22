const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const Busboy = require('busboy');
const { v4: uuidv4, validate: isUuid } = require('uuid');

const pool = require('../config/db');
const {
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
} = require('../config/constants');
const progressStore = require('../utils/progressStore');
const { sanitizeFilename } = require('../utils/fileHelpers');

/**
 * POST /files/upload/init
 * Optional first step: reserves a fileId the client can use so it (or a
 * dashboard on another connection) can poll GET /files/:id/status WHILE
 * the big upload below is still streaming.
 */
async function initUpload(req, res) {
  const fileId = uuidv4();
  progressStore.init(fileId);
  res.status(201).json({ fileId });
}

/**
 * POST /files/upload?fileId=<optional>
 * Content-Type: multipart/form-data, field name: "file"
 *
 * Streams the incoming multipart file part directly to disk via
 * fs.createWriteStream + stream pipeline. At no point is the whole file
 * buffered in memory - Node reads the request in small chunks, backpressure
 * is respected by pipeline(), and each chunk is written straight to disk.
 */
async function uploadFile(req, res) {
  const contentLength = Number(req.headers['content-length'] || 0);

  if (contentLength && contentLength > MAX_FILE_SIZE) {
    return res.status(413).json({ error: `File exceeds max allowed size of ${MAX_FILE_SIZE} bytes` });
  }

  let fileId = req.query.fileId;
  if (fileId && !isUuid(fileId)) {
    return res.status(400).json({ error: 'Invalid fileId supplied' });
  }
  if (!fileId) fileId = uuidv4();
  progressStore.init(fileId);

  let responded = false;
  const respondOnce = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 1 } });
  } catch (err) {
    progressStore.fail(fileId, 'Invalid multipart request');
    return res.status(400).json({ error: 'Invalid multipart request', details: err.message });
  }

  let handledFile = false;
  let rejected = false;
  let sizeLimitHit = false;
  let pipelineError = null;
  let storagePath = null;
  let originalName = null;
  let mimeType = null;
  let extension = null;
  let writeStreamPromise = null;

  function cleanupPartialFile() {
    if (storagePath && fs.existsSync(storagePath)) {
      fs.unlink(storagePath, () => {});
    }
  }

  busboy.on('file', (_fieldname, fileStream, info) => {
    handledFile = true;
    originalName = info.filename;
    mimeType = info.mimeType;
    extension = path.extname(originalName || '').toLowerCase();

    const cleanName = sanitizeFilename(originalName);
    const invalidReason = !cleanName
      ? 'Invalid or missing file name'
      : ALLOWED_EXTENSIONS.length && !ALLOWED_EXTENSIONS.includes(extension)
      ? `File extension "${extension}" is not allowed`
      : ALLOWED_MIME_TYPES.length && !ALLOWED_MIME_TYPES.includes(mimeType)
      ? `Mime type "${mimeType}" is not allowed`
      : null;

    if (invalidReason) {
      rejected = true;
      fileStream.resume(); // drain the stream so the request can complete/close cleanly
      progressStore.fail(fileId, invalidReason);
      respondOnce(400, { error: invalidReason });
      return;
    }

    const storedName = `${fileId}${extension}`;
    storagePath = path.join(UPLOAD_DIR, storedName);
    progressStore.setMeta(fileId, {
      originalName,
      mimeType,
      extension,
      totalBytes: contentLength || null,
    });

    const writeStream = fs.createWriteStream(storagePath);

    fileStream.on('data', (chunk) => progressStore.addBytes(fileId, chunk.length));

    fileStream.on('limit', () => {
      // Busboy's own fileSize limit tripped (protects against a spoofed
      // Content-Length header that understates the real file size).
      sizeLimitHit = true;
      fileStream.unpipe(writeStream);
      writeStream.destroy();
    });

    writeStreamPromise = pipeline(fileStream, writeStream).catch((err) => {
      pipelineError = err;
    });
  });

  busboy.on('error', (err) => {
    rejected = true;
    progressStore.fail(fileId, err.message);
    cleanupPartialFile();
    respondOnce(500, { error: 'Upload failed', details: err.message });
  });

  busboy.on('finish', async () => {
    if (rejected || responded) return;

    if (!handledFile) {
      return respondOnce(400, { error: 'No file provided (expected multipart field "file")' });
    }

    try {
      if (writeStreamPromise) await writeStreamPromise;

      if (sizeLimitHit) {
        cleanupPartialFile();
        progressStore.fail(fileId, 'File exceeds max allowed size');
        return respondOnce(413, { error: `File exceeds max allowed size of ${MAX_FILE_SIZE} bytes` });
      }

      if (pipelineError) throw pipelineError;

      const stats = fs.statSync(storagePath);

      await pool.query(
        `INSERT INTO files
           (id, original_name, stored_name, mime_type, extension, size_bytes, uploaded_bytes, status, storage_path)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'completed', $7)`,
        [fileId, originalName, path.basename(storagePath), mimeType, extension, stats.size, storagePath]
      );

      progressStore.complete(fileId, stats.size);
      respondOnce(201, {
        id: fileId,
        originalName,
        mimeType,
        size: stats.size,
        status: 'completed',
      });
    } catch (err) {
      cleanupPartialFile();
      progressStore.fail(fileId, err.message);
      respondOnce(500, { error: 'Failed to finalize upload', details: err.message });
    }
  });

  req.on('aborted', () => {
    rejected = true;
    progressStore.fail(fileId, 'Client aborted upload');
    cleanupPartialFile();
  });

  req.pipe(busboy);
}

/**
 * GET /files/:id/status
 * Returns live progress while uploading, else the persisted DB state.
 */
async function getStatus(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid file id' });

  const live = progressStore.get(id);
  if (live && live.status === 'uploading') {
    return res.json({
      id,
      status: 'uploading',
      uploadedBytes: live.uploadedBytes,
      totalBytes: live.totalBytes,
      percent: live.totalBytes ? Math.min(100, Math.round((live.uploadedBytes / live.totalBytes) * 100)) : null,
    });
  }

  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
  if (!rows.length) {
    if (live) {
      // Upload finished (completed/failed) but DB write itself may have failed
      return res.json({ id, status: live.status, error: live.error || null });
    }
    return res.status(404).json({ error: 'File not found' });
  }

  const row = rows[0];
  res.json({
    id: row.id,
    status: row.status,
    uploadedBytes: Number(row.uploaded_bytes),
    totalBytes: Number(row.size_bytes),
    percent: 100,
  });
}

/**
 * GET /files/:id
 * Metadata only.
 */
async function getFile(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid file id' });

  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'File not found' });

  const row = rows[0];
  res.json({
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    extension: row.extension,
    size: Number(row.size_bytes),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * GET /files/:id/download
 * Streams the file back out (supports HTTP Range requests for resumable
 * downloads / video seeking), never loads the file fully into memory.
 */
async function downloadFile(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid file id' });

  const { rows } = await pool.query("SELECT * FROM files WHERE id = $1 AND status = 'completed'", [id]);
  if (!rows.length) return res.status(404).json({ error: 'File not found' });

  const row = rows[0];
  if (!fs.existsSync(row.storage_path)) {
    return res.status(410).json({ error: 'File is missing from storage' });
  }

  const stat = fs.statSync(row.storage_path);
  const range = req.headers.range;

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.original_name)}"`);
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(row.storage_path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(row.storage_path).pipe(res);
  }
}

/**
 * DELETE /files/:id
 * Removes both the DB record and the file on disk.
 */
async function deleteFile(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid file id' });

  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'File not found' });

  const row = rows[0];
  if (fs.existsSync(row.storage_path)) {
    fs.unlink(row.storage_path, () => {});
  }
  await pool.query('DELETE FROM files WHERE id = $1', [id]);
  progressStore.remove(id);

  res.status(200).json({ message: 'File deleted', id });
}

module.exports = {
  initUpload,
  uploadFile,
  getStatus,
  getFile,
  downloadFile,
  deleteFile,
};
