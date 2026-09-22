require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4002;

const server = app.listen(PORT, () => {
  console.log(`Problem 3 (S3 Large File Upload) API listening on port ${PORT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

module.exports = server;
