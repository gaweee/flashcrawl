import fs from 'fs';
import { chromium } from 'rebrowser-playwright';

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) return browserPromise;

  // Try CDP first (fastest: attach to an existing Chrome you start once at boot)
  // e.g. start Chrome separately: /path/to/chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-proxy
  try {
    browserPromise = chromium.connectOverCDP('http://127.0.0.1:9222');
    const b = await browserPromise;
    return b;
  } catch {
    // Fall back to launching (second best)
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--no-sandbox',               // only if your environment allows
      '--password-store=basic',
      '--use-mock-keychain',
    ];
    const launchOpts = { headless: true, args };

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE))
        launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    // optional: set executablePath or channel as you already do
    browserPromise = chromium.launch(launchOpts);

    const b = await browserPromise;
    return b;
  }
}

export { getBrowser };