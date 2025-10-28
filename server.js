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
};

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

const recordCrawlResult = ({ statusCode, error }) => {
  statusNotes.totalCrawls += 1;
  statusNotes.lastCrawlAt = new Date().toISOString();
  statusNotes.lastStatusCode = statusCode;

  if (error) {
    statusNotes.failedCrawls += 1;
    statusNotes.lastError = error;
  } else {
    statusNotes.successfulCrawls += 1;
    statusNotes.lastError = null;
  }
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
      console.warn(chalk.yellow(`[watchdog] Event loop lag detected: ${lag.toFixed(0)}ms`));
    }

    lastTick = now;
  }, WATCHDOG_INTERVAL_MS);

  watchdogTimer.unref?.();
};

const handleFatalError = (label, err) => {
  const message = formatError(err);
  console.error(chalk.red(`[${label}] ${message}`));
  statusNotes.lastError = message;
};

process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));

// Optional: health check
app.get('/', (_req, res) => res.json({ status: 'ok' }));

// Basic status snapshot of the crawler
app.get('/status', (_req, res) => {
  res.json({
    uptimeSeconds: getUptimeSeconds(),
    totalCrawls: statusNotes.totalCrawls,
    successfulCrawls: statusNotes.successfulCrawls,
    failedCrawls: statusNotes.failedCrawls,
    lastCrawlAt: statusNotes.lastCrawlAt,
    lastStatusCode: statusNotes.lastStatusCode,
    lastError: statusNotes.lastError,
    watchdog: {
      lastWarning: statusNotes.lastWatchdogWarning,
      eventLoopLagMs: statusNotes.lastEventLoopLagMs,
    },
  });
});

app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Convert PDF buffer to Markdown
    const markdown = await pdf2md(req.file.buffer, {});

    // Respond as JSON
    res.json({ markdown });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
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
        console.error('Request handling error:', err);
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
        recordCrawlResult({ statusCode: 310, error: message });
        console.warn(
          chalk.yellow(
            `[crawl] ${message}. Observed ${redirectCountObserved} redirects while fetching ${targetUrl.href}`,
          ),
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
      recordCrawlResult({ statusCode: 502, error: message });
      console.warn(chalk.yellow(`[crawl] ${message}: ${targetUrl.href}`));
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
      recordCrawlResult({ statusCode: 524, error: message });
      console.warn(
        chalk.yellow(`[crawl] ${message} for ${targetUrl.href}`),
      );
      return res.status(524).json({ error: message });
    }

    if (verificationResult.waitedMs > 0) {
      console.log(
        chalk.cyan(
          `[crawl] Cleared verification challenge in ${verificationResult.waitedMs}ms for ${targetUrl.href}`,
        ),
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

    recordCrawlResult({ statusCode: expressStatus, error: upstreamError });

    const statusLabel = upstreamError ? chalk.yellow('[crawl]') : chalk.green('[crawl]');
    console.log(
      `${statusLabel} ${targetUrl.href} -> ${upstreamStatus} (${headers['content-type'] ?? 'unknown content-type'})`,
    );

    res.status(expressStatus).json({
      headers: {
        statusCode: upstreamStatus ?? null,
        'content-encoding': headers['content-encoding'] ?? null,
        'content-type': headers['content-type'] ?? null,
        'content-length': headers['content-length'] ? Number(headers['content-length']) : null,
        expires: headers.expires ?? null,
      },
      metadata,
      // body: htmlForMarkdown,
      hash,
      markdown,
    });
  } catch (err) {
    const message = formatError(err);
    recordCrawlResult({ statusCode: 500, error: message });
    console.error(
      chalk.red(`[crawl] Failed to crawl ${targetUrl?.href ?? url}: ${message}`),
    );
    res.status(500).json({ error: 'Failed to crawl URL', details: message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 8080;
const startupSpinner = ora('Starting flashcrawl API server').start();

const server = app.listen(PORT, () => {
  startupSpinner.succeed(chalk.green(`flashcrawl API running on port ${PORT}`));
  startWatchdog();
  console.log(chalk.blue('Status endpoint   : GET /status'));
  console.log(chalk.blue('Health check      : GET /'));
  console.log(chalk.blue('Crawl endpoint    : GET /crawl?url=<target>&fullMarkdown=true|false'));
});

server.on('error', (err) => {
  startupSpinner.fail(chalk.red('Failed to start flashcrawl API server'));
  handleFatalError('server-start', err);
  process.exitCode = 1;
});
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
