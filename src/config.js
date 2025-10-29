import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const envPort = Number(process.env.PORT);

const config = {
  projectRoot,
  logDir: process.env.LOG_DIR ?? path.join(projectRoot, 'logs'),
  enableConsoleLog: (process.env.ENABLE_CONSOLE_LOG ?? 'false').toLowerCase() === 'true',
  sanitizeHtml: (process.env.CRAWL_SANITIZE_HTML ?? 'true').toLowerCase() !== 'false',
  port: Number.isFinite(envPort) && envPort > 0 ? envPort : 8080,
};

const constants = Object.freeze({
  WATCHDOG_INTERVAL_MS: 10000,
  WATCHDOG_THRESHOLD_MS: 750,
  MAX_REDIRECTS: 5,
  DEFAULT_NAV_TIMEOUT_MS: 45000,
  CHALLENGE_MAX_REFRESHES: 2,
  NAVIGATION_RETRY_TIMEOUT_MS: 60000,
});

export { config, constants };
