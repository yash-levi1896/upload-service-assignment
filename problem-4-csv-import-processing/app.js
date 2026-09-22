const express = require('express');
const fs = require('fs');

const importsRouter = require('./routes/imports');
const { UPLOAD_DIR, ERRORS_DIR } = require('./config/constants');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(ERRORS_DIR)) fs.mkdirSync(ERRORS_DIR, { recursive: true });

const app = express();

// All JSON bodies here are tiny; the CSV itself is streamed via busboy in
// the controller, never through express.json().
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/imports', importsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
