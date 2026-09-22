// Loose but reasonable checks - tune these for your real dataset.
const PHONE_REGEX = /^\+?[0-9][0-9\-\s()]{6,19}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accepts a handful of common header spellings, case/spacing-insensitive,
// so the CSV doesn't have to use exact column names.
const HEADER_ALIASES = {
  name: ['name', 'fullname', 'customername', 'contactname'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'contactnumber'],
};

function normalizeHeaderKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Maps a raw csv-parse row (object keyed by the file's actual headers) onto
 * our normalized { name, email, phone } shape, regardless of the exact
 * column names/casing/spacing used in the source file.
 */
function mapRow(rawRow) {
  const lookup = {};
  for (const [key, value] of Object.entries(rawRow || {})) {
    lookup[normalizeHeaderKey(key)] = value;
  }

  function findField(field) {
    for (const alias of HEADER_ALIASES[field]) {
      if (lookup[alias] !== undefined) return lookup[alias];
    }
    return undefined;
  }

  return {
    name: String(findField('name') ?? '').trim(),
    email: String(findField('email') ?? '').trim(),
    phone: String(findField('phone') ?? '').trim(),
  };
}

/**
 * Field-level validation only (not duplicate detection - that happens at
 * the batch/DB level in csvProcessor.js, since it needs cross-row state).
 * Returns an array of human-readable error strings; empty = valid.
 *
 * Only `phone` is treated as strictly required, since it's the field the
 * assignment centers on (duplicate detection is phone-based). Adjust this
 * function freely if your real dataset needs stricter rules (e.g. also
 * requiring `name`).
 */
function validateRow(mapped) {
  const errors = [];

  if (!mapped.phone) {
    errors.push('Missing phone number');
  } else if (!PHONE_REGEX.test(mapped.phone)) {
    errors.push('Invalid phone number format');
  }

  if (mapped.email && !EMAIL_REGEX.test(mapped.email)) {
    errors.push('Invalid email format');
  }

  return errors;
}

module.exports = { mapRow, validateRow, normalizeHeaderKey, PHONE_REGEX, EMAIL_REGEX };
