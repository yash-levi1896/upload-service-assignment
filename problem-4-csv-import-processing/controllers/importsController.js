const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const Busboy = require('busboy');
const { v4: uuidv4, validate: isUuid } = require('uuid');

const pool = require('../config/db');
const { importQueue } = require('../config/queue');
const { UPLOAD_DIR, MAX_FILE_SIZE } = require('../config/constants');
const { sanitizeFilename } = require('../utils/fileHelpers');

const ALLOWED_EXTENSIONS = ['.csv'];

/**
 * POST /imports
 * Content-Type: multipart/form-data, field name: "file"
 *
 * Streams the CSV to disk (same memory-safe pattern as Problem 1 - never
 * buffers the file in RAM), records it, and enqueues a BullMQ job. This
 * handler returns as soon as the file is safely on disk and the job is
 * queued - it does NOT wait for processing, which is exactly what makes
 * this non-blocking. A 202 Accepted communicates that explicitly.
 */
async function createImport(req, res) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength && contentLength > MAX_FILE_SIZE) {
    return res.status(413).json({ error: `File exceeds max allowed size of ${MAX_FILE_SIZE} bytes` });
  }

  const importId = uuidv4();
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
    return res.status(400).json({ error: 'Invalid multipart request', details: err.message });
  }

  let handledFile = false;
  let rejected = false;
  let sizeLimitHit = false;
  let pipelineError = null;
  let storagePath = null;
  let originalName = null;
  let mimeType = null;
  let writeStreamPromise = null;

  function cleanupPartialFile() {
    if (storagePath && fs.existsSync(storagePath)) fs.unlink(storagePath, () => {});
  }

  busboy.on('file', (_field, fileStream, info) => {
    handledFile = true;
    originalName = info.filename;
    mimeType = info.mimeType;
    const extension = path.extname(originalName || '').toLowerCase();

    const cleanName = sanitizeFilename(originalName);
    const invalidReason = !cleanName
      ? 'Invalid or missing file name'
      : !ALLOWED_EXTENSIONS.includes(extension)
      ? `Only .csv files are accepted (got "${extension || 'no extension'}")`
      : null;
    // Deliberately not hard-rejecting on declared mime type: browsers/OSes
    // are inconsistent about what they send for CSVs (text/csv,
    // application/vnd.ms-excel, text/plain all show up in practice). The
    // extension check plus the real CSV parse in the worker is the actual gate.

    if (invalidReason) {
      rejected = true;
      fileStream.resume();
      respondOnce(400, { error: invalidReason });
      return;
    }

    const storedName = `${importId}${extension}`;
    storagePath = path.join(UPLOAD_DIR, storedName);
    const writeStream = fs.createWriteStream(storagePath);

    fileStream.on('limit', () => {
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
        return respondOnce(413, { error: `File exceeds max allowed size of ${MAX_FILE_SIZE} bytes` });
      }
      if (pipelineError) throw pipelineError;

      const stats = fs.statSync(storagePath);

      await pool.query(
        `INSERT INTO imports (id, original_filename, stored_path, size_bytes, mime_type, status)
         VALUES ($1, $2, $3, $4, $5, 'UPLOADED')`,
        [importId, originalName, storagePath, stats.size, mimeType]
      );

      // Enqueue and return immediately - a separate worker process (see
      // worker.js) picks this up whenever it's free. attempts+backoff give
      // resilience against transient DB/Redis hiccups; because inserts use
      // ON CONFLICT (phone) DO NOTHING, a retried job is safe to re-run
      // from scratch (see services/csvProcessor.js for why).
      await importQueue.add(
        'process-import',
        { importId },
        {
          jobId: importId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 500,
          removeOnFail: 500,
        }
      );

      respondOnce(202, {
        id: importId,
        originalFilename: originalName,
        size: stats.size,
        status: 'UPLOADED',
        message: 'File uploaded successfully. Processing has been queued and will run in the background.',
      });
    } catch (err) {
      cleanupPartialFile();
      respondOnce(500, { error: 'Failed to register import', details: err.message });
    }
  });

  req.on('aborted', () => {
    rejected = true;
    cleanupPartialFile();
  });

  req.pipe(busboy);
}

/**
 * GET /imports/:id/status
 * Lightweight polling endpoint - just the progress counters.
 */
async function getStatus(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid import id' });

  const { rows } = await pool.query('SELECT * FROM imports WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  const row = rows[0];

  const totalRows = row.total_rows;
  const processedRows = row.processed_rows;
  const percent = totalRows
    ? Math.min(100, Math.round((processedRows / totalRows) * 100))
    : row.status === 'COMPLETED'
    ? 100
    : 0;

  res.json({
    id: row.id,
    status: row.status,
    totalRows,
    processedRows,
    validRows: row.valid_rows,
    invalidRows: row.invalid_rows,
    duplicateRows: row.duplicate_rows,
    percent,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
  });
}

/**
 * GET /imports/:id
 * Full metadata about the import.
 */
async function getImport(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid import id' });

  const { rows } = await pool.query('SELECT * FROM imports WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  const row = rows[0];

  res.json({
    id: row.id,
    originalFilename: row.original_filename,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    status: row.status,
    totalRows: row.total_rows,
    processedRows: row.processed_rows,
    validRows: row.valid_rows,
    invalidRows: row.invalid_rows,
    duplicateRows: row.duplicate_rows,
    hasErrorFile: !!row.error_file_path && fs.existsSync(row.error_file_path),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
  });
}

/**
 * GET /imports/:id/errors
 * Streams the generated error CSV (invalid rows + duplicate phone numbers,
 * each with a reason) back to the client.
 */
async function getErrorsFile(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid import id' });

  const { rows } = await pool.query('SELECT * FROM imports WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  const row = rows[0];

  if (!row.error_file_path || !fs.existsSync(row.error_file_path)) {
    const stillRunning = row.status === 'UPLOADED' || row.status === 'PROCESSING';
    return res.status(404).json({
      error: stillRunning
        ? 'Import is still processing; the error file is not ready yet'
        : 'No error file available (no invalid or duplicate records were found)',
    });
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="import-${id}-errors.csv"`);
  fs.createReadStream(row.error_file_path).pipe(res);
}

/**
 * DELETE /imports/:id
 * Removes the DB record and both files. If the job hasn't started yet,
 * also removes it from the queue. If it's already running, the worker
 * itself notices the row is gone (checked once per batch in
 * csvProcessor.js) and stops early rather than continuing to insert data
 * for a deleted import.
 */
async function deleteImport(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid import id' });

  const { rows } = await pool.query('SELECT * FROM imports WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  const row = rows[0];

  try {
    const job = await importQueue.getJob(id);
    if (job) {
      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed') {
        await job.remove();
      }
    }
  } catch (err) {
    console.error(`Failed to remove queued job for import ${id}:`, err.message);
  }

  if (row.stored_path && fs.existsSync(row.stored_path)) fs.unlink(row.stored_path, () => {});
  if (row.error_file_path && fs.existsSync(row.error_file_path)) fs.unlink(row.error_file_path, () => {});

  await pool.query('DELETE FROM imports WHERE id = $1', [id]);

  res.status(200).json({ message: 'Import deleted', id });
}

module.exports = {
  createImport,
  getStatus,
  getImport,
  getErrorsFile,
  deleteImport,
};
