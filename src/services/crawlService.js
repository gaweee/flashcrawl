import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { createHash, randomUUID } from 'crypto';
import { logger } from '../logger.js';
import { statusTracker } from '../statusTracker.js';
import { config, constants } from '../config.js';
import { formatError } from '../errors.js';

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

const buildCookieHeader = (cookies = []) =>
  cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

const ensureTmpDirExists = async () => {
  const tmpDir = path.join(config.projectRoot, 'tmp');
  try {
    await fs.promises.access(tmpDir);
  } catch {
    await fs.promises.mkdir(tmpDir, { recursive: true });
  }
  return tmpDir;
};

const fetchPdfBuffer = async (context, response, targetUrl) => {
  try {
    const body = await response.body();
    if (body && body.length > 0) {
      return Buffer.from(body);
    }
  } catch (err) {
    logger.warn(
      `[crawl] Unable to read PDF buffer from navigation response for ${targetUrl.href}: ${formatError(err)}`,
    );
  }

  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
    referer: targetUrl.href,
  };

  const cookies = await context.cookies();
  const cookieHeader = buildCookieHeader(cookies);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  const apiResponse = await context.request.get(targetUrl.href, { headers });
  if (!apiResponse.ok()) {
    throw new Error(`PDF request failed (${apiResponse.status()})`);
  }

  const apiBuffer = await apiResponse.body();
  return Buffer.from(apiBuffer);
};

const handleCrawl = async (req, res) => {
  const { url } = req.query;
  const startTime = Date.now();

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
  let context;
  let page;
  let processedAsPdf = false;
  let pdfConversionError = null;
  let pdfStatusRecorded = false;
  let pdfDetails = null;

  try {
    statusTracker.refreshSpinner({ status: 'active', url: targetUrl.href });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: EXTRA_HEADERS,
      ignoreHTTPSErrors: true,
    });
    context.setDefaultNavigationTimeout(constants.DEFAULT_NAV_TIMEOUT_MS);
    context.setDefaultTimeout(constants.DEFAULT_NAV_TIMEOUT_MS);

    const requestHeaders = {
      ...EXTRA_HEADERS,
      'user-agent': USER_AGENT,
    };

    const apiResponse = await context.request.get(targetUrl.href, {
      headers: requestHeaders,
      maxRedirects: constants.MAX_REDIRECTS,
      timeout: constants.DEFAULT_NAV_TIMEOUT_MS,
    });

    const upstreamStatus = apiResponse.status();
    const finalUrl = apiResponse.url();
    const headers = apiResponse.headers();
    const contentType = headers['content-type'] ?? '';
    processedAsPdf = /application\/pdf/i.test(contentType);

    if (upstreamStatus >= 400) {
      const message = `Upstream responded with status ${upstreamStatus}`;
      statusTracker.recordCrawlResult({ statusCode: upstreamStatus, error: message, url: finalUrl });
      logger.warn(`[crawl] ${finalUrl} -> ${upstreamStatus}`);
      return res.status(upstreamStatus).json({ error: message });
    }

    let metadata = {
      title: null,
      description: null,
      h1: [],
      h2: [],
    };
    let markdown = null;
    let hash = null;
    let htmlForMarkdown = null;

    if (processedAsPdf) {
      try {
        const pdfBuffer = await fetchPdfBuffer(context, apiResponse, targetUrl);
        if (!pdfBuffer || pdfBuffer.length === 0) {
          throw new Error('Empty PDF response');
        }

        const tmpDir = await ensureTmpDirExists();
        const filePath = path.join(tmpDir, `flashcrawl-${Date.now()}-${randomUUID()}.pdf`);
        await fs.promises.writeFile(filePath, pdfBuffer);

        const sizeBytes = pdfBuffer.length;
        markdown = `${sizeBytes} bytes`;
        hash = createHash('sha256').update(pdfBuffer).digest('hex');
        pdfDetails = { saved: true, path: filePath, size: sizeBytes };
        statusTracker.recordPdfConversion({ statusCode: 200 });
        pdfStatusRecorded = true;
        pdfConversionError = null;
        logger.info(`[crawl] Saved PDF for ${targetUrl.href} -> ${filePath}`);
      } catch (err) {
        pdfConversionError = formatError(err);
        pdfDetails = { saved: false, path: null, size: 0, error: pdfConversionError };
        markdown = '0 bytes';
        hash = null;
        statusTracker.recordPdfConversion({ statusCode: 500, error: pdfConversionError });
        pdfStatusRecorded = true;
        logger.error(`[crawl] Failed to persist PDF for ${targetUrl.href}: ${pdfConversionError}`);
      }
    } else {
      page = await context.newPage();
      const response = await page.goto(finalUrl, {
        waitUntil: 'domcontentloaded',
        timeout: constants.DEFAULT_NAV_TIMEOUT_MS,
      });

      if (!response) {
        const message = 'No response received from target URL';
        statusTracker.recordCrawlResult({ statusCode: 502, error: message, url: finalUrl });
        logger.warn(`[crawl] ${message}: ${finalUrl}`);
        return res.status(502).json({ error: message });
      }

      metadata = await page.evaluate(() => {
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
          await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch {
          // Ignore timeout; page may still be loading async assets.
        }
      }

      htmlForMarkdown = await page.content();

      if (config.sanitizeHtml) {
        htmlForMarkdown = await page.evaluate((selectors) => {
          selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => el.remove());
          });
          return '<!DOCTYPE html>' + document.documentElement.outerHTML;
        }, STRIP_SELECTORS);
      }

      markdown = turndown.turndown(htmlForMarkdown);
      hash = createHash('sha256').update(markdown).digest('hex');
    }

    const expressStatus = upstreamStatus >= 400 ? upstreamStatus : 200;
    const upstreamError =
      upstreamStatus >= 400 ? `Upstream responded with status ${upstreamStatus}` : undefined;

    statusTracker.recordCrawlResult({ statusCode: expressStatus, error: upstreamError, url: finalUrl });

    const duration = Date.now() - startTime;
    const crawlMessage = `[crawl] ${finalUrl} -> ${upstreamStatus} (${
      headers['content-type'] ?? 'unknown content-type'
    }) in ${duration}ms${processedAsPdf ? ' [pdf]' : ''}`;
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

    if (processedAsPdf) {
      responsePayload.body = null;
      responsePayload.pdf = pdfDetails ?? {
        saved: false,
        path: null,
        size: 0,
        error: pdfConversionError ?? 'Unable to retrieve PDF content',
      };
    } else if (config.includeHtml) {
      responsePayload.body = htmlForMarkdown;
    }

    res.status(expressStatus).json(responsePayload);
  } catch (err) {
    const message = formatError(err);
    const finalUrl = targetUrl?.href ?? url;
    const duration = Date.now() - startTime;
    if (processedAsPdf && !pdfStatusRecorded) {
      statusTracker.recordPdfConversion({ statusCode: 500, error: message });
    }
    statusTracker.recordCrawlResult({ statusCode: 500, error: message, url: finalUrl });
    logger.error(`[crawl] Failed to crawl ${finalUrl}: ${message} (in ${duration}ms)`);
    res.status(500).json({ error: 'Failed to crawl URL', details: message });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    statusTracker.refreshSpinner({ status: 'ready' });
  }
};

export { handleCrawl };
