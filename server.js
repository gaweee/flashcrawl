import express from 'express';
import { handleCrawl } from './src/services/browserService.js';
import { config } from './src/utils/config.js';
import { logger } from './src/utils/logger.js';
import { registerErrorHandlers, formatError } from './src/utils/errors.js';

const app = express();

app.get('/', (_req, res) => {
  res.json({ status: 'OK' });
});

// wrapper to ensure async errors are forwarded to Express error middleware
const wrapAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/crawl', wrapAsync(handleCrawl));

// 404 handler (JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// JSON error handler
app.use((err, req, res, next) => {
  try {
    logger.error(`[express] ${formatError(err)}`);
  } catch (_) {}
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal Server Error', details: String(err?.message ?? err) });
});

registerErrorHandlers();

let serverInstance;

const startServer = (port = config.port) => {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = app.listen(port, () => {
    logger.info(`[server] listening on ${port}`);
  });

  serverInstance.on('error', (err) => {
    logger.error(`[server-start] ${err.message ?? err}`);
    process.exitCode = 1;
  });

  return serverInstance;
};

const stopServer = async () => {
  if (!serverInstance) {
    return;
  }

  await new Promise((resolve, reject) => {
    serverInstance.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  // spinner removed; nothing to stop
  serverInstance = undefined;
};

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app, startServer, stopServer };
