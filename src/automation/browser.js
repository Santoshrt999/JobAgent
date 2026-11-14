/**
 * Browser session wrapper (Playwright).
 *
 * Thin, dependency-injected wrapper around Playwright so the rest of the
 * automation layer never imports Playwright directly (keeps it testable and
 * lets us run headed by default for human oversight). This module only opens
 * pages and reports what it sees — it performs no evasion and never tries to get
 * past a CAPTCHA, login, MFA, or bot wall.
 */

import { waitForSettledPage } from './navigator.js';
import { detectBlocker } from './guards.js';

/**
 * Create a browser session.
 *
 * Two modes:
 *  - Isolated (default): a fresh, empty context. Best for clean, repeatable runs.
 *  - Persistent profile: pass `userDataDir` (and usually `channel: 'msedge'`) to
 *    launch your REAL, installed browser reusing your signed-in profile, so job
 *    sites you are already logged into don't prompt again. Close every window of
 *    that browser first — a profile can only be opened by one process at a time.
 *
 * This wrapper performs no evasion and never tries to defeat a CAPTCHA/login/MFA;
 * reusing your own profile is purely a convenience so you don't re-authenticate.
 *
 * @param {object} [options]
 * @param {boolean} [options.headless=false] run headless (default headed for oversight)
 * @param {number} [options.slowMo=0]
 * @param {string|null} [options.channel] installed browser channel, e.g. 'msedge' | 'chrome'
 * @param {string|null} [options.userDataDir] reuse this browser profile directory
 * @param {object} [options.deps]
 * @param {object} [options.deps.chromium] inject a Playwright browser type (testing)
 * @returns {Promise<{ browser: object, context: object, page: object, close: Function }>}
 */
/**
 * Live persistent contexts by userDataDir.
 *
 * A Chromium profile can only be opened by ONE browser process at a time, and
 * assist deliberately leaves each review window open for the human. Without
 * reuse, the SECOND auto-apply in a row spawns a launch against the locked
 * profile that dies instantly ("Target ... has been closed") — the browser
 * appears but never navigates or fills. Reusing the live context and giving
 * each job its own TAB is the only way consecutive auto-applies work.
 * Keyed by the chromium implementation too, so injected test fakes never leak
 * between tests.
 */
const liveProfiles = new Map(); // userDataDir -> { context, chromium, closed }

/** A session backed by the SHARED profile context: close() closes only its tab. */
function sharedSession(context, page) {
  return {
    browser: context.browser?.() ?? null,
    context,
    page,
    shared: true,
    async close() {
      try { await page.close(); } catch { /* ignore */ }
    },
  };
}

export async function createBrowserSession({
  headless = false, slowMo = 0, channel = null, userDataDir = null, deps = {},
} = {}) {
  const chromium = deps.chromium ?? (await import('playwright')).chromium;

  // Persistent profile: reuse a real, signed-in browser profile.
  if (userDataDir) {
    const entry = liveProfiles.get(userDataDir);
    if (entry && !entry.closed && entry.chromium === chromium) {
      try {
        const page = await entry.context.newPage();
        return sharedSession(entry.context, page);
      } catch {
        // The human closed the whole window since last time — relaunch below.
        liveProfiles.delete(userDataDir);
      }
    }
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        slowMo,
        ...(channel ? { channel } : {}),
        acceptDownloads: false,
      });
      const e = { context, chromium, closed: false };
      context.once?.('close', () => {
        e.closed = true;
        if (liveProfiles.get(userDataDir) === e) liveProfiles.delete(userDataDir);
      });
      liveProfiles.set(userDataDir, e);
      const page = context.pages()[0] ?? (await context.newPage());
      return sharedSession(context, page);
    } catch {
      // The profile is locked by a browser this process does NOT own (e.g. a
      // review window survived a server restart). Fall back to an ISOLATED
      // context so the fill still navigates — saved logins just won't apply
      // to this one run.
    }
  }

  // Isolated context (default, and the locked-profile fallback).
  const browser = await chromium.launch({ headless, slowMo, ...(channel ? { channel } : {}) });
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async close() {
      try { await context.close(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Navigate to an application URL and immediately run the safety guards.
 *
 * @param {object} page Playwright page
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<{ status: number|null, html: string, guard: object }>}
 */
export async function openApplicationPage(page, url, { timeoutMs = 30000, settleMs = 12000 } = {}) {
  let status = null;
  let html = '';
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    status = response?.status ? response.status() : null;
  } catch (err) {
    // Navigation failure is itself a stop condition; surface as a bot-like block.
    return { status, html, guard: { blocked: true, kind: 'navigation', reason: err.message, signals: [] } };
  }
  // `domcontentloaded` is an empty shell on single-page ATSes; read the page
  // only once it has drawn its controls (bounded — see waitForSettledPage).
  await waitForSettledPage(page, { timeoutMs: settleMs });
  try {
    html = await page.content();
  } catch { /* ignore — guard will treat empty html conservatively */ }

  const guard = detectBlocker({ html, url, status });
  return { status, html, guard };
}

/**
 * Re-inspect the page WITHOUT navigating (used between multi-step pages after a
 * "Next"/"Continue" click). Reads the current content and re-runs the guards so
 * the assistant stops if a later step throws up a CAPTCHA/login/bot wall.
 *
 * @param {object} page Playwright page
 * @param {string} [url] fallback URL when page.url() is unavailable
 * @returns {Promise<{ status: null, html: string, url: string, guard: object }>}
 */
export async function inspectCurrentPage(page, url = '') {
  let html = '';
  try { html = await page.content(); } catch { /* ignore — guard treats empty html conservatively */ }
  let finalUrl = url;
  try { finalUrl = (typeof page.url === 'function' ? page.url() : url) || url; } catch { /* ignore */ }
  const guard = detectBlocker({ html, url: finalUrl, status: null });
  return { status: null, html, url: finalUrl, guard };
}

/** The one line a user needs when Playwright's browser is not installed. */
export const BROWSER_UNAVAILABLE_MESSAGE = 'Browser not installed — run: npx playwright install chromium';

/** Stable status-reason code for a missing browser (read by the dashboard). */
export const BROWSER_UNAVAILABLE_CODE = 'browser_unavailable';

/**
 * Does this launch error mean the browser binary is missing (as opposed to a
 * locked profile or a crash)?
 * @param {unknown} err
 * @returns {boolean}
 */
export function isBrowserMissingError(err) {
  return /executable doesn't exist|executable does not exist|playwright install|browserType\.launch.*not found|failed to launch.*no such file/i
    .test(String(err?.message ?? err ?? ''));
}

/**
 * Remove Playwright's ASCII box banner ("╔═══╗ ║ Looks like Playwright … ║ ╚═══╝")
 * and collapse the rest onto one line. The banner is 8+ lines of box drawing;
 * stored as a status reason it rendered as a wall of pipes on the board.
 * @param {unknown} message
 * @returns {string}
 */
export function stripPlaywrightBanner(message) {
  return String(message ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^[\s╔╗╚╝═║─│┌┐└┘|+-]*$/.test(line))
    .map((line) => line.replace(/[╔╗╚╝═║─│┌┐└┘]/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is the bundled Chromium installed? Checked before a batch opens anything, so
 * a missing browser fails the whole batch once, clearly, instead of once per
 * job with a Playwright stack banner.
 *
 * A configured channel (msedge / chrome) uses the system browser, which
 * Playwright locates at launch time, so only bundled Chromium is checked.
 *
 * @param {object} [args]
 * @param {string|null} [args.channel]
 * @param {object} [args.chromium] injected Playwright browser type (tests)
 * @param {(path: string) => boolean} [args.exists]
 * @returns {Promise<{ok: boolean, code?: string, message?: string, executablePath?: string|null}>}
 */
export async function checkBrowserAvailable({ channel = null, chromium, exists } = {}) {
  if (channel) return { ok: true, executablePath: null };
  try {
    const type = chromium ?? (await import('playwright')).chromium;
    const path = type.executablePath();
    const fileExists = exists ?? (await import('node:fs')).existsSync;
    if (path && fileExists(path)) return { ok: true, executablePath: path };
    return { ok: false, code: BROWSER_UNAVAILABLE_CODE, message: BROWSER_UNAVAILABLE_MESSAGE, executablePath: path ?? null };
  } catch (err) {
    return { ok: false, code: BROWSER_UNAVAILABLE_CODE, message: BROWSER_UNAVAILABLE_MESSAGE, detail: stripPlaywrightBanner(err?.message) };
  }
}
