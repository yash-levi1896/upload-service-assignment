const path = require('path');

/**
 * Strips directory components and rejects dangerous / empty / overly long names.
 * Returns null if the name is invalid.
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return null;

  const base = path.basename(name).trim();

  if (!base || base === '.' || base === '..') return null;
  if (base.length > 255) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(base)) return null;

  return base;
}

module.exports = { sanitizeFilename };
