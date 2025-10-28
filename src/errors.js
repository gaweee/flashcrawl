import { logger } from './logger.js';
import { statusTracker } from './statusTracker.js';

const formatError = (value) => {
  if (value instanceof Error) {
    return value.stack || value.message || value.toString();
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const handleFatalError = (label, err) => {
  const message = formatError(err);
  logger.error(`[${label}] ${message}`);
  statusTracker.setLastError(message);
};

const registerErrorHandlers = () => {
  process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
  process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));
};

export { formatError, handleFatalError, registerErrorHandlers };
