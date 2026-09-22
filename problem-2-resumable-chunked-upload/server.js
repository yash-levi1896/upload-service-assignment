require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4001;

const server = app.listen(PORT, () => {
  console.log(`Problem 2 (Resumable/Chunked Upload) API listening on port ${PORT}`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

module.exports = server;
