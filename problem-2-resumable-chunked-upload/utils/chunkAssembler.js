const fs = require('fs');
const crypto = require('crypto');

/**
 * Appends the contents of `readPath` onto an already-open `writeStream`
 * without ending the writeStream, and without buffering the whole chunk
 * file into memory - it's streamed through in the read stream's normal
 * chunk size.
 */
function appendFileToStream(readPath, writeStream) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(readPath);
    const onError = (err) => {
      readStream.destroy();
      reject(err);
    };
    readStream.on('error', onError);
    writeStream.on('error', onError);
    readStream.on('end', resolve);
    // `end: false` is critical: without it, .pipe() would close the
    // destination write stream after the FIRST chunk file finishes.
    readStream.pipe(writeStream, { end: false });
  });
}

/**
 * Sequentially concatenates chunk files (in `partPaths` order) into a
 * single output file at `destPath`. Memory usage stays flat regardless of
 * total file size, since each part is streamed through, one at a time.
 */
async function assembleChunks(partPaths, destPath) {
  const writeStream = fs.createWriteStream(destPath);

  try {
    for (const partPath of partPaths) {
      // eslint-disable-next-line no-await-in-loop
      await appendFileToStream(partPath, writeStream);
    }
  } catch (err) {
    writeStream.destroy();
    throw err;
  }

  await new Promise((resolve, reject) => {
    writeStream.end((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Computes the sha256 of a file by streaming it through, without loading
 * the whole file into memory.
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = { assembleChunks, appendFileToStream, sha256File };
