require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4003;

const server = app.listen(PORT, () => {
  console.log(`Problem 4 (CSV Import) API listening on port ${PORT}`);
  console.log('   This process only uploads + enqueues. Run the worker separately:');
  console.log('   npm run worker');
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

module.exports = server;
