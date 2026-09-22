require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  console.log(`Problem 1 (Basic Streaming Upload) API listening on port ${PORT}`);
});

// Node's default requestTimeout (5 min) and headersTimeout can kill
// legitimate multi-gigabyte uploads on slow connections. Disable them here;
// tune with a reverse proxy (nginx/ALB) timeout instead in production.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

module.exports = server;
