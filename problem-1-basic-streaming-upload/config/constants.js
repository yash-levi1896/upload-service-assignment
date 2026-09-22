const path = require('path');

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024 * 1024); // 5GB default

const UPLOAD_DIR = path.isAbsolute(process.env.UPLOAD_DIR || '')
  ? process.env.UPLOAD_DIR
  : path.join(__dirname, '..', process.env.UPLOAD_DIR || 'storage/uploads');

const ALLOWED_MIME_TYPES = (process.env.ALLOWED_MIME_TYPES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 5);

module.exports = {
  MAX_FILE_SIZE,
  UPLOAD_DIR,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_CONCURRENT_UPLOADS,
};
