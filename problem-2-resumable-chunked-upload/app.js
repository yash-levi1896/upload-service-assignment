const express = require('express');
const fs = require('fs');

const uploadsRouter = require('./routes/uploads');
const { CHUNKS_DIR, COMPLETED_DIR } = require('./config/constants');

if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });
if (!fs.existsSync(COMPLETED_DIR)) fs.mkdirSync(COMPLETED_DIR, { recursive: true });

const app = express();

// Only kicks in for Content-Type: application/json (initiate/complete),
// so it never touches the raw application/octet-stream chunk bodies -
// those are streamed directly from req in the controller.
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/uploads', uploadsRouter);

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
