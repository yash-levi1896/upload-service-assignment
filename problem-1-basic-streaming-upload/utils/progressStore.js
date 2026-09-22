/**
 * Tracks live upload progress in memory, keyed by fileId.
 *
 * Why in-memory: while a file is still streaming to disk, its row either
 * doesn't exist yet in Postgres or its uploaded_bytes would need a DB write
 * on every chunk (too expensive at high frequency). We keep live counters
 * in memory and only persist the final state to Postgres once the upload
 * finishes (completed/failed). The status endpoint checks this store first
 * and falls back to Postgres once the entry has been cleared.
 *
 * NOTE: this is single-process state. If you scale this service horizontally
 * behind a load balancer, swap this for a shared store like Redis so that a
 * status poll can land on a different instance than the one handling the
 * upload.
 */

const store = new Map();
const CLEANUP_DELAY_MS = 5 * 60 * 1000; // keep finished entries briefly, then rely on DB

function init(id) {
  if (!store.has(id)) {
    store.set(id, {
      status: 'uploading',
      uploadedBytes: 0,
      totalBytes: null,
      originalName: null,
      mimeType: null,
      extension: null,
      error: null,
    });
  }
}

function setMeta(id, meta) {
  const entry = store.get(id) || {};
  store.set(id, { ...entry, ...meta });
}

function addBytes(id, n) {
  const entry = store.get(id);
  if (entry) entry.uploadedBytes += n;
}

function complete(id, finalSize) {
  const entry = store.get(id) || {};
  store.set(id, {
    ...entry,
    status: 'completed',
    uploadedBytes: finalSize,
    totalBytes: finalSize,
  });
  scheduleCleanup(id);
}

function fail(id, error) {
  const entry = store.get(id) || {};
  store.set(id, { ...entry, status: 'failed', error });
  scheduleCleanup(id);
}

function get(id) {
  return store.get(id) || null;
}

function remove(id) {
  store.delete(id);
}

function scheduleCleanup(id) {
  setTimeout(() => store.delete(id), CLEANUP_DELAY_MS).unref();
}

module.exports = { init, setMeta, addBytes, complete, fail, get, remove };
