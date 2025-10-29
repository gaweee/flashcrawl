import express from 'express';
import { handleCrawl } from './src/services/browserService.js';
import { config } from './src/utils/config.js';
import { logger } from './src/utils/logger.js';
import { registerErrorHandlers } from './src/utils/errors.js';

const app = express();

app.get('/', (_req, res) => {
  res.json({ status: 'OK' });
});

app.get('/crawl', handleCrawl);

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
