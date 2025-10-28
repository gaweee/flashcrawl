# flashcrawl

flashcrawl is a lightweight Puppeteer-backed crawler that captures metadata, HTML, and Markdown from public web pages. It is designed to plug into workflows such as n8n while remaining easy to operate and monitor.

## Features
- `/crawl` endpoint that fetches a URL, follows up to five redirects, and returns structured headers, metadata, raw HTML, Markdown, and a SHA-256 hash of the Markdown.
- Content hygiene: scripts, styles, and other non-content tags are stripped before Markdown conversion by default. Opt-in to the full page output with `?fullMarkdown=true`.
- `/status` endpoint exposes uptime, crawl counters, and the latest watchdog observations.
- Watchdog timer warns about event-loop stalls; console output is prettified with `chalk` and `ora` for quick status notes.
- `/` health check for readiness probes.

## Getting Started
1. Install dependencies:
   ```sh
   npm install
   ```
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
- `GET /` – simple health check.
- `GET /crawl?url=<targetUrl>[&fullMarkdown=true]` – crawl the provided URL and return structured crawl data. Pass `fullMarkdown=true` to disable sanitation and receive the original markup/markdown.
- `GET /status` – runtime metrics including uptime (seconds), crawl counters, last status code, last error, and latest watchdog observation.

## Response Shape
`/crawl` returns:
```json
{
  "headers": {
    "statusCode": 200,
    "content-encoding": null,
    "content-type": "text/html; charset=utf-8",
    "content-length": 51558,
    "expires": "Sun, 02 Nov 2025 00:35:10 GMT"
  },
  "metadata": {
    "title": "Page Title",
    "description": "Optional summary",
    "h1": ["Top Level Heading"],
    "h2": ["Subheading"]
  },
  "body": "<!DOCTYPE html><html>...</html>",
  "hash": "abc123def456ghi789jkl012mno345pq",
  "markdown": "# Page Title"
}
```

## Notes
- Requires Node.js ≥ 18.
- Puppeteer runs headless Chrome with `--no-sandbox` flags so it can operate in minimal container environments.
- Watchdog warnings and crawl summaries are logged to stdout with colorized formatting to make operational issues easier to spot at a glance.
