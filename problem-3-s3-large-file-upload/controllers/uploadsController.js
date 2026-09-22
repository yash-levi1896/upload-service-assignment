const path = require('path');
const {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4, validate: isUuid } = require('uuid');

const s3 = require('../config/s3Client');
const pool = require('../config/db');
const {
  BUCKET_NAME,
  DEFAULT_PART_SIZE,
  S3_MIN_PART_SIZE,
  S3_MAX_PARTS,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  PRESIGNED_PART_URL_EXPIRY_SECONDS,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
  UPLOAD_TTL_HOURS,
} = require('../config/constants');
const { sanitizeFilename } = require('../utils/fileHelpers');
const { computeTotalParts, validatePartPlan } = require('../utils/partMath');
const { listAllParts } = require('../utils/s3Parts');

const TERMINAL_STATUSES = ['completed', 'aborted', 'expired'];

/**
 * POST /uploads/initiate
 * Body: { fileName, fileSize, mimeType?, partSize? }
 *
 * Validates the request, opens an S3 multipart upload (CreateMultipartUpload),
 * and stores session metadata. Every upload uses S3 multipart under the
 * hood - even a single-part "file" is just a multipart upload with one
 * part - so there's one consistent code path.
 */
async function initiateUpload(req, res) {
  if (!BUCKET_NAME) {
    return res.status(500).json({ error: 'Server misconfiguration: S3_BUCKET_NAME is not set' });
  }

  const { fileName, fileSize, mimeType, partSize } = req.body || {};

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

  const finalPartSize = Number(partSize) > 0 ? Number(partSize) : DEFAULT_PART_SIZE;
  const planError = validatePartPlan(size, finalPartSize, {
    minPartSize: S3_MIN_PART_SIZE,
    maxParts: S3_MAX_PARTS,
  });
  if (planError) return res.status(400).json({ error: planError });

  const totalParts = computeTotalParts(size, finalPartSize);
  const uploadId = uuidv4();
  const objectKey = `uploads/${uploadId}/${cleanName}`;

  let s3Response;
  try {
    s3Response = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: objectKey,
        ContentType: mimeType || 'application/octet-stream',
      })
    );
  } catch (err) {
    return res.status(502).json({ error: 'Failed to initiate S3 multipart upload', details: err.message });
  }

  const expiresAt = new Date(Date.now() + UPLOAD_TTL_HOURS * 3600 * 1000);

  await pool.query(
    `INSERT INTO uploads
       (id, file_name, mime_type, total_size, part_size, total_parts, bucket, object_key, s3_upload_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'initiated', $10)`,
    [uploadId, cleanName, mimeType || null, size, finalPartSize, totalParts, BUCKET_NAME, objectKey, s3Response.UploadId, expiresAt]
  );

  res.status(201).json({
    uploadId,
    key: objectKey,
    partSize: finalPartSize,
    totalParts,
    expiresAt,
  });
}

/**
 * POST /uploads/:id/presigned-url
 * Body: { partNumber }  (1-based, matching S3's own PartNumber convention)
 *
 * Returns a pre-signed URL the client PUTs the raw bytes of that part to,
 * directly against S3 - this request never touches our server's bandwidth.
 * Safe to call again for the same partNumber (e.g. after a failed PUT or
 * an expired URL): S3 just overwrites that part slot, so this doubles as
 * the "resume a failed part" mechanism with no extra logic needed.
 */
async function getPresignedPartUrl(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid upload id' });

  const partNumber = Number(req.body?.partNumber);
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return res.status(400).json({ error: 'partNumber is required in the body and must be an integer >= 1' });
  }

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  if (TERMINAL_STATUSES.includes(upload.status)) {
    return res.status(409).json({ error: `Upload session is already ${upload.status}` });
  }
  if (partNumber > upload.total_parts) {
    return res.status(400).json({ error: `partNumber out of range (1-${upload.total_parts})` });
  }

  let url;
  try {
    const command = new UploadPartCommand({
      Bucket: upload.bucket,
      Key: upload.object_key,
      UploadId: upload.s3_upload_id,
      PartNumber: partNumber,
    });
    url = await getSignedUrl(s3, command, { expiresIn: PRESIGNED_PART_URL_EXPIRY_SECONDS });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to generate presigned URL', details: err.message });
  }

  if (upload.status === 'initiated') {
    await pool.query(`UPDATE uploads SET status = 'uploading' WHERE id = $1`, [id]);
  }

  res.status(200).json({
    uploadId: id,
    partNumber,
    url,
    method: 'PUT',
    expiresIn: PRESIGNED_PART_URL_EXPIRY_SECONDS,
    note:
      'PUT the raw bytes of this part to the URL above. You do not need to report the ETag back to this API - ' +
      '/complete reads the authoritative, final part list directly from S3.',
  });
}

/**
 * GET /uploads/:id/status
 * Asks S3 (via ListParts) which parts have actually landed, so the client
 * can resume by requesting presigned URLs only for the missing part numbers.
 */
async function getStatus(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  if (upload.status === 'completed') {
    return res.json({
      uploadId: id,
      status: 'completed',
      totalParts: upload.total_parts,
      uploadedParts: upload.total_parts,
      missingParts: [],
      uploadedBytes: Number(upload.total_size),
      totalBytes: Number(upload.total_size),
      percent: 100,
    });
  }
  if (upload.status === 'aborted' || upload.status === 'expired') {
    return res.json({ uploadId: id, status: upload.status });
  }

  let parts;
  try {
    parts = await listAllParts(upload.bucket, upload.object_key, upload.s3_upload_id);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch part status from S3', details: err.message });
  }

  const uploadedPartNumbers = parts.map((p) => p.PartNumber).sort((a, b) => a - b);
  const uploadedSet = new Set(uploadedPartNumbers);
  const missingParts = [];
  for (let i = 1; i <= upload.total_parts; i += 1) {
    if (!uploadedSet.has(i)) missingParts.push(i);
  }

  const uploadedBytes = parts.reduce((sum, p) => sum + (p.Size || 0), 0);
  const totalBytes = Number(upload.total_size);

  res.json({
    uploadId: id,
    status: upload.status,
    totalParts: upload.total_parts,
    uploadedParts: uploadedPartNumbers,
    missingParts,
    uploadedBytes,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0,
  });
}

/**
 * POST /uploads/:id/complete
 *
 * Re-fetches the definitive part list from S3 (ListParts), validates every
 * part 1..totalParts is present, then calls CompleteMultipartUpload with
 * that exact list. The client never has to collect/report ETags itself.
 */
async function completeUpload(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  if (upload.status === 'completed') {
    return res.status(200).json({
      uploadId: id,
      status: 'completed',
      message: 'Upload was already completed',
      location: upload.final_location,
    });
  }
  if (upload.status === 'aborted' || upload.status === 'expired') {
    return res.status(409).json({ error: `Upload session is ${upload.status}` });
  }

  let parts;
  try {
    parts = await listAllParts(upload.bucket, upload.object_key, upload.s3_upload_id);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch parts from S3', details: err.message });
  }

  if (parts.length !== upload.total_parts) {
    const uploadedSet = new Set(parts.map((p) => p.PartNumber));
    const missing = [];
    for (let i = 1; i <= upload.total_parts; i += 1) if (!uploadedSet.has(i)) missing.push(i);
    return res.status(400).json({
      error: 'Upload incomplete: missing parts',
      missingParts: missing,
      receivedParts: parts.length,
      totalParts: upload.total_parts,
    });
  }

  const orderedParts = parts
    .slice()
    .sort((a, b) => a.PartNumber - b.PartNumber)
    .map((p) => ({ ETag: p.ETag, PartNumber: p.PartNumber }));

  let completeResp;
  try {
    completeResp = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: upload.bucket,
        Key: upload.object_key,
        UploadId: upload.s3_upload_id,
        MultipartUpload: { Parts: orderedParts },
      })
    );
  } catch (err) {
    return res.status(502).json({ error: 'Failed to complete S3 multipart upload', details: err.message });
  }

  await pool.query(
    `UPDATE uploads
       SET status = 'completed', final_location = $1, final_etag = $2, completed_at = now()
     WHERE id = $3`,
    [completeResp.Location || null, completeResp.ETag || null, id]
  );

  res.status(200).json({
    uploadId: id,
    status: 'completed',
    key: upload.object_key,
    location: completeResp.Location,
    etag: completeResp.ETag,
  });
}

/**
 * GET /uploads/:id/download-url
 * Only valid once the upload is completed (the object doesn't exist in S3
 * until CompleteMultipartUpload has run).
 */
async function getDownloadUrl(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  if (upload.status !== 'completed') {
    return res.status(409).json({ error: `File is not available for download (status: ${upload.status})` });
  }

  let url;
  try {
    const command = new GetObjectCommand({ Bucket: upload.bucket, Key: upload.object_key });
    url = await getSignedUrl(s3, command, { expiresIn: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to generate download URL', details: err.message });
  }

  res.status(200).json({
    uploadId: id,
    url,
    expiresIn: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
    fileName: upload.file_name,
  });
}

/**
 * DELETE /uploads/:id
 * Aborts the S3 multipart upload (releasing any already-uploaded parts, so
 * you're not billed for orphaned part storage) or deletes the completed
 * object, then removes the DB record.
 */
async function deleteUpload(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid upload id' });

  const { rows } = await pool.query('SELECT * FROM uploads WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Upload session not found' });
  const upload = rows[0];

  try {
    if (upload.status === 'completed') {
      await s3.send(new DeleteObjectCommand({ Bucket: upload.bucket, Key: upload.object_key }));
    } else if (!TERMINAL_STATUSES.includes(upload.status)) {
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: upload.bucket,
          Key: upload.object_key,
          UploadId: upload.s3_upload_id,
        })
      );
    }
  } catch (err) {
    // Not fatal to the DB cleanup below, but worth surfacing: the bucket's
    // "AbortIncompleteMultipartUpload" lifecycle rule (see README) is the
    // recommended backstop for exactly this kind of failure.
    console.error(`Failed to clean up S3 resources for upload ${id}:`, err.message);
  }

  await pool.query('DELETE FROM uploads WHERE id = $1', [id]);

  res.status(200).json({ message: 'Upload session deleted', uploadId: id });
}

module.exports = {
  initiateUpload,
  getPresignedPartUrl,
  getStatus,
  completeUpload,
  getDownloadUrl,
  deleteUpload,
};
