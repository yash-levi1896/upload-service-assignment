const path = require('path');

function resolveDir(envVal, fallback) {
  const v = envVal || fallback;
  return path.isAbsolute(v) ? v : path.join(__dirname, '..', v);
}

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES || 2.5 * 1024 * 1024 * 1024); // ~2.5GB ceiling
const UPLOAD_DIR = resolveDir(process.env.UPLOAD_DIR, 'storage/uploads');
const ERRORS_DIR = resolveDir(process.env.ERRORS_DIR, 'storage/errors');

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 1000);
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 3);
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 1);

module.exports = {
  MAX_FILE_SIZE,
  UPLOAD_DIR,
  ERRORS_DIR,
  BATCH_SIZE,
  MAX_CONCURRENT_UPLOADS,
  WORKER_CONCURRENCY,
};
