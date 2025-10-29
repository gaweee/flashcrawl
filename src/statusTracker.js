import chalk from 'chalk';
import ora from 'ora';

const statusNotes = {
  startTime: Date.now(),
  totalCrawls: 0,
  successfulCrawls: 0,
  failedCrawls: 0,
  lastCrawlAt: null,
  lastStatusCode: null,
  lastError: null,
  lastWatchdogWarning: null,
  lastEventLoopLagMs: 0,
  pdfAttempts: 0,
  pdfConversions: 0,
  pdfConversionFailures: 0,
  spinnerStatus: 'starting up',
  lastUrl: '—',
};

const spinnerState = {
  status: 'starting up',
  lastUrl: '—',
};

const statusSpinner = process.stdout.isTTY ? ora({ spinner: 'dots', color: 'cyan' }) : null;

const STATUS_COLORS = {
  'starting up': chalk.yellow,
  ready: chalk.green,
  active: chalk.cyan,
};

const formatStatusLabel = (status) => {
  const colorizer = STATUS_COLORS[status] ?? chalk.white;
  return colorizer(`[${status}]`);
};

const formatStatsText = () => {
  const totalOps = statusNotes.totalCrawls + statusNotes.pdfAttempts;
  const totalText = chalk.blue(`total ${totalOps}`);
  const htmlText = chalk.green(`html ${statusNotes.totalCrawls}`);
  const pdfText = chalk.magenta(`pdf ${statusNotes.pdfAttempts}`);
  const failedCount = statusNotes.failedCrawls + statusNotes.pdfConversionFailures;
  const failedText = chalk.red(`failed ${failedCount}`);
  return `${totalText} | ${htmlText} | ${pdfText} | ${failedText}`;
};

const refreshSpinner = ({ status, url } = {}) => {
  if (status) {
    spinnerState.status = status;
  }
  if (url !== undefined) {
    spinnerState.lastUrl = url || '—';
  }

  statusNotes.spinnerStatus = spinnerState.status;
  statusNotes.lastUrl = spinnerState.lastUrl;

  if (!statusSpinner) {
    return;
  }

  const statusLabel = formatStatusLabel(spinnerState.status);
  const urlText = chalk.gray(spinnerState.lastUrl || '—');
  const statsText = formatStatsText();

  statusSpinner.text = `${statusLabel} ${urlText} ${chalk.dim('........')} ${statsText}`;

  if (!statusSpinner.isSpinning) {
    statusSpinner.start();
  }
};

const getUptimeSeconds = () => Math.round((Date.now() - statusNotes.startTime) / 1000);

const recordCrawlResult = ({ statusCode, error, url }) => {
  statusNotes.totalCrawls += 1;
  statusNotes.lastCrawlAt = new Date().toISOString();
  statusNotes.lastStatusCode = statusCode;

  if (url) {
    statusNotes.lastUrl = url;
  }

  if (error) {
    statusNotes.failedCrawls += 1;
    statusNotes.lastError = error;
  } else {
    statusNotes.successfulCrawls += 1;
    statusNotes.lastError = null;
  }

  refreshSpinner();
};

const recordPdfConversion = ({ statusCode, error }) => {
  statusNotes.pdfAttempts += 1;
  statusNotes.lastCrawlAt = new Date().toISOString();
  statusNotes.lastStatusCode = statusCode;

  if (error) {
    statusNotes.pdfConversionFailures += 1;
    statusNotes.lastError = error;
  } else {
    statusNotes.pdfConversions += 1;
    statusNotes.lastError = null;
  }

  refreshSpinner();
};

const noteWatchdogLag = (lagMs) => {
  statusNotes.lastEventLoopLagMs = Math.round(lagMs);
  statusNotes.lastWatchdogWarning = new Date().toISOString();
};

const setLastError = (message) => {
  statusNotes.lastError = message;
  refreshSpinner();
};

const stopSpinner = () => {
  if (statusSpinner?.isSpinning) {
    statusSpinner.stop();
  }
};

const getSnapshot = () => ({
  uptimeSeconds: getUptimeSeconds(),
  totalCrawls: statusNotes.totalCrawls,
  successfulCrawls: statusNotes.successfulCrawls,
  failedCrawls: statusNotes.failedCrawls,
  pdfAttempts: statusNotes.pdfAttempts,
  pdfConversions: statusNotes.pdfConversions,
  pdfConversionFailures: statusNotes.pdfConversionFailures,
  failedTotal: statusNotes.failedCrawls + statusNotes.pdfConversionFailures,
  lastCrawlAt: statusNotes.lastCrawlAt,
  lastStatusCode: statusNotes.lastStatusCode,
  lastError: statusNotes.lastError,
  lastUrl: statusNotes.lastUrl,
  spinnerStatus: statusNotes.spinnerStatus,
  watchdog: {
    lastWarning: statusNotes.lastWatchdogWarning,
    eventLoopLagMs: statusNotes.lastEventLoopLagMs,
  },
});

const statusTracker = {
  refreshSpinner,
  recordCrawlResult,
  recordPdfConversion,
  noteWatchdogLag,
  setLastError,
  stopSpinner,
  getSnapshot,
  getUptimeSeconds,
};

refreshSpinner({ status: 'starting up', url: '—' });

export { statusTracker, statusNotes };
