import { createHash } from 'crypto';
import { convertPdfBufferToMarkdown } from '../utils/markdown.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Fetch PDF bytes from the network using a Playwright context.
 * Returns a Buffer.
 */
export async function fetchPdf(context, url) {
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/pdf,*/*;q=0.8',
    referer: url,
    ...(process.env.CRAWL_SESSION_COOKIE && { cookie: process.env.CRAWL_SESSION_COOKIE })
  };

  const resp = await context.request.get(url, { headers });
  if (!resp.ok()) throw new Error(`PDF fetch failed (${resp.status()})`);
  return Buffer.from(await resp.body());
}

/**
 * Convert a PDF buffer to markdown and compute a hash.
 * Returns { markdown, hash, headers, metadata }
 */
export async function processPdfBuffer(buffer, url) {
  const markdown = await convertPdfBufferToMarkdown(buffer);
  const hash = createHash('sha256').update(markdown).digest('hex');
  return {
    url,
    hash,
    headers: { 'content-type': 'application/pdf', status: 200 },
    metadata: {  },
    markdown
  };
}

export async function fetchAndProcessPdf(context, url) {
  const buf = await fetchPdf(context, url);
  return await processPdfBuffer(buf, url);
}

/**
 * Handler entry point for PDFs. Accepts an object with context/page/response/url
 * and returns a response-shaped object: { url, hash, markdown, headers, metadata }
 */
export async function handleRequest({ context, page = null, response = null, url }) {
  // If response available and has body, prefer reading it
  if (response) {
    try {
      const buf = await response.body();
      if (buf && buf.length) return await processPdfBuffer(Buffer.from(buf), url ?? response.url());
    } catch (e) {
      // fallthrough to fetch
    }
  }

  // Otherwise fetch via request API
  const buf = await fetchPdf(context, url);
  return await processPdfBuffer(buf, url);
}
