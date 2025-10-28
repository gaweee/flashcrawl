import { performance } from 'perf_hooks';
import { logger } from './logger.js';
import { statusTracker } from './statusTracker.js';
import { constants } from './config.js';
import { formatError } from './errors.js';

let watchdogTimer;

const startWatchdog = () => {
  if (watchdogTimer) {
    return;
  }

  let lastTick = performance.now();

  watchdogTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - lastTick;
    const lag = drift - constants.WATCHDOG_INTERVAL_MS;

    if (lag > constants.WATCHDOG_THRESHOLD_MS) {
      statusTracker.noteWatchdogLag(lag);
      logger.warn(`[watchdog] Event loop lag detected: ${lag.toFixed(0)}ms`);
    }

    lastTick = now;
  }, constants.WATCHDOG_INTERVAL_MS);

  watchdogTimer.unref?.();
};

const stopWatchdog = () => {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  }
};

export { startWatchdog, stopWatchdog };
