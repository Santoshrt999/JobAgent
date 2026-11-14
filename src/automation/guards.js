/**
 * Page safety guards.
 *
 * Pure, deterministic detectors for situations the agent must NEVER try to get
 * past: CAPTCHAs, login/auth walls, multi-factor prompts, and bot-protection
 * interstitials (Cloudflare/PerimeterX/etc.). These functions inspect page text
 * + URL only and return a structured verdict. The automation layer uses them to
 * STOP and hand control back to the human — it never solves, bypasses, or
 * automates around any of these.
 */

/**
 * STRONG signals: unambiguous "you are blocked" phrases. The mere presence of
 * any of these means the page IS a challenge/login/interstitial — we block
 * regardless of how much other content is on the page.
 */
const BLOCKING_PHRASES = Object.freeze({
  captcha: [
    'are you a robot', 'i am not a robot', 'verify you are human',
    'verify you are a human', 'please verify you are human',
    'complete the security check', 'complete a security check',
    'press and hold to confirm', 'solve the puzzle to continue',
  ],
  login: [
    'sign in to continue', 'please log in', 'please sign in', 'log in to apply',
    'sign in to apply', 'create an account to apply', 'login required',
    'you must be logged in', 'session expired',
    // Aggregator account gates (e.g. Indeed's interstitial before redirecting
    // to the company site). We never auto-create accounts or replay logins.
    'create an account or sign in', 'before applying on company site',
    'you must create an indeed account',
  ],
  // Only imperative, second-person prompts belong here — they are things a
  // challenge page SAYS TO YOU, not vocabulary a job description can contain.
  // The bare "two-factor"/"multi-factor" nouns moved to THIN_ONLY_TOKENS.
  mfa: [
    'one-time passcode', 'one time passcode', 'authenticator app',
    'enter the code we sent', 'enter the verification code',
    'security code we sent',
  ],
  bot: [
    'checking your browser', 'ddos protection',
    'request blocked', 'unusual traffic', 'bot detection',
    // Cloudflare's "Additional Verification Required" interstitial (shows a
    // Ray ID). Indeed fronts its pages with this and blocks automated browsers.
    'additional verification required',
    'troubleshooting cloudflare errors',
  ],
});

/**
 * Bot-protection VENDOR names. These were strong signals matched against the
 * raw HTML, and every one of them ships on ordinary, fully usable pages: a
 * DataDome/PerimeterX/Incapsula sensor script, or a `cf-ray` in a Cloudflare
 * analytics beacon, sits on a large share of careers sites and ATS forms. A
 * clean application that merely loaded the vendor's script stopped as a "bot
 * wall". They now count only on a thin page or next to a real challenge
 * element (see CHALLENGE_ELEMENT_RE).
 */
const VENDOR_TOKENS = Object.freeze(['perimeterx', 'datadome', 'incapsula', 'akamai bot manager', 'cf-ray']);

/**
 * Markup that only an actual challenge page renders (as opposed to a vendor's
 * passive sensor script).
 */
const CHALLENGE_ELEMENT_RE = /id=["']?(?:challenge-form|challenge-running|challenge-stage|cf-challenge-running|px-captcha)\b|class=["'][^"']*\bcf-(?:challenge|chl)[\w-]*|captcha-delivery\.com|_incapsula_resource|\/cdn-cgi\/challenge-platform\/h\//i;

/**
 * Visible-ish text of an HTML document: scripts, styles and markup removed.
 *
 * The guard used to search the RAW HTML, so a phrase inside a JavaScript
 * bundle — "please sign in to continue", "session expired", "unusual traffic"
 * are all error templates shipped by ordinary ATS bundles — stopped runs on
 * pages that showed none of it. Submission verification had already moved to
 * visible text (commit 5416e96) for exactly this reason; the page guard now
 * does the same. Plain text input passes through unchanged.
 *
 * @param {string} html
 * @returns {string}
 */
export function visibleText(html = '') {
  return String(html ?? '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markup with script/style BODIES removed but tags and attributes kept. */
function markupWithoutScripts(html = '') {
  return String(html ?? '').replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, '<$1$2></$1>');
}

/**
 * Tokens that DO appear on real bot walls but also appear innocently inside
 * ordinary application pages and job descriptions — so they count only on a
 * THIN, dedicated interstitial (same rule as the captcha/MFA widget tokens).
 *
 * Every one of these was previously a STRONG signal matched against the whole
 * page HTML including the JD text, which stopped legitimate runs:
 *   - "access denied"     : appears in security-engineering JDs and in ordinary
 *                           inline form errors
 *   - "attention required": Cloudflare's title, but also a perfectly normal ATS
 *                           validation banner ("Attention required: complete
 *                           all fields")
 *   - "ray id"            : matched any page containing that two-word sequence
 *   - "two-factor"/"multi-factor": extremely common in security/platform JDs
 */
const THIN_ONLY_TOKENS = Object.freeze({
  bot: ['access denied', 'attention required', 'ray id'],
  mfa: ['two-factor', 'two factor', 'multi-factor', 'multifactor'],
});

/**
 * WEAK signals: tokens that ALSO appear on perfectly usable pages, because many
 * career/ATS sites embed a captcha or 2FA widget in a newsletter/search/alert
 * form (e.g. "Get notified for similar jobs"). These count as a block ONLY when
 * the page is a thin, dedicated challenge/interstitial — never when the widget
 * is merely embedded in a full job/application page. This prevents the agent
 * from falsely stopping on a clean posting that happens to load reCAPTCHA.
 */
const WIDGET_TOKENS = Object.freeze({
  captcha: [
    'recaptcha', 'g-recaptcha', 'grecaptcha', 'hcaptcha', 'h-captcha',
    'cf-turnstile', 'turnstile', 'captcha',
  ],
  mfa: ['2fa', 'verification code', 'security code'],
});

/** A dedicated challenge/interstitial page is short; real content pages are not. */
const THIN_PAGE_MAX = 2000;

/** URL-host fragments that indicate an auth/login redirect. */
const LOGIN_URL_HINTS = ['/login', '/signin', '/sign-in', '/auth', '/account/login', 'accounts.google.com'];

/**
 * Oracle Recruiting (Fusion HCM) sends Apply to `.../job/<id>/apply/email`: an
 * "Authentication screen" that asks for an email address (and usually verifies
 * it) before the application form exists. Its own wording ("You don't need to
 * have an account") matches no login phrase, so a run carried on and tried to
 * fill a page with no form on it (2026-11-13). The step is identified by its
 * URL, which is exact, instead of by phrases a posting could also contain. The
 * boundary after "email" keeps `/apply/emailed-…` from matching.
 */
const ORACLE_EMAIL_STEP = /\/hcmui\/candidateexperience\/[^?#]*\/job\/\d+\/apply\/email(?:[/?#]|$)/;

/**
 * Inspect page content + URL for blocking conditions.
 *
 * @param {object} input
 * @param {string} [input.html] page HTML or visible text
 * @param {string} [input.url] current URL
 * @param {number} [input.status] HTTP status code, if known
 * @returns {{
 *   blocked: boolean,
 *   kind: 'captcha'|'login'|'mfa'|'bot'|null,
 *   reason: string|null,
 *   signals: string[]
 * }}
 */
export function detectBlocker({ html = '', url = '', status } = {}) {
  const raw = String(html ?? '');
  // Phrases are matched against what a human would SEE; widget and vendor
  // tokens against markup (class names, script src) minus script bodies.
  const text = visibleText(raw).toLowerCase();
  const markup = markupWithoutScripts(raw).toLowerCase();
  const signals = [];

  // HTTP-level blocks first (cheap + unambiguous).
  if (status === 401 || status === 403) {
    return block(status === 401 ? 'login' : 'bot', `HTTP ${status}`, [`http:${status}`]);
  }
  if (status === 429) {
    return block('bot', 'HTTP 429 (rate limited)', ['http:429']);
  }

  // URL-based login redirect. Each hint must end at a path/query boundary so
  // "/auth" never matches "/author…" and "/signin" never matches a longer slug.
  const urlLower = String(url ?? '').toLowerCase();
  for (const hint of LOGIN_URL_HINTS) {
    if (hintMatchesUrl(urlLower, hint)) {
      signals.push(`url:${hint}`);
    }
  }

  if (ORACLE_EMAIL_STEP.test(urlLower)) {
    return block(
      'login',
      'Oracle Recruiting asks for your email (and may verify it) before the application form; do that in the open browser window, then retry',
      [...signals, 'url:oracle-apply-email'],
    );
  }

  // 1) Strong, unambiguous challenge phrases — block regardless of page size.
  for (const kind of ['captcha', 'mfa', 'bot', 'login']) {
    const hit = BLOCKING_PHRASES[kind].find((token) => text.includes(token));
    if (hit) return block(kind, `${kind} signal: "${hit}"`, [...signals, `text:${hit}`]);
  }

  // 2) Weak tokens count only on a THIN, dedicated challenge page — not when a
  //    captcha/2FA widget (or the words "access denied") merely appear inside a
  //    full job/application page. "Thin" is measured on VISIBLE text: a
  //    challenge page can carry 200 KB of script and still show one sentence.
  const thin = raw.length > 0 && text.length <= THIN_PAGE_MAX;
  const challengeElement = CHALLENGE_ELEMENT_RE.test(markup);
  if (thin || challengeElement) {
    const vendor = VENDOR_TOKENS.find((token) => markup.includes(token) || text.includes(token));
    if (vendor) return block('bot', `bot protection: "${vendor}"`, [...signals, `vendor:${vendor}`]);
  }
  if (thin) {
    for (const kind of ['captcha', 'mfa']) {
      const hit = WIDGET_TOKENS[kind].find((token) => markup.includes(token) || text.includes(token));
      if (hit) return block(kind, `${kind} challenge: "${hit}"`, [...signals, `text:${hit}`]);
    }
    for (const kind of ['bot', 'mfa']) {
      const hit = (THIN_ONLY_TOKENS[kind] ?? []).find((token) => text.includes(token));
      if (hit) return block(kind, `${kind} interstitial: "${hit}"`, [...signals, `text:${hit}`]);
    }
  }

  if (signals.length) {
    return block('login', `login redirect (${signals.join(', ')})`, signals);
  }

  return { blocked: false, kind: null, reason: null, signals: [] };
}

function block(kind, reason, signals) {
  return { blocked: true, kind, reason, signals };
}

/**
 * True when a login hint appears in the URL at a segment boundary — followed
 * by / ? # & . or the end of the string. Prevents substring false positives
 * like "/auth" matching a legitimate "/authors" or "/authorized-dealers" page.
 * @param {string} urlLower lowercased URL
 * @param {string} hint one of LOGIN_URL_HINTS
 * @returns {boolean}
 */
function hintMatchesUrl(urlLower, hint) {
  let from = 0;
  for (;;) {
    const idx = urlLower.indexOf(hint, from);
    if (idx === -1) return false;
    const next = urlLower[idx + hint.length];
    if (next === undefined || '/?#&.'.includes(next)) return true;
    from = idx + 1;
  }
}

/** True when the page is safe to interact with (no blocker detected). */
export function isSafeToProceed(input) {
  return !detectBlocker(input).blocked;
}

/** Combined view of every known signal token (handy for diagnostics/tests). */
export const GUARD_SIGNALS = Object.freeze({
  captcha: [...BLOCKING_PHRASES.captcha, ...WIDGET_TOKENS.captcha],
  login: [...BLOCKING_PHRASES.login],
  mfa: [...BLOCKING_PHRASES.mfa, ...WIDGET_TOKENS.mfa, ...THIN_ONLY_TOKENS.mfa],
  bot: [...BLOCKING_PHRASES.bot, ...VENDOR_TOKENS, ...THIN_ONLY_TOKENS.bot],
});
