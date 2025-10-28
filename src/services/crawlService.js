import puppeteer from 'puppeteer';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { createHash } from 'crypto';
import { logger } from '../logger.js';
import { statusTracker } from '../statusTracker.js';
import { config, constants } from '../config.js';
import { formatError } from '../utils/errors.js';

const turndown = new TurndownService({ codeBlockStyle: 'fenced' });
turndown.use(gfm);

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
  accept:
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

  while (Date.now() - start < constants.HUMAN_VERIFICATION_TIMEOUT_MS) {
    try {
      const challengeText = await page.evaluate(() => document.body?.innerText || '');

      const hasChallenge = HUMAN_VERIFICATION_PATTERNS.some((pattern) => pattern.test(challengeText));

      if (!hasChallenge) {
        return { cleared: true, waitedMs: Date.now() - start };
      }
    } catch {
      // Ignore navigation-related evaluation issues.
    }

    await page.waitForTimeout(constants.HUMAN_VERIFICATION_CHECK_INTERVAL_MS);
  }

  return { cleared: false, waitedMs: Date.now() - start };
};

const handleCrawl = async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https protocols are supported' });
  }

  let browser;

  try {
    statusTracker.refreshSpinner({ status: 'active', url: targetUrl.href });

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(constants.DEFAULT_NAV_TIMEOUT_MS);
    await page.setDefaultTimeout(constants.DEFAULT_NAV_TIMEOUT_MS);
    await page.setJavaScriptEnabled(true);
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders(EXTRA_HEADERS);
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

    let redirectLimitExceeded = false;
    let redirectCountObserved = 0;

    await page.setRequestInterception(true);
    const handleRequest = async (request) => {
      try {
        if (request.isNavigationRequest() && request.redirectChain().length > constants.MAX_REDIRECTS) {
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
        timeout: constants.DEFAULT_NAV_TIMEOUT_MS,
      });
    } catch (navigationErr) {
      if (redirectLimitExceeded) {
        const message = `Exceeded redirect limit of ${constants.MAX_REDIRECTS}`;
        statusTracker.recordCrawlResult({ statusCode: 310, error: message, url: targetUrl.href });
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
      } catch {
        // Ignore failures while resetting interception.
      }
    }

    if (!response) {
      const message = 'No response received from target URL';
      statusTracker.recordCrawlResult({ statusCode: 502, error: message, url: targetUrl.href });
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
      const message = `Verification challenge did not clear within ${constants.HUMAN_VERIFICATION_TIMEOUT_MS}ms`;
      statusTracker.recordCrawlResult({ statusCode: 524, error: message, url: targetUrl.href });
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
    let htmlForMarkdown = fullHtml;

    if (config.sanitizeHtml) {
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

    statusTracker.recordCrawlResult({ statusCode: expressStatus, error: upstreamError, url: targetUrl.href });

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

    if (config.includeHtml) {
      responsePayload.body = htmlForMarkdown;
    }

    res.status(expressStatus).json(responsePayload);
  } catch (err) {
    const message = formatError(err);
    const finalUrl = targetUrl?.href ?? url;
    statusTracker.recordCrawlResult({ statusCode: 500, error: message, url: finalUrl });
    logger.error(`[crawl] Failed to crawl ${finalUrl}: ${message}`);
    res.status(500).json({ error: 'Failed to crawl URL', details: message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    statusTracker.refreshSpinner({ status: 'ready' });
  }
};

export { handleCrawl };
