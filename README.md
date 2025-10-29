# flashcrawl

flashcrawl is a lightweight crawler built on top of rebrowser-playwright (Playwright with stealth hardening) that captures metadata, HTML, and Markdown from public web pages. It is designed to plug into workflows such as n8n while remaining easy to operate and monitor.

## Features
- `/crawl` endpoint that fetches a URL, follows up to five redirects, and returns structured headers, metadata, Markdown, and a SHA-256 hash of the Markdown. HTML pages are converted with Turndown; PDFs are downloaded to `./tmp` and analysed with `@opendocsg/pdf2md` before hashing.
- Content hygiene: scripts, styles, and other non-content tags are stripped before Markdown conversion by default. Sanitisation can be toggled via environment variables when needed.
- `/status` endpoint exposes uptime and simple runtime status.
- Winston logger writes timestamped log files to the `logs/` directory (one file per day) and can also mirror output to the console.

## Getting Started
1. Install dependencies:
   ```sh
   npm install
   ```
   (Rebrowser Playwright manages its own browser binaries. If the bundled Chromium is missing, run `npx rebrowser-playwright install chromium --with-deps`).
2. Run the server:
   ```sh
   node server.js
   ```
3. The API listens on port `8080` by default. Override with `PORT=3000 node server.js`.

For auto-reload during development, use:
```sh
npm run dev
```

## API Endpoints
- `GET /crawl?url=<targetUrl>` – crawl the provided URL and return structured crawl data (HTML or PDF).
- `GET /status` – runtime metrics including uptime (seconds) and simple runtime status.

## Configuration
You can configure behaviour through a `.env` file:

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Port for the HTTP server. | `8080` |
| `ENABLE_CONSOLE_LOG` | Set to `true` to mirror logs to the console (file logging continues otherwise). | `false` |
| `CRAWL_SANITIZE_HTML` | Set to `false` to skip stripping scripts/styles before Markdown conversion. | `true` |
| `LOG_DIR` | Override the directory used for log files. | `<project>/logs` |
| `CRAWL_SESSION_COOKIE` | Optional cookie string to attach to outbound requests (useful for sites requiring pre-auth). | unset |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Path to an existing Chrome/Chromium binary if you prefer not to install Playwright’s bundle. | unset |

## Response Shape
`/crawl` returns:
```json
{
  "headers": {
    "statusCode": 200,
    "content-encoding": null,
    "content-type": "text/html; charset=utf-8",
    "expires": "Sun, 02 Nov 2025 00:35:10 GMT"
  },
  "metadata": {
    "title": "Page Title",
    "description": "Optional summary",
    "h1": ["Top Level Heading"],
    "h2": ["Subheading"]
  },
  "hash": "abc123def456ghi789jkl012mno345pq",
  "markdown": "# PDF Title\n\n- Item one\n- Item two"
}
```
When the target responds with a PDF, the raw file is saved to `./tmp`, converted to Markdown with `@opendocsg/pdf2md`, and hashed based on that Markdown content.

## Notes
- Requires Node.js ≥ 18.
- Rebrowser Playwright runs headless Chromium by default and manages its own browser binaries.
- Crawl summaries and warnings are handled by Winston; if console logging is disabled they remain available in the daily log files.
