// browserManager.js
import fs from 'fs';
import { chromium } from 'rebrowser-playwright';

const FAST_ARGS = [
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
  // Use only if your environment allows:
  // '--no-sandbox',
  '--password-store=basic',
  '--use-mock-keychain',
];

let browserPromise = null;      // shared across all callers
let lastError = null;

/**
 * Internal: wire 'disconnected' to allow auto-recreate on next call.
 */
function attachLifecycle(browser, { shared = true } = {}) {
  try {
    browser.on?.('disconnected', () => {
      // If this was the shared browser, reset the shared promise so callers can recreate it.
      if (shared) browserPromise = null;
    });
  } catch {}
}

/**
 * Try to connect to an already running Chrome via CDP (fastest).
 */
async function tryConnectCDP() {
  // Customize the endpoint via env if you want
  const endpoint = process.env.PW_CDP_ENDPOINT || 'http://127.0.0.1:9222';
  const browser = await chromium.connectOverCDP(endpoint);
  attachLifecycle(browser, { shared: true });
  return browser;
}

/**
 * Try launching via Playwright "channel" (system Chrome/Chromium).
 */
async function tryLaunchChannel(channel) {
  const browser = await chromium.launch({ headless: true, channel, args: FAST_ARGS });
  attachLifecycle(browser, { shared: true });
  return browser;
}

/**
 * Try launching with explicit executable path (env).
 */
async function tryLaunchExecutable() {
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!execPath || !fs.existsSync(execPath)) {
    throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE not set or path does not exist');
  }
  const browser = await chromium.launch({ headless: true, executablePath: execPath, args: FAST_ARGS });
  attachLifecycle(browser, { shared: true });
  return browser;
}

/**
 * Try default launch (rebrowser cache-managed binary).
 */
async function tryLaunchDefault() {
  const browser = await chromium.launch({ headless: true, args: FAST_ARGS });
  attachLifecycle(browser, { shared: true });
  return browser;
}

/**
 * Create a brand-new browser instance (not the shared one).
 * Useful for per-request isolation. This will NOT set the shared browserPromise.
 */
export async function createNewBrowserInstance() {
  // Try similar strategies as getBrowser but do not touch shared state.
  // Strategy: prefer system channel / default launch. CDP attach is not appropriate for a fresh instance.
  try {
    try {
      return await tryLaunchChannel('chrome');
    } catch (e) {}
    try {
      return await tryLaunchChannel('chromium');
    } catch (e) {}
    try {
      return await tryLaunchExecutable();
    } catch (e) {}
    return await tryLaunchDefault();
  } catch (err) {
    throw new Error(`Failed to create new browser instance: ${String(err && err.message ? err.message : err)}`);
  }
}

/**
 * Idempotent under concurrency:
 * - Returns the same in-flight promise to all concurrent callers.
 * - If creation fails, clears the shared promise so subsequent calls can retry.
 * - If the browser disconnects, the next call will relaunch.
 */
export async function getBrowser() {
  if (browserPromise) return browserPromise;

  // Create once and share the same promise immediately so concurrent calls await the same instance.
  browserPromise = (async () => {
    try {
      // Strategy 1: CDP (attach to pre-launched Chrome)
      try {
        return await tryConnectCDP();
      } catch (e) {
        lastError = e;
      }

      // Strategy 2: system Chrome channels
      try {
        return await tryLaunchChannel('chrome');
      } catch (e) {
        lastError = e;
      }
      try {
        return await tryLaunchChannel('chromium');
      } catch (e) {
        lastError = e;
      }

      // Strategy 3: explicit executable
      try {
        return await tryLaunchExecutable();
      } catch (e) {
        lastError = e;
      }

      // Strategy 4: default rebrowser-managed binary
      return await tryLaunchDefault();

    } catch (err) {
      // Important: clear the shared promise so callers after the failure can retry.
      browserPromise = null;

      const hints = [
        'If using rebrowser-playwright default binary, ensure it is installed:',
        '  npx rebrowser-playwright@latest install chromium --with-deps',
        'Or set an explicit Chrome path:',
        '  export PLAYWRIGHT_CHROMIUM_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
        'Or start Chrome once and use CDP:',
        '  Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/pw-profile',
      ].join('\n');

      const msg = `Failed to obtain a browser instance.\nLast underlying error: ${String(lastError?.message || lastError || err)}\n${hints}`;
      throw new Error(msg);
    }
  })();

  return browserPromise;
}

/**
 * Optional helper: close the shared browser explicitly (e.g., on server shutdown).
 * Safe to call multiple times.
 */
export async function closeSharedBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close().catch(() => {});
  } finally {
    browserPromise = null;
  }
}

/**
 * Optional: expose last error for diagnostics.
 */
export function getLastBrowserError() {
  return lastError;
}

/**
 * Optional: hook process signals to gracefully close the shared browser.
 */
function setupProcessHooksOnce() {
  const close = async () => {
    try { await closeSharedBrowser(); } finally { process.exit(0); }
  };
  process.once?.('SIGINT', close);
  process.once?.('SIGTERM', close);
  process.once?.('beforeExit', async () => { await closeSharedBrowser(); });
}
setupProcessHooksOnce();