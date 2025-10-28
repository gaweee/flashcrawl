import express from 'express';
import { handleCrawl } from './src/services/crawlService.js';
import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { statusTracker } from './src/statusTracker.js';
import { startWatchdog, stopWatchdog } from './src/watchdog.js';
import { registerErrorHandlers } from './src/errors.js';

const app = express();

app.get('/status', (_req, res) => {
  res.json(statusTracker.getSnapshot());
});

app.get('/crawl', handleCrawl);

registerErrorHandlers();

let serverInstance;

const startServer = (port = config.port) => {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = app.listen(port, () => {
    statusTracker.refreshSpinner({ status: 'ready' });
    startWatchdog();
    logger.info(`flashcrawl API running on port ${port}`);
    statusTracker.refreshSpinner();
  });

  serverInstance.on('error', (err) => {
    statusTracker.refreshSpinner({ status: 'starting up' });
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

  stopWatchdog();
  statusTracker.stopSpinner();
  serverInstance = undefined;
};

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app, startServer, stopServer };
