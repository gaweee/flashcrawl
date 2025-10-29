import fs from 'fs';
import { chromium } from 'rebrowser-playwright';
import { logger } from '../utils/logger.js';
import { formatError } from '../utils/errors.js';
import { config, constants } from '../utils/config.js';
import { processHtml, handleRequest as htmlHandle } from './htmlHandler.js';
import { handleRequest as pdfHandle } from './pdfHandler.js';
import { statusTracker } from '../utils/statusTracker.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const launchBrowser = async () => {
  if (typeof chromium.useStealth === 'function') chromium.useStealth();
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
    options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }

  try {
    return await chromium.launch(options);
  } catch (err) {
    // fallbacks
    try { return await chromium.launch({ headless: true, channel: 'chrome' }); } catch (_) {}
    try { return await chromium.launch({ headless: true, channel: 'chromium' }); } catch (_) {}
    throw new Error(`Failed to launch browser: ${formatError(err)}. Install Playwright browsers or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.`);
  }
};

/**
 * Create browser/context, navigate and delegate to pdf or html handler.
 * Returns handler result (object ready to be JSON-stringified).
 */
async function handleCrawl(req, res) {
  const url = req.query.url?.trim();
  if (!url) return res.status(400).json({ error: 'Missing url query parameter' });

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
  try {
    // mark request as active in the spinner and reserve a slot in totals
    statusTracker.refreshSpinner({ status: 'active', url: targetUrl.href, archived: false });
    statusTracker.incrementTotal(1);
    // refresh to show updated counts immediately
    statusTracker.refreshSpinner({ status: 'active', url: targetUrl.href, archived: false });
    browser = await launchBrowser();
    context = await browser.newContext({ userAgent: USER_AGENT, ignoreHTTPSErrors: true });
    context.setDefaultNavigationTimeout(constants.NAVIGATION_RETRY_TIMEOUT_MS);
    context.setDefaultTimeout(constants.NAVIGATION_RETRY_TIMEOUT_MS);

  // quick PDF path check by URL
  const isPdfByUrl = /\.pdf(?:$|[?#])/i.test(targetUrl.href);

    // If URL looks like PDF, hand off to pdf handler (it will fetch)
    if (isPdfByUrl) {
      const result = await pdfHandle({ context, url: targetUrl.href });
      // done: archive url and mark success
      statusTracker.incrementSuccess(1);
      statusTracker.refreshSpinner({ status: 'ready', url: targetUrl.href, archived: true });
      return res.json(result);
    }

    // Otherwise navigate and inspect the response
    page = await context.newPage();
  const response = await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded' });
    if (!response) throw new Error('No response received from target URL');

    const ctype = response.headers()['content-type'] ?? '';
    if (ctype.includes('application/pdf')) {
      const result = await pdfHandle({ context, page, response, url: targetUrl.href });
      statusTracker.incrementSuccess(1);
      statusTracker.refreshSpinner({ status: 'ready', url: targetUrl.href, archived: true });
      return res.json(result);
    }

    // HTML path
  const result = await htmlHandle({ context, page, response, url: targetUrl.href });
    statusTracker.incrementSuccess(1);
    statusTracker.refreshSpinner({ status: 'ready', url: targetUrl.href, archived: true });
    return res.json(result);
  } catch (err) {
    logger.error(`[browserService] ${url}: ${formatError(err)}`);
    // mark ready and archive url; total already reserved at request start, mark as ready
    try { statusTracker.refreshSpinner({ status: 'ready', url: targetUrl?.href ?? url, archived: true }); } catch (_) {}
    return res.status(500).json({ error: 'Failed to crawl URL', details: String(err.message ?? err) });
  } finally {
    await Promise.all([page?.close().catch(()=>{}), context?.close().catch(()=>{}), browser?.close().catch(()=>{})]);
  }
}

export { handleCrawl };
