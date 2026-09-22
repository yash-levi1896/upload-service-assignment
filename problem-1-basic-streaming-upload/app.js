const express = require('express');
const fs = require('fs');

const filesRouter = require('./routes/files');
const { UPLOAD_DIR } = require('./config/constants');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const app = express();

// Safe to use globally: express.json() only consumes the body when
// Content-Type is application/json, so it never touches our
// multipart/form-data upload stream (that's read directly via req.pipe(busboy)).
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/files', filesRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Centralized error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
