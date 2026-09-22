/**
 * Deletes upload sessions (and their chunk files) that were initiated but
 * never completed within STALE_UPLOAD_HOURS. Run this periodically via cron
 * or a scheduled job if you want to reclaim disk space from abandoned
 * uploads.
 *
 * Usage: node db/cleanupStale.js
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('../config/db');
const { STALE_UPLOAD_HOURS } = require('../config/constants');
const { uploadChunkDir } = require('../utils/uploadPaths');

async function cleanupStale() {
  const { rows } = await pool.query(
    `SELECT id FROM uploads
     WHERE status IN ('initiated', 'uploading')
       AND updated_at < now() - ($1 || ' hours')::interval`,
    [STALE_UPLOAD_HOURS]
  );

  if (!rows.length) {
    console.log('No stale uploads to clean up.');
    return;
  }

  for (const row of rows) {
    fs.rmSync(uploadChunkDir(row.id), { recursive: true, force: true });
    // eslint-disable-next-line no-await-in-loop
    await pool.query('DELETE FROM uploads WHERE id = $1', [row.id]);
    console.log(`Cleaned up stale upload ${row.id}`);
  }

  console.log(`Cleaned up ${rows.length} stale upload session(s).`);
}

cleanupStale()
  .catch((err) => {
    console.error('Cleanup failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
