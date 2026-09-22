/**
 * How many parts a file of `fileSize` splits into at `partSize` bytes each.
 */
function computeTotalParts(fileSize, partSize) {
  return Math.ceil(fileSize / partSize);
}

/**
 * Validates a proposed (fileSize, partSize) pair against S3's hard limits:
 *  - every part except the last must be >= minPartSize (5MB)
 *  - total part count must not exceed maxParts (10,000)
 * Returns an error message string if invalid, or null if the plan is fine.
 */
function validatePartPlan(fileSize, partSize, { minPartSize, maxParts }) {
  if (!Number.isFinite(partSize) || partSize <= 0) {
    return 'partSize must be a positive number of bytes';
  }
  if (partSize < minPartSize) {
    return `partSize must be at least ${minPartSize} bytes (S3's minimum part size, except for the final part)`;
  }

  const totalParts = computeTotalParts(fileSize, partSize);
  if (totalParts > maxParts) {
    return `This file would require ${totalParts} parts, exceeding S3's ${maxParts}-part limit; retry with a larger partSize`;
  }

  return null;
}

module.exports = { computeTotalParts, validatePartPlan };
