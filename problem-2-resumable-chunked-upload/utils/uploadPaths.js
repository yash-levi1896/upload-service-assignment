const path = require('path');
const { CHUNKS_DIR, COMPLETED_DIR } = require('../config/constants');

function uploadChunkDir(uploadId) {
  return path.join(CHUNKS_DIR, uploadId);
}

function chunkPartPath(uploadId, chunkIndex) {
  return path.join(uploadChunkDir(uploadId), `${chunkIndex}.part`);
}

function completedFilePath(uploadId, extension) {
  return path.join(COMPLETED_DIR, `${uploadId}${extension || ''}`);
}

/**
 * The last chunk is typically smaller than chunkSize (whatever bytes
 * remain). All other chunks must equal chunkSize exactly.
 */
function expectedChunkSize(chunkIndex, totalChunks, chunkSize, totalSize) {
  if (chunkIndex === totalChunks - 1) {
    const remainder = totalSize - chunkSize * (totalChunks - 1);
    return remainder;
  }
  return chunkSize;
}

module.exports = {
  uploadChunkDir,
  chunkPartPath,
  completedFilePath,
  expectedChunkSize,
};
