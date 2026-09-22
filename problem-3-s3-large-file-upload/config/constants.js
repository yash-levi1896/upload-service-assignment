// S3 hard limits (not configurable - imposed by AWS)
const S3_MIN_PART_SIZE = 5 * 1024 * 1024; // every part except the last must be >= 5MB
const S3_MAX_PARTS = 10000;

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

const DEFAULT_PART_SIZE = Number(process.env.DEFAULT_PART_SIZE_BYTES || 10 * 1024 * 1024); // 10MB
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024 * 1024); // 5GB (S3 itself supports up to ~5TB via multipart)

const ALLOWED_MIME_TYPES = (process.env.ALLOWED_MIME_TYPES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PRESIGNED_PART_URL_EXPIRY_SECONDS = Number(process.env.PRESIGNED_PART_URL_EXPIRY_SECONDS || 15 * 60);
const PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS = Number(process.env.PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS || 60 * 60);

const UPLOAD_TTL_HOURS = Number(process.env.UPLOAD_TTL_HOURS || 24);

module.exports = {
  S3_MIN_PART_SIZE,
  S3_MAX_PARTS,
  BUCKET_NAME,
  DEFAULT_PART_SIZE,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  PRESIGNED_PART_URL_EXPIRY_SECONDS,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
  UPLOAD_TTL_HOURS,
};
