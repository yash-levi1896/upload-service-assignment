/**
 * Finds upload sessions that were initiated but never completed within
 * UPLOAD_TTL_HOURS, aborts the corresponding S3 multipart upload (so its
 * already-uploaded parts stop costing storage), and marks the session
 * 'expired' in the DB.
 *
 * Run this periodically via cron / a scheduled Lambda / etc:
 *   npm run cleanup:expired
 *
 * IMPORTANT: also configure this as a backstop, not your only defense -
 * add an S3 bucket lifecycle rule with "AbortIncompleteMultipartUpload"
 * (e.g. after 1-2 days). That rule runs inside S3 itself and will clean up
 * abandoned multipart uploads even if this script/cron job is never
 * deployed, crashes, or this whole service is decommissioned later.
 */
require('dotenv').config();
const { AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const pool = require('../config/db');
const s3 = require('../config/s3Client');

async function cleanupExpired() {
  const { rows } = await pool.query(
    `SELECT * FROM uploads WHERE status IN ('initiated', 'uploading') AND expires_at < now()`
  );

  if (!rows.length) {
    console.log('No expired uploads to clean up.');
    return;
  }

  for (const upload of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: upload.bucket,
          Key: upload.object_key,
          UploadId: upload.s3_upload_id,
        })
      );
    } catch (err) {
      console.error(`Failed to abort S3 multipart upload for ${upload.id}:`, err.message);
      // Continue anyway - the bucket lifecycle rule mentioned above is the
      // backstop for exactly this situation.
    }

    // eslint-disable-next-line no-await-in-loop
    await pool.query(`UPDATE uploads SET status = 'expired' WHERE id = $1`, [upload.id]);
    console.log(`Expired upload ${upload.id} (${upload.file_name})`);
  }

  console.log(`Expired ${rows.length} abandoned upload session(s).`);
}

cleanupExpired()
  .catch((err) => {
    console.error('Cleanup failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
