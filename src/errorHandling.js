import { logger } from './logger.js';
import { statusTracker } from './statusTracker.js';
import { formatError } from './utils/errors.js';

const handleFatalError = (label, err) => {
  const message = formatError(err);
  logger.error(`[${label}] ${message}`);
  statusTracker.setLastError(message);
};

process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));

export { handleFatalError };
