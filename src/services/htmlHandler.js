import { createHash } from 'crypto';
import { extractHtmlContent } from '../utils/markdown.js';
import { config } from '../config.js';

/**
 * Process an HTML page and return markdown, metadata and headers
 */
export async function processHtml(page, response) {
  const { markdown, metadata } = await extractHtmlContent(page, { sanitize: config.sanitizeHtml });
  const hash = createHash('sha256').update(markdown).digest('hex');
  return {
    markdown,
    metadata: metadata ?? { title: null, description: null, h1: [], h2: [] },
    hash,
    headers: {
      'content-type': response.headers()['content-type'] || 'text/html',
      status: response.status()
    }
  };
}

/**
 * Handler entry point for HTML pages. Accepts { context, page, response, url }
 * If page/response not provided it will create a page and navigate to url.
 * Returns { markdown, metadata, hash, headers }
 */
export async function handleRequest({ context, page = null, response = null, url }) {
  let created = false;
  try {
    if (!page) {
      page = await context.newPage();
      created = true;
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response) throw new Error('No response from page');
    return await processHtml(page, response);
  } finally {
    if (created && page) await page.close().catch(() => {});
  }
}
