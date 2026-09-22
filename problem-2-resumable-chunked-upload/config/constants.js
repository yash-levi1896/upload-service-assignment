const path = require('path');

function resolveDir(envVal, fallback) {
  const v = envVal || fallback;
  return path.isAbsolute(v) ? v : path.join(__dirname, '..', v);
}

const DEFAULT_CHUNK_SIZE = Number(process.env.DEFAULT_CHUNK_SIZE_BYTES || 10 * 1024 * 1024); // 10MB
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024 * 1024); // 5GB

const CHUNKS_DIR = resolveDir(process.env.CHUNKS_DIR, 'storage/chunks');
const COMPLETED_DIR = resolveDir(process.env.COMPLETED_DIR, 'storage/completed');

const ALLOWED_MIME_TYPES = (process.env.ALLOWED_MIME_TYPES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_CONCURRENT_CHUNK_UPLOADS = Number(process.env.MAX_CONCURRENT_CHUNK_UPLOADS || 20);
const STALE_UPLOAD_HOURS = Number(process.env.STALE_UPLOAD_HOURS || 24);

module.exports = {
  DEFAULT_CHUNK_SIZE,
  MAX_FILE_SIZE,
  CHUNKS_DIR,
  COMPLETED_DIR,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_CONCURRENT_CHUNK_UPLOADS,
  STALE_UPLOAD_HOURS,
};
