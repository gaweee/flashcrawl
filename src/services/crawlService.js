import fs from 'fs';
import path from 'path';
import { chromium } from 'rebrowser-playwright';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { createHash, randomUUID } from 'crypto';
import pdf2md from '@opendocsg/pdf2md';
import { logger } from '../logger.js';
import { statusTracker } from '../statusTracker.js';
import { config, constants } from '../config.js';
import { formatError } from '../errors.js';

const turndown = new TurndownService({ codeBlockStyle: 'fenced' });
turndown.use(gfm);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const EXTRA_HEADERS = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
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
      ...EXTRA_HEADERS,
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

    page = await context.newPage();

    let navigationResponse;
    let finalUrl = targetUrl.href;
    let headers = {};
    let upstreamStatus = 0;
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
          break;
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
      if (page) {
        await page.close().catch(() => {});
        page = null;
      }

      let pdfBuffer;
      let filePath;
      let sizeBytes = 0;
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

        sizeBytes = pdfBuffer.length;
        const tmpDir = await ensureTmpDirExists();
        filePath = path.join(tmpDir, `flashcrawl-${Date.now()}-${randomUUID()}.pdf`);
        await fs.promises.writeFile(filePath, pdfBuffer);

        headers = { 'content-type': 'application/pdf' };

        const pdfMarkdown = await pdf2md(pdfBuffer, {});
        markdown = pdfMarkdown;
        hash = createHash('sha256').update(pdfMarkdown).digest('hex');
        statusTracker.recordPdfConversion({ statusCode: 200 });
        pdfStatusRecorded = true;
        pdfConversionError = null;
        logger.info(`[crawl] Saved PDF for ${targetUrl.href} -> ${filePath}`);
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

      // const verificationResult = await waitForHumanVerification(page);

      // if (!verificationResult.cleared) {
      //   const message = `Verification challenge did not clear within ${constants.HUMAN_VERIFICATION_TIMEOUT_MS}ms`;
      //   statusTracker.recordCrawlResult({ statusCode: 524, error: message, url: targetUrl.href });
      //   logger.warn(`[crawl] ${message} for ${targetUrl.href}`);
      //   return res.status(524).json({ error: message });
      // }

      // if (verificationResult.waitedMs > 0) {
      //   logger.info(
      //     `[crawl] Cleared verification challenge in ${verificationResult.waitedMs}ms for ${targetUrl.href}`,
      //   );
      //   try {
      //     await page.waitForLoadState('networkidle', { timeout: 10000 });
      //   } catch {
      //     // Ignore timeout; page may still be loading async assets.
      //   }
      // }

      const rawHtml = await page.content();

      let htmlForMarkdown = rawHtml;
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
