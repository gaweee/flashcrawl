import fs from 'fs';
import { chromium } from 'rebrowser-playwright';
import { createHash } from 'crypto';
import { logger } from '../logger.js';
import { statusTracker } from '../statusTracker.js';
import { config, constants } from '../config.js';
import { formatError } from '../errors.js';
import { extractHtmlContent, convertPdfBufferToMarkdown } from '../utils/markdown.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const buildCookieHeader = (cookies = []) => cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const fetchPdfBuffer = async (context, response, targetUrl) => {
  if (response) {
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
  }

  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
    referer: targetUrl.href,
  };

  if (process.env.CRAWL_SESSION_COOKIE) {
    headers.cookie = process.env.CRAWL_SESSION_COOKIE;
  }

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

const launchStealthBrowser = async () => {
  if (typeof chromium.useStealth === 'function') {
    chromium.useStealth();
  }

  const errors = [];

  const attemptLaunch = async (label, options) => {
    try {
      const browserInstance = await chromium.launch(options);
      logger.debug?.(`[crawl] chromium.launch succeeded using ${label}`);
      return browserInstance;
    } catch (err) {
      errors.push(`${label}: ${formatError(err)}`);
      return null;
    }
  };

  const attempts = [];

  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
    attempts.push({ label: `env:${process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}`, options: { headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } });
  }

  try {
    const defaultExec = typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined;
    if (defaultExec && fs.existsSync(defaultExec)) {
      attempts.push({ label: `default:${defaultExec}`, options: { headless: true, executablePath: defaultExec } });
    }
  } catch (err) {
    logger.debug?.(`[crawl] chromium.executablePath() failed: ${formatError(err)}`);
  }

  attempts.push({ label: 'channel:chrome', options: { headless: true, channel: 'chrome' } });
  attempts.push({ label: 'channel:chromium', options: { headless: true, channel: 'chromium' } });
  attempts.push({ label: 'default', options: { headless: true } });

  for (const attempt of attempts) {
    const result = await attemptLaunch(attempt.label, attempt.options);
    if (result) {
      return result;
    }
  }

  const installHint =
    "Install Chromium via 'npx rebrowser-playwright install chromium --with-deps' or set PLAYWRIGHT_CHROMIUM_EXECUTABLE to an existing Chrome/Chromium binary.";
  throw new Error(`Failed to launch Chromium. Attempts made:\n${errors.join('\n')}\n${installHint}`);
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
  let pdfConversionError = null;
  let pdfStatusRecorded = false;

  try {
    statusTracker.refreshSpinner({ status: 'active', url: targetUrl.href });

    const combinedHeaders = {
      'user-agent': USER_AGENT,
    };

    if (process.env.CRAWL_SESSION_COOKIE) {
      combinedHeaders.cookie = process.env.CRAWL_SESSION_COOKIE;
    }

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
      statusTracker.recordCrawlResult({ statusCode: 502, error: message, url: finalUrl });
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

        pdfBuffer = await fetchPdfBuffer(context, navigationResponse, new URL(pdfUrlString));
        if (!pdfBuffer || pdfBuffer.length === 0) {
          throw new Error('Empty PDF response');
        }

        headers = { 'content-type': 'application/pdf' };

        markdown = await convertPdfBufferToMarkdown(pdfBuffer);
        hash = createHash('sha256').update(markdown).digest('hex');
        statusTracker.recordPdfConversion({ statusCode: 200 });
        pdfStatusRecorded = true;
        pdfConversionError = null;
        logger.info(`[crawl] Processed PDF for ${targetUrl.href}`);
      } catch (err) {
        pdfConversionError = formatError(err);
        markdown = '';
        hash = null;
        statusTracker.recordPdfConversion({ statusCode: 500, error: pdfConversionError });
        pdfStatusRecorded = true;
        logger.error(`[crawl] Failed to analyse PDF for ${targetUrl.href}: ${pdfConversionError}`);
        throw err;
      }
    } else {
      const { markdown: htmlMarkdown, metadata: extractedMetadata } = await extractHtmlContent(page, {
        sanitize: config.sanitizeHtml,
      });

      metadata = extractedMetadata ?? metadata;
      markdown = htmlMarkdown;
      hash = createHash('sha256').update(markdown).digest('hex');
      headers = {
        ...headers,
        'content-type': headers['content-type'] ?? 'text/html; charset=utf-8',
      };
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

    statusTracker.recordCrawlResult({ statusCode: reportedStatus, error: undefined, url: finalUrl });

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
