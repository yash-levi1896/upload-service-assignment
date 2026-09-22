const fs = require('fs');
const { toCsvLine } = require('./csvWriter');

/**
 * Streams error/duplicate rows straight to disk as they're found, rather
 * than accumulating them in an array - so a file with millions of bad rows
 * doesn't blow up memory. Backpressure-aware: if the internal write buffer
 * is full, writeRow() waits for 'drain' before returning.
 */
class ErrorCsvWriter {
  constructor(filePath, headerFields) {
    this.filePath = filePath;
    this.stream = fs.createWriteStream(filePath);
    this.stream.write(toCsvLine(headerFields));
    this.count = 0;
  }

  async writeRow(fields) {
    const canContinue = this.stream.write(toCsvLine(fields));
    this.count += 1;
    if (!canContinue) {
      await new Promise((resolve) => this.stream.once('drain', resolve));
    }
  }

  close() {
    return new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }
}

module.exports = ErrorCsvWriter;
