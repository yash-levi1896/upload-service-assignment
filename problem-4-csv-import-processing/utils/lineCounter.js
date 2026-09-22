const fs = require('fs');

/**
 * Quickly counts newline bytes in a file by scanning raw chunks - much
 * cheaper than actually parsing the CSV, since it's just byte comparison
 * with no allocation per row. Used once, up front, purely to give
 * GET /status an accurate `totalRows` for percent-complete reporting
 * before the real (much slower) parse+validate+insert pass begins.
 *
 * Trade-off: this means the file is read twice (once here, once during
 * real processing) for a 2GB CSV that's a real but modest extra cost -
 * pure sequential I/O, no parsing/allocation - compared to skipping
 * percent-progress entirely. If you'd rather avoid the double-read, you
 * can estimate totalRows from (fileSize / averageRowSize) instead, or just
 * report processedRows without a percent until the job finishes.
 */
function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let count = 0;
    let lastByte = null;

    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 0x0a) count += 1; // '\n'
      }
      if (chunk.length) lastByte = chunk[chunk.length - 1];
    });
    stream.on('end', () => {
      // If the file doesn't end with a trailing newline, its last line
      // wouldn't otherwise be counted.
      if (lastByte !== null && lastByte !== 0x0a) count += 1;
      resolve(count);
    });
    stream.on('error', reject);
  });
}

module.exports = { countLines };
