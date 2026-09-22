const express = require('express');

const uploadsRouter = require('./routes/uploads');

const app = express();

// Every request body here is small JSON (metadata + part numbers) - no
// file bytes ever pass through this server, so there's no need for a
// large body limit or a streaming body parser like in Problems 1 & 2.
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
