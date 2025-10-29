import fs from 'fs';
import { chromium } from 'rebrowser-playwright';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { config, constants } from '../utils/config.js';
import { formatError } from '../utils/errors.js';
import { fetchAndProcessPdf, fetchPdf, processPdfBuffer } from './pdfHandler.js';
import { processHtml } from './htmlHandler.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Return minimal default headers for crawler requests.
 */
const getDefaultHeaders = () => ({
  'user-agent': USER_AGENT,
  ...(process.env.CRAWL_SESSION_COOKIE ? { cookie: process.env.CRAWL_SESSION_COOKIE } : {})
});



/** Launch a browser (stealth if available). */
const launchStealthBrowser = async () => {
  if (typeof chromium.useStealth === 'function') {
    chromium.useStealth();
  }

  // Simple single-attempt launch keeps code small; errors bubble up with clear message.
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
    options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }

  try {
    return await chromium.launch(options);
  } catch (err) {
    // If the cached Playwright binary is missing, try common system channels before failing.
    const msg = String(err?.message ?? err);
    try {
      // try system chrome first
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch (_) {
      try {
        return await chromium.launch({ headless: true, channel: 'chromium' });
      } catch (__) {
        // final: surface a helpful instruction
        const hint = `Playwright browser not found. Run:\n\n  npx rebrowser-playwright install chromium --with-deps\n\nor\n  npx playwright install chromium\n\nor set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chrome/Chromium binary.`;
        throw new Error(`Failed to launch Chromium: ${msg}\n${hint}`);
      }
    }
  }
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
  let page = null;
  let processedAsPdf = false;

  try {
    // status tracking removed — keep console/log file output only
    const combinedHeaders = getDefaultHeaders();

    browser = await launchStealthBrowser();

    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: combinedHeaders,
      ignoreHTTPSErrors: true,
    });
    context.setDefaultNavigationTimeout(constants.NAVIGATION_RETRY_TIMEOUT_MS);
    context.setDefaultTimeout(constants.NAVIGATION_RETRY_TIMEOUT_MS);

    const pdfPathPattern = /\.pdf(?:$|[?#])/i;
    const pdfPathCandidate = pdfPathPattern.test(targetUrl.pathname.toLowerCase()) || pdfPathPattern.test(targetUrl.href.toLowerCase());

    let navigationResponse;
    let finalUrl = targetUrl.href;
    let headers = {};
    let upstreamStatus = 0;

    if (!pdfPathCandidate) {
      page = await context.newPage();
      let navigationAttempts = 0;

      while (navigationAttempts <= constants.CHALLENGE_MAX_REFRESHES) {
        navigationAttempts += 1;
        try {
          navigationResponse = await page.goto(finalUrl, {
            waitUntil: 'domcontentloaded',
            timeout: constants.NAVIGATION_RETRY_TIMEOUT_MS,
          });
        } catch (navigationErr) {
          if (navigationErr?.message?.includes('Download is starting')) {
            processedAsPdf = true;
            finalUrl = page.url() || targetUrl.href;
            if (page && !page.isClosed()) {
              await page.close().catch(() => {});
              page = null;
            }
            break;
          }
          const message = navigationErr?.message ?? '';
          const retriable =
            /net::|Navigation timeout|ProtocolError|Target page, context or browser has been closed/i.test(message);
          const hasAttemptsRemaining = navigationAttempts <= constants.CHALLENGE_MAX_REFRESHES;
          if (retriable && hasAttemptsRemaining) {
            logger.warn?.(
              `[crawl] Navigation retry ${navigationAttempts} for ${finalUrl} due to error: ${formatError(navigationErr)}`,
            );
            await page.waitForTimeout(1500).catch(() => {});
            continue;
          }
          throw navigationErr;
        }

        if (!navigationResponse) {
          break;
        }

        finalUrl = navigationResponse.url();
        upstreamStatus = navigationResponse.status();
        headers = navigationResponse.headers();
        processedAsPdf = /application\/pdf/i.test(headers['content-type'] ?? '');

        if (processedAsPdf || upstreamStatus < 400) {
          break;
        }
      }
    } else {
      processedAsPdf = true;
    }

    if (!processedAsPdf && !navigationResponse) {
      const message = 'No response received from target URL';
      logger.warn(`[crawl] ${message}: ${finalUrl}`);
      return res.status(502).json({ error: message });
    }

    let metadata = {
      title: null,
      description: null,
      h1: [],
      h2: [],
    };
    let markdown = null;
    let hash = null;

    if (!processedAsPdf && (!page || page.isClosed())) {
      page = await context.newPage();
      await page.goto(finalUrl, {
        waitUntil: 'domcontentloaded',
        timeout: constants.NAVIGATION_RETRY_TIMEOUT_MS,
      }).catch(() => {});
    }

  if (processedAsPdf) {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
        page = null;
      }

      let pdfBuffer;
      try {
        let pdfUrlString;
        try {
          const candidate = new URL(finalUrl);
          if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
            pdfUrlString = candidate.href;
          }
        } catch (err) {
          if (logger.debug) {
            logger.debug(`[crawl] Ignoring invalid final URL ${finalUrl}: ${formatError(err)}`);
          }
        }
        if (!pdfUrlString) {
          pdfUrlString = targetUrl.href;
        }

  pdfBuffer = await fetchPdf(context, pdfUrlString);
        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error('Empty PDF response');
        ({ markdown, hash } = await processPdfBuffer(pdfBuffer, targetUrl.href));
        logger.info(`[crawl] Processed PDF for ${targetUrl.href}`);
      } catch (err) {
        const ferr = formatError(err);
        markdown = '';
        hash = null;
        logger.error(`[crawl] Failed to analyse PDF for ${targetUrl.href}: ${ferr}`);
        throw err;
      }
    } else {
      const htmlResult = await processHtml(page, navigationResponse || ({}));
      metadata = htmlResult.metadata;
      markdown = htmlResult.markdown;
      hash = htmlResult.hash;
      headers = { ...headers, 'content-type': htmlResult.headers['content-type'] };
    }

    const reportedStatus = (() => {
      if (processedAsPdf) {
        return 200;
      }
      if (!upstreamStatus || upstreamStatus < 200) {
        return 200;
      }
      if (upstreamStatus >= 400) {
        return 200;
      }
      return upstreamStatus;
    })();

    const upstreamError = upstreamStatus >= 400 ? `Upstream responded with status ${upstreamStatus}` : undefined;

  // crawl result metric removed

    const duration = Date.now() - startTime;
    const crawlMessage = `[crawl] ${finalUrl} -> ${reportedStatus} (${
      headers['content-type'] ?? 'unknown content-type'
    }) in ${duration}ms${processedAsPdf ? ' [pdf]' : ''}`;
    if (upstreamError) {
      logger.warn(`${crawlMessage} | ${upstreamError}`);
    } else {
      logger.info(crawlMessage);
    }

    const responsePayload = {
      headers: {
        statusCode: reportedStatus,
        'content-encoding': headers['content-encoding'] ?? null,
        'content-type': headers['content-type'] ?? null,
        expires: headers.expires ?? null,
      },
      metadata,
      url,
      hash,
      markdown,
    };

    res.status(200).json(responsePayload);
  } catch (err) {
    const message = formatError(err);
    const finalUrl = targetUrl?.href ?? url;
    const duration = Date.now() - startTime;
    // status tracking removed
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
  }
};

export { handleCrawl };
