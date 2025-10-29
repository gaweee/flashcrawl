import { URL } from 'url';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import pdf2md from '@opendocsg/pdf2md';

const TRACKER_PREFIXES = ['utm_', 'ref', 'mc_', 'smid'];
const TRACKER_EXACT = ['gclid', 'fbclid', 'igshid'];

const CANDIDATE_SELECTORS = [
  'main article',
  'article[role="article"]',
  'article',
  'main',
  '[role="main"]',
  '#main',
  '#content',
  '.article-content',
  '.content__body',
  '.post-content',
  '.entry-content',
];

const GLOBAL_STRIP_SELECTORS = [
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

const INTERNAL_STRIP_SELECTORS = [
  'nav',
  'footer',
  'header',
  'form',
  'aside',
  '[role="navigation"]',
  '.comments',
  '#comments',
  '.comment',
  '.sso',
  '.login',
  '.subscribe',
  '.newsletter',
  '.promo',
  '.share',
  '.social',
  '.breadcrumbs',
  '.advert',
  '.ads',
];

const NOISE_KEYWORDS = [
  'cookie',
  'consent',
  'banner',
  'subscribe',
  'signup',
  'advert',
  'sponsor',
  'share',
  'social',
  'breadcrumb',
  'comment',
  'related',
  'gdpr',
  'tracking',
];

const SCORE_CONTENT_FLOOR = 150;

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  try {
    const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rawUrl);
    const base = hasProtocol ? undefined : 'https://placeholder.local';
    const url = new URL(rawUrl, base);

    if (hasProtocol && !['http:', 'https:'].includes(url.protocol)) {
      return rawUrl;
    }

    url.hash = '';

    const keysToDelete = [];
    url.searchParams.forEach((_, key) => {
      const lower = key.toLowerCase();
      if (TRACKER_EXACT.includes(lower) || TRACKER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => url.searchParams.delete(key));

    const sanitized = url.toString();
    if (!hasProtocol && base) {
      return sanitized.replace(/^https:\/\/placeholder\.local/, '');
    }
    return sanitized;
  } catch {
    return rawUrl;
  }
}

function normalizeLinks(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => `[${text.trim()}](${sanitizeUrl(url)})`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => `![${(alt || '').trim()}](${sanitizeUrl(url)})`);
}

const createTurndown = () => {
  const service = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx' });
  service.use(gfm);

  service.keep(['figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  service.remove?.(['nav', 'footer', 'header', 'form', 'aside', '.comments', '#comments']);

  service.addRule('dropEmptyHeadings', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement(content, node) {
      const text = (content || '').trim();
      if (!text || /^[\s\W_]+$/.test(text)) {
        return '';
      }
      const level =
        {
          H1: '#',
          H2: '##',
          H3: '###',
          H4: '####',
          H5: '#####',
          H6: '######',
        }[node.nodeName] ?? '#';
      return `${level} ${text}\n\n`;
    },
  });

  service.addRule('cleanLinks', {
    filter: (node) => node.nodeName === 'A' && node.getAttribute('href'),
    replacement(content, node) {
      const text = (content || '').trim();
      if (!text) {
        return '';
      }
      const href = node.getAttribute('href');
      const sanitized = sanitizeUrl(href);
      return `[${text}](${sanitized})`;
    },
  });

  service.addRule('dropNumericSpamBlocks', {
    filter: (node) => node.nodeName === 'PRE' || node.nodeName === 'CODE',
    replacement(content) {
      const text = (content || '').trim();
      if (!text || /^[\d\s\t\n]+$/.test(text)) {
        return '';
      }
      return `\n\`\`\`\n${text}\n\`\`\`\n\n`;
    },
  });

  return service;
};

const turndown = createTurndown();

export const cleanMarkdown = (markdown) => {
  if (!markdown) return '';

  let output = markdown.replace(/\r/g, '').replace(/\t+/g, ' ').replace(/[ \t]+\n/g, '\n');

  output = output
    .replace(/^-{5,}\s*$/gm, '---')
    .replace(/^\s*\d{1,3}\s*$/gm, '')
    .replace(/(?:^|\n)---\n+Post\s*(?=\n|$)/g, '\n')
    .replace(/\(#(?:comments?|respond)\)/gi, ')')
    .replace(/-{20,}/g, '—')
    .replace(/^(?:#{1,6})\s*$/gm, '')
    .replace(/^\s{3,}([-*+] )/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '');

  output = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, arr) => {
      if (!line.trim() && index > 0 && !arr[index - 1].trim()) {
        return false;
      }
      return true;
    })
    .join('\n');

  output = normalizeLinks(output);

  return output.trim();
};

export const extractHtmlContent = async (page, { sanitize = true } = {}) => {
  let html, metadata;
  try {
    ({ html, metadata } = await page.evaluate(
      ({
        candidateSelectors,
        globalStripSelectors,
        internalStripSelectors,
        noiseKeywords,
        shouldSanitize,
        scoreFloor,
      }) => {
      const removeBySelectors = (root, selectors) => {
        selectors.forEach((selector) => {
          root.querySelectorAll(selector).forEach((node) => node.remove());
        });
      };

      const noisePattern = noiseKeywords.length ? new RegExp(noiseKeywords.join('|'), 'i') : null;

      if (shouldSanitize) {
        removeBySelectors(document, globalStripSelectors);
      }

      const candidates = [];
      candidateSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => {
          if (node && !candidates.includes(node)) {
            candidates.push(node);
          }
        });
      });

      const scoreNode = (node) => {
        if (!node) {
          return 0;
        }
        const text = (node.innerText || '').replace(/\s+/g, ' ');
        const structureScore = node.querySelectorAll('p,li,h1,h2,h3,figure,table').length * 35;
        return text.length + structureScore;
      };

      let root = document.body;
      let bestScore = scoreNode(root);
      candidates.forEach((candidate) => {
        const candidateScore = scoreNode(candidate);
        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          root = candidate;
        }
      });

      if (bestScore < scoreFloor) {
        root = document.body;
      }

      const clone = root.cloneNode(true);

      if (shouldSanitize) {
        removeBySelectors(clone, internalStripSelectors);

        Array.from(clone.querySelectorAll('*')).forEach((element) => {
          const signature = `${element.className || ''} ${element.id || ''}`.toLowerCase();
          if (noisePattern && signature && noisePattern.test(signature)) {
            element.remove();
            return;
          }

          const style = window.getComputedStyle(element);
          if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
            element.remove();
            return;
          }
        });
      }

      const uniqueText = (selector) =>
        Array.from(clone.querySelectorAll(selector))
          .map((node) => (node.textContent || '').trim())
          .filter((text) => Boolean(text))
          .filter((text, index, arr) => arr.indexOf(text) === index);

      return {
        html: '<!DOCTYPE html>' + clone.outerHTML,
        metadata: {
          title: document.title || null,
          description:
            document.querySelector('meta[name="description"]')?.getAttribute('content') ??
            document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
            null,
          h1: uniqueText('h1'),
          h2: uniqueText('h2'),
        },
      };
      },
      {
        candidateSelectors: CANDIDATE_SELECTORS,
        globalStripSelectors: GLOBAL_STRIP_SELECTORS,
        internalStripSelectors: INTERNAL_STRIP_SELECTORS,
        noiseKeywords: NOISE_KEYWORDS,
        shouldSanitize: sanitize,
        scoreFloor: SCORE_CONTENT_FLOOR,
      },
    ));
  } catch (err) {
    // If the page navigated while evaluating, the execution context can be destroyed.
    // Fallback: grab the raw page HTML and extract minimal metadata via simple regex.
    const msg = String(err && err.message ? err.message : err);
    if (/Execution context was destroyed/i.test(msg) || /context was destroyed/i.test(msg)) {
      html = '<!DOCTYPE html>' + (await page.content());

      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) || html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i);

      const h1Matches = Array.from(html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gi)).map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
      const h2Matches = Array.from(html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)).map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);

      metadata = {
        title: titleMatch ? titleMatch[1].trim() : null,
        description: descMatch ? descMatch[1].trim() : null,
        h1: Array.from(new Set(h1Matches)).slice(0, 5),
        h2: Array.from(new Set(h2Matches)).slice(0, 5),
      };
    } else {
      throw err;
    }
  }

  const htmlForMarkdown = html || (await page.content());
  const markdown = cleanMarkdown(turndown.turndown(htmlForMarkdown));

  return {
    markdown,
    metadata,
  };
};

export const convertPdfBufferToMarkdown = async (buffer) => {
  const pdfMarkdown = await pdf2md(buffer, {});
  return cleanMarkdown(pdfMarkdown);
};
