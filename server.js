import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import express from 'express';
import multer from 'multer';
import pdf2md from '@opendocsg/pdf2md';
import puppeteer from 'puppeteer';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { createHash } from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import { performance } from 'perf_hooks';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const turndown = new TurndownService({ codeBlockStyle: 'fenced' });
turndown.use(gfm);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = process.env.LOG_DIR ?? path.join(__dirname, 'logs');
const LOG_TO_CONSOLE = process.env.ENABLE_CONSOLE_LOG !== 'false';
const INCLUDE_HTML_RESPONSE = (process.env.CRAWL_INCLUDE_HTML ?? 'true').toLowerCase() !== 'false';
const ENV_PORT = Number(process.env.PORT);
const PORT = Number.isFinite(ENV_PORT) && ENV_PORT > 0 ? ENV_PORT : 8080;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const currentDate = new Date().toISOString().split('T')[0];
const fileLogFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`),
);

const loggerTransports = [
  new winston.transports.File({
    filename: path.join(LOG_DIR, `flashcrawl-${currentDate}.log`),
    level: 'info',
  }),
  new winston.transports.File({
    filename: path.join(LOG_DIR, `flashcrawl-error-${currentDate}.log`),
    level: 'error',
  }),
];

if (LOG_TO_CONSOLE) {
  loggerTransports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`),
      ),
    }),
  );
}

const logger = winston.createLogger({
  level: 'info',
  format: fileLogFormat,
  transports: loggerTransports,
});

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

const statusSpinner = LOG_TO_CONSOLE ? ora({ spinner: 'dots', color: 'cyan' }) : null;

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

refreshSpinner({ status: 'starting up', url: '—' });
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

const WATCHDOG_INTERVAL_MS = 10000;
const WATCHDOG_THRESHOLD_MS = 750;
const MAX_REDIRECTS = 5;
const DEFAULT_NAV_TIMEOUT_MS = 45000;
const HUMAN_VERIFICATION_TIMEOUT_MS = 45000;
const HUMAN_VERIFICATION_CHECK_INTERVAL_MS = 2000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const EXTRA_HEADERS = {
  'upgrade-insecure-requests': '1',
  'sec-ch-ua':
    '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br, zstd',
};
const HUMAN_VERIFICATION_PATTERNS = [
  /verify(?:ing)? you are human/i,
  /needs to review the security of your connection/i,
  /checking your browser before accessing/i,
  /press and hold/i,
];
const STRIP_SELECTORS = [
  'script',
  'style',
  'link[rel="stylesheet"]',
  'link[rel="preload"]',
  'link[rel="prefetch"]',
  'link[rel="dns-prefetch"]',
  'noscript',
  'iframe',
  'canvas',
  'svg',
  'object',
  'embed',
  'template',
  'meta[http-equiv="refresh"]',
];

const waitForHumanVerification = async (page) => {
  const start = Date.now();

  while (Date.now() - start < HUMAN_VERIFICATION_TIMEOUT_MS) {
    try {
      const challengeText = await page.evaluate(
        () => document.body?.innerText || '',
      );

      const hasChallenge = HUMAN_VERIFICATION_PATTERNS.some((pattern) =>
        pattern.test(challengeText),
      );

      if (!hasChallenge) {
        return { cleared: true, waitedMs: Date.now() - start };
      }
    } catch (err) {
      // Ignore transient evaluation errors due to navigation/reloads.
    }

    await page.waitForTimeout(HUMAN_VERIFICATION_CHECK_INTERVAL_MS);
  }

  return { cleared: false, waitedMs: Date.now() - start };
};

let watchdogTimer;
const startWatchdog = () => {
  let lastTick = performance.now();
  watchdogTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - lastTick;
    const lag = drift - WATCHDOG_INTERVAL_MS;

    if (lag > WATCHDOG_THRESHOLD_MS) {
      statusNotes.lastEventLoopLagMs = Math.round(lag);
      statusNotes.lastWatchdogWarning = new Date().toISOString();
      logger.warn(`[watchdog] Event loop lag detected: ${lag.toFixed(0)}ms`);
    }

    lastTick = now;
  }, WATCHDOG_INTERVAL_MS);

  watchdogTimer.unref?.();
};

const handleFatalError = (label, err) => {
  const message = formatError(err);
  logger.error(`[${label}] ${message}`);
  statusNotes.lastError = message;
};

process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));

// Basic status snapshot of the crawler
app.get('/status', (_req, res) => {
  res.json({
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
});

app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      const message = 'No file provided';
      recordPdfConversion({ statusCode: 400, error: message });
      return res.status(400).json({ error: message });
    }

    // Convert PDF buffer to Markdown
    const markdown = await pdf2md(req.file.buffer, {});

    // Respond as JSON
    recordPdfConversion({ statusCode: 200 });
    res.json({ markdown });
  } catch (err) {
    const message = formatError(err);
    logger.error(`[convert] ${message}`);
    recordPdfConversion({ statusCode: 500, error: message });
    res.status(500).json({ error: message });
  }
});

// Lightweight crawler that returns page-level metadata
app.get('/crawl', async (req, res) => {
  const { url, fullMarkdown } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https protocols are supported' });
  }

  let browser;
  try {
    refreshSpinner({ status: 'active', url: targetUrl.href });
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);
    await page.setDefaultTimeout(DEFAULT_NAV_TIMEOUT_MS);
    await page.setJavaScriptEnabled(true);
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders(EXTRA_HEADERS);
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    let redirectLimitExceeded = false;
    let redirectCountObserved = 0;

    await page.setRequestInterception(true);
    const handleRequest = async (request) => {
      try {
        if (request.isNavigationRequest() && request.redirectChain().length > MAX_REDIRECTS) {
          redirectLimitExceeded = true;
          redirectCountObserved = request.redirectChain().length;
          await request.abort('blockedbyclient');
          return;
        }
        await request.continue();
      } catch (err) {
        logger.error(`Request handling error: ${formatError(err)}`);
      }
    };

    page.on('request', handleRequest);

    let response;
    try {
      response = await page.goto(targetUrl.href, {
        waitUntil: 'networkidle2',
        timeout: DEFAULT_NAV_TIMEOUT_MS,
      });
    } catch (navigationErr) {
      if (redirectLimitExceeded) {
        const message = `Exceeded redirect limit of ${MAX_REDIRECTS}`;
        recordCrawlResult({ statusCode: 310, error: message, url: targetUrl.href });
        logger.warn(
          `[crawl] ${message}. Observed ${redirectCountObserved} redirects while fetching ${targetUrl.href}`,
        );
        return res.status(310).json({
          error: message,
          redirects: redirectCountObserved,
        });
      }
      throw navigationErr;
    } finally {
      page.off('request', handleRequest);
      try {
        await page.setRequestInterception(false);
      } catch (err) {
        // Best effort reset; safe to ignore errors here.
      }
    }

    if (!response) {
      const message = 'No response received from target URL';
      recordCrawlResult({ statusCode: 502, error: message, url: targetUrl.href });
      logger.warn(`[crawl] ${message}: ${targetUrl.href}`);
      return res.status(502).json({ error: message });
    }

    const metadata = await page.evaluate(() => {
      const getMeta = (name) =>
        document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ??
        document.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ??
        null;

      const cleanTextArray = (selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((el) => el.textContent?.trim())
          .filter((text) => Boolean(text));

      return {
        title: document.title || null,
        description: getMeta('description'),
        h1: cleanTextArray('h1'),
        h2: cleanTextArray('h2'),
      };
    });

    const verificationResult = await waitForHumanVerification(page);

    if (!verificationResult.cleared) {
      const message = `Verification challenge did not clear within ${HUMAN_VERIFICATION_TIMEOUT_MS}ms`;
      recordCrawlResult({ statusCode: 524, error: message, url: targetUrl.href });
      logger.warn(`[crawl] ${message} for ${targetUrl.href}`);
      return res.status(524).json({ error: message });
    }

    if (verificationResult.waitedMs > 0) {
      logger.info(
        `[crawl] Cleared verification challenge in ${verificationResult.waitedMs}ms for ${targetUrl.href}`,
      );
      try {
        await page.waitForNetworkIdle({ timeout: 10000 });
      } catch {
        // Ignore timeout; page may still be loading async assets.
      }
    }

    const fullHtml = await page.content();
    const includeFullMarkdown =
      typeof fullMarkdown === 'string' &&
      ['1', 'true', 'yes', 'full'].includes(fullMarkdown.toLowerCase());

    let htmlForMarkdown = fullHtml;

    if (!includeFullMarkdown) {
      htmlForMarkdown = await page.evaluate((selectors) => {
        selectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((el) => el.remove());
        });
        return '<!DOCTYPE html>' + document.documentElement.outerHTML;
      }, STRIP_SELECTORS);
    }

    const markdown = turndown.turndown(htmlForMarkdown);
    const hash = createHash('sha256').update(markdown).digest('hex');
    const headers = response?.headers() ?? {};
    const upstreamStatus = response.status();
    const expressStatus = upstreamStatus >= 400 ? upstreamStatus : 200;
    const upstreamError =
      upstreamStatus >= 400 ? `Upstream responded with status ${upstreamStatus}` : undefined;

    recordCrawlResult({ statusCode: expressStatus, error: upstreamError, url: targetUrl.href });

    const crawlMessage = `[crawl] ${targetUrl.href} -> ${upstreamStatus} (${headers['content-type'] ?? 'unknown content-type'})`;
    if (upstreamError) {
      logger.warn(crawlMessage);
    } else {
      logger.info(crawlMessage);
    }

    const responsePayload = {
      headers: {
        statusCode: upstreamStatus ?? null,
        'content-encoding': headers['content-encoding'] ?? null,
        'content-type': headers['content-type'] ?? null,
        'content-length': headers['content-length'] ? Number(headers['content-length']) : null,
        expires: headers.expires ?? null,
      },
      metadata,
      hash,
      markdown,
    };

    if (INCLUDE_HTML_RESPONSE || includeFullMarkdown) {
      responsePayload.body = htmlForMarkdown;
    }

    res.status(expressStatus).json(responsePayload);
  } catch (err) {
    const message = formatError(err);
    recordCrawlResult({ statusCode: 500, error: message, url: targetUrl?.href ?? url });
    logger.error(`[crawl] Failed to crawl ${targetUrl?.href ?? url}: ${message}`);
    res.status(500).json({ error: 'Failed to crawl URL', details: message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    refreshSpinner({ status: 'ready' });
  }
});

const server = app.listen(PORT, () => {
  refreshSpinner({ status: 'ready' });
  startWatchdog();
  logger.info(`flashcrawl API running on port ${PORT}`);
  logger.info('Status endpoint   : GET /status');
  logger.info('Crawl endpoint    : GET /crawl?url=<target>&fullMarkdown=true|false');
  logger.info('PDF convert       : POST /convert');
  refreshSpinner();
});

server.on('error', (err) => {
  statusSpinner?.fail(chalk.red('Failed to start flashcrawl API server'));
  handleFatalError('server-start', err);
  process.exitCode = 1;
});
