const { MAX_CONCURRENT_CHUNK_UPLOADS } = require('../config/constants');

/**
 * Caps how many chunk uploads (across all sessions) can be streaming to
 * disk at once. Chunks are small (default 10MB) so this ceiling can be
 * much higher than Problem 1's whole-file limiter, but it's still needed:
 * with many clients uploading many chunks in parallel, an unbounded number
 * of simultaneous disk writes can still degrade I/O for everyone.
 */
let active = 0;

function chunkUploadLimiter(req, res, next) {
  if (active >= MAX_CONCURRENT_CHUNK_UPLOADS) {
    return res.status(429).json({
      error: 'Too many concurrent chunk uploads in progress. Please retry shortly.',
      maxConcurrentChunkUploads: MAX_CONCURRENT_CHUNK_UPLOADS,
    });
  }

  active += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
  };

  res.on('finish', release);
  res.on('close', release);

  next();
}

module.exports = chunkUploadLimiter;
