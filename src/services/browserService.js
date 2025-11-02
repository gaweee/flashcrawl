import { chromium } from 'rebrowser-playwright';
import { logger } from '../utils/logger.js';
import { formatError } from '../utils/errors.js';
import { createNewBrowserInstance } from './browserManager.js';
import { constants } from '../utils/config.js';
import { handleRequest as htmlHandle } from './htmlHandler.js';
import { handleRequest as pdfHandle } from './pdfHandler.js';
import { statusTracker } from '../utils/statusTracker.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';


/**
 * Create browser/context, navigate and delegate to pdf or html handler.
 * Returns handler result (object ready to be JSON-stringified).
 */
async function handleCrawl(req, res) {
  // accept url from query (GET) or body (POST form/json/urlencoded)
  const url = (req.body?.url ?? req.query?.url)?.trim();
  if (!url) return res.status(400).json({ error: req.method === 'GET' ? 'Missing url query parameter' : 'Missing url parameter' });

  logger.info(`[browserService] received crawl request for ${url}`);

  // validate URL
  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https protocols are supported' });
  }

  let browser, context, page;
  // mark request as active in the spinner and reserve a slot in totals
  statusTracker.incrementTotal(1);
  statusTracker.refreshSpinner({ status: 'active', url: targetUrl.href, archived: false });

  let retried = false;

  const isRecoverableError = (err) => {
    const msg = String(err && err.message ? err.message : err);
    return /Execution context was destroyed/i.test(msg)
      || /context was destroyed/i.test(msg)
      || /Unable to retrieve content because the page is navigating/i.test(msg)
      || /cannot get world/i.test(msg)
      || /Runtime\.addBinding/i.test(msg)
      || /session closed/i.test(msg)
      || /Protocol error/i.test(msg)
      || (err && err.type === 'closed');
  };

  const runOnce = async () => {
    // create a fresh browser instance for isolation (avoids shared-session crashes)
    browser = await createNewBrowserInstance();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
    });

    context.setDefaultNavigationTimeout(constants.NAVIGATION_RETRY_TIMEOUT_MS);
    context.setDefaultTimeout(constants.NAVIGATION_RETRY_TIMEOUT_MS);

    // quick PDF path check by URL
    const isPdfByUrl = /\.pdf(?:$|[?#])/i.test(targetUrl.href);

    if (isPdfByUrl) {
      logger.info(`[browserService] PDF detected, switching to pdfHandler`);
      // pass the original requested URL to the handler; redirects will describe the final URL
      const result = await pdfHandle({ context, url: targetUrl.href });
      return { result, finalUrl: targetUrl.href, redirects: [targetUrl.href] };
    }

    logger.info(`[browserService] HTML detected, switching to htmlHandler`);
    page = await context.newPage();
    const response = await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded' });
    if (!response) throw new Error('No response received from target URL');

    // determine final URL after any HTTP redirects and capture the redirect chain
    let finalUrl = targetUrl.href;
    let redirectChain = [];
    try {
      finalUrl = response.url?.() || response.url || targetUrl.href;
      try {
        let req = response.request();
        const chain = [];
        while (req) {
          chain.unshift(req.url());
          req = typeof req.redirectedFrom === 'function' ? req.redirectedFrom() : null;
        }
        redirectChain = chain.length ? chain : [finalUrl];
      } catch (_) {
        redirectChain = [finalUrl];
      }
    } catch (_) {
      finalUrl = targetUrl.href;
      redirectChain = [finalUrl];
    }

    const ctype = response.headers()['content-type'] ?? '';

    if (ctype.includes('application/pdf')) {
      // request handlers expect the original requested URL in the `url` field; provide redirects separately
      const result = await pdfHandle({ context, page, response, url: targetUrl.href, redirects: redirectChain });
      return { result, finalUrl, redirects: redirectChain };
    }

  // Handlers should report the original requested URL in their `url` field.
  const result = await htmlHandle({ context, page, response, url: targetUrl.href, redirects: redirectChain });
    return { result, finalUrl, redirects: redirectChain };
  };

  try {
    try {
      const { result, finalUrl } = await runOnce();
      statusTracker.incrementSuccess(1);
      statusTracker.refreshSpinner({ status: 'ready', url: finalUrl, archived: true });
      logger.info(`[browserService] request completed successfully for ${url}`);
      return res.json(result);
    } catch (err) {
      // If recoverable and haven't retried yet, attempt one retry with a fresh browser
      logger.error(`[browserService] ${url}: ${formatError(err)}`);
      if (!retried && isRecoverableError(err)) {
        retried = true;
        logger.warn(`[browserService] recoverable error detected, retrying request for ${url}`);
        // close previous resources before retry
        await Promise.all([page?.close().catch(()=>{}), context?.close().catch(()=>{}), browser?.close().catch(()=>{})]);
        page = context = browser = undefined;

        try {
          const { result, finalUrl } = await runOnce();
          statusTracker.incrementSuccess(1);
          statusTracker.refreshSpinner({ status: 'ready', url: finalUrl, archived: true });
          logger.info(`[browserService] retry succeeded for ${url}`);
          return res.json(result);
        } catch (err2) {
          logger.error(`[browserService] retry failed for ${url}: ${formatError(err2)}`);
          try { statusTracker.refreshSpinner({ status: 'ready', url: targetUrl?.href ?? url, archived: true }); } catch (_) {}
          return res.status(500).json({ error: 'Failed to crawl URL', details: String(err2.message ?? err2) });
        }
      }

      // non-recoverable or already retried
      try { statusTracker.refreshSpinner({ status: 'ready', url: targetUrl?.href ?? url, archived: true }); } catch (_) {}
      return res.status(500).json({ error: 'Failed to crawl URL', details: String(err.message ?? err) });
    }
  } finally {
    await Promise.all([page?.close().catch(()=>{}), context?.close().catch(()=>{}), browser?.close().catch(()=>{})]);
  }
}

export { handleCrawl };
