const { MAX_CONCURRENT_UPLOADS } = require('../config/constants');

/**
 * Caps how many CSV uploads can be actively streaming to disk at once.
 * The heavy processing work happens in a separate worker process (so it
 * can never block the API), but the upload itself still competes for disk
 * I/O, so this stays useful for files in the 500MB-2GB range.
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
