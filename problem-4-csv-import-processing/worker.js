/**
 * Run this as its OWN process, separate from server.js:
 *   npm run worker
 *
 * This is what makes "do not block the API while processing" a hard
 * guarantee rather than just a best-effort one: the API server's event
 * loop (server.js/app.js) never runs any CSV parsing, validation, or bulk
 * insert code at all. This process pulls jobs off the shared Redis queue
 * and does that work entirely on its own; a slow or even hung CSV import
 * has zero effect on the API's ability to accept new uploads or answer
 * status/metadata requests.
 *
 * In production, run one or more instances of this file (e.g. as a
 * separate container/deployment, PM2 process, or ECS service) - it scales
 * independently of the API.
 */
require('dotenv').config();
const { Worker } = require('bullmq');

const connection = require('./config/redis');
const { QUEUE_NAME } = require('./config/queue');
const { WORKER_CONCURRENCY } = require('./config/constants');
const { processImport } = require('./services/csvProcessor');

console.log(`CSV import worker starting (concurrency=${WORKER_CONCURRENCY})...`);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { importId } = job.data;
    console.log(`Processing import ${importId} (job ${job.id}, attempt ${job.attemptsMade + 1})...`);

    await processImport(importId, (counters, totalRows) => {
      const percent = totalRows ? Math.min(100, Math.round((counters.processed / totalRows) * 100)) : 0;
      job.updateProgress(percent).catch(() => {});
    });

    console.log(`Finished import ${importId}`);
  },
  { connection, concurrency: WORKER_CONCURRENCY }
);

worker.on('failed', (job, err) => {
  console.error(`Import job ${job?.id} failed:`, err.message);
});

worker.on('completed', (job) => {
  console.log(`Import job ${job.id} completed.`);
});

worker.on('error', (err) => {
  console.error('Worker error:', err.message);
});

async function shutdown() {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
