const { MAX_CONCURRENT_UPLOADS } = require('../config/constants');

/**
 * Caps how many uploads can be actively streaming to disk at once.
 *
 * Streaming keeps per-request memory low, but concurrent large uploads
 * still compete for disk I/O and file descriptors. Without a cap, a burst
 * of simultaneous 5GB uploads can still starve the disk / event loop.
 * This middleware fails fast with 429 instead of accepting unbounded
 * concurrent streams.
 */
let active = 0;

function uploadLimiter(req, res, next) {
  if (active >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({
      error: 'Too many concurrent uploads in progress. Please retry shortly.',
      maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
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

module.exports = uploadLimiter;
