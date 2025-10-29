import chalk from 'chalk';
import ora from 'ora';

// Spinner-focused status tracker.
// Shows: [spinner] [status (colored)] [active url (grey)]    [success(green)/total]

const _startTime = Date.now();

let totalCrawls = 0;
let successfulCrawls = 0;

const spinnerState = {
  status: 'ready',
  lastUrl: '—',
  archived: false,
};

const statusSpinner = process.stdout.isTTY ? ora({ spinner: 'dots', color: 'cyan' }) : null;

const STATUS_COLORS = {
  ready: chalk.bgGreen,
  active: chalk.bgBlue,
  'starting up': chalk.bgYellow,
};

const formatStatusLabel = (status) => {
  const colorizer = STATUS_COLORS[status] ?? chalk.white;
  return colorizer(` ${status} `);
};

const truncate = (s, max = 80) => {
  if (!s) return '—';
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.55);
  const tail = max - head - 1;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
};

const history = [];
const HISTORY_MAX = 10;

const refreshSpinner = ({ status, url, archived = false } = {}) => {
  if (status) spinnerState.status = status;
  if (url !== undefined) spinnerState.lastUrl = url || '—';
  spinnerState.archived = archived === true;

  // when archiving, push to history
  if (spinnerState.archived && spinnerState.lastUrl) {
    history.unshift(spinnerState.lastUrl);
    if (history.length > HISTORY_MAX) history.pop();
  }

  if (!statusSpinner) return;

  const statusLabel = formatStatusLabel(spinnerState.status);
  const rawUrl = spinnerState.lastUrl || '—';
  const display = truncate(rawUrl, 72);
  const urlText = spinnerState.archived ? chalk.gray(display) : chalk.white(display);

  // show success/total as right-hand info
  const counts = `${chalk.green(String(successfulCrawls))}/${String(totalCrawls)}`;

  // format line
  statusSpinner.text = `${statusLabel} ${counts}   →   ${urlText}    `;
  if (!statusSpinner.isSpinning) statusSpinner.start();
  // force immediate render so the spinner text updates promptly
  try { statusSpinner.render(); } catch (_) {}
};

const stopSpinner = () => {
  if (statusSpinner?.isSpinning) statusSpinner.stop();
};

const incrementTotal = (n = 1) => { totalCrawls += n; };
const incrementSuccess = (n = 1) => { successfulCrawls += n; };

const statusTracker = {
  refreshSpinner,
  stopSpinner,
  incrementTotal,
  incrementSuccess,
};

// initialize as ready so the spinner doesn't show "starting up" after init
refreshSpinner({ status: 'ready', url: '—' });

export { statusTracker };
