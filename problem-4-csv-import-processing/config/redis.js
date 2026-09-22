const IORedis = require('ioredis');

/**
 * A single shared ioredis connection, used by both the Queue (API process)
 * and the Worker (worker process) sides of BullMQ.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ - without it, ioredis
 * will give up retrying blocking commands (which BullMQ relies on) after a
 * few attempts and BullMQ's internals will throw.
 */
const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

connection.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

module.exports = connection;
