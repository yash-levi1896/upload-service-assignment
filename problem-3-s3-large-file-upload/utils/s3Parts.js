const { ListPartsCommand } = require('@aws-sdk/client-s3');
const s3 = require('../config/s3Client');

/**
 * Fetches every part S3 currently has recorded for an in-progress
 * multipart upload, following pagination (S3 returns at most 1000 parts
 * per page). This is the "source of truth" for what's actually been
 * uploaded - it's how status/resume and completion validation work
 * without us maintaining our own duplicate bookkeeping table.
 *
 * Returns an array of { PartNumber, ETag, Size, LastModified }.
 */
async function listAllParts(bucket, key, s3UploadId) {
  const parts = [];
  let partNumberMarker;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await s3.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: s3UploadId,
        PartNumberMarker: partNumberMarker,
      })
    );

    if (resp.Parts) parts.push(...resp.Parts);

    if (resp.IsTruncated) {
      partNumberMarker = resp.NextPartNumberMarker;
    } else {
      break;
    }
  }

  return parts;
}

module.exports = { listAllParts };
