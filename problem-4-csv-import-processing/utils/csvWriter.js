/**
 * RFC4180-ish CSV field escaping: wraps a field in quotes (doubling any
 * internal quotes) if it contains a comma, quote, or newline.
 */
function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvLine(fields) {
  return `${fields.map(escapeCsvField).join(',')}\n`;
}

module.exports = { escapeCsvField, toCsvLine };
