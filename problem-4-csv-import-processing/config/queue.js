const { Queue } = require('bullmq');
const connection = require('./redis');

const QUEUE_NAME = 'csv-imports';

/**
 * Created once and reused - both the API (to `.add()` jobs) and the
 * worker (to construct its `Worker` on the same queue name) import this.
 */
const importQueue = new Queue(QUEUE_NAME, { connection });

module.exports = { importQueue, QUEUE_NAME };
