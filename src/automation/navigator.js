/**
 * Multi-step form navigator.
 *
 * Many application flows span several pages: fill page 1, click "Next" /
 * "Continue", fill page 2, and so on until a final "Submit". This module finds
 * the control that advances to the next step (NOT the final submit) and clicks
 * it, then waits for the next step to settle. It also helps locate a final
 * submit control when the packet's static selector is absent.
 *
 * It is intentionally conservative:
 *   - "Advance" buttons (Next/Continue/Review) move forward; they are safe.
 *   - "Submit/Finish" controls are reported separately and are NEVER clicked
 *     here — the only path to a submit is the pure submit gate in applyRunner.
 *   - All DOM reads happen via `page.evaluate`; with no `evaluate` (unit fakes)
 *     the finders return null so the caller degrades to single-page behavior.
 */

/** Text that means "go to the next step" (forward, not final). */
export const ADVANCE_RE = /\b(next|continue|proceed|review|save\s*(?:and|&)\s*continue|next\s*step|go\s*to\s*next)\b/i;

/**
 * Text that opens/starts an application from a JD landing page. NOT a general
 * advance control: on one-page/quick-apply flows "Apply now" IS the final
 * submit, so these are only clicked on a page with no form fields at all
 * (a pure landing page) — never on a page we just filled.
 */
export const APPLY_START_RE = /\b(start\s*(?:your\s*|my\s*)?application|apply\s*now|apply\s*online|apply\s*(?:for|to)\s*(?:this\s*)?(?:job|position|role|opening|vacancy)|i'?m\s*interested|apply\s*here|apply\s*manually)\b|^\s*apply\s*$/i;

/**
 * Apply controls that leave for someone else's sign-in (LinkedIn/Indeed/…
 * OAuth) or are not about applying at all ("Apply filters"). Never a way in.
 */
export const NOT_APPLY_START_RE = /\bwith\s+(?:linkedin|indeed|google|facebook|seek|xing|glassdoor)\b|\bapply\s*(?:filters?|changes|coupon|settings)\b|\bapplied\b/i;

/** Text that means "this is the FINAL submit" — never auto-clicked by the navigator. */
export const SUBMIT_RE = /\b(submit|finish|send\s*application|complete\s*application|submit\s*application)\b/i;

/* c8 ignore start - executes in the browser, not under node coverage */
function collectClickables() {
  const cssEscape = (s) =>
    (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const selectorFor = (el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.name) {
      if (type) return `${tag}[name="${cssEscape(el.name)}"][type="${type}"]`;
      return `${tag}[name="${cssEscape(el.name)}"]`;
    }
    if (type === 'submit' || type === 'button') return `${tag}[type="${type}"]`;
    return null;
  };

  // Buttons first, then plain links whose words open an application: on
  // Lever, iCIMS, SmartRecruiters and many career sites "Apply" is an
  // <a href>, which the button-only query never saw — so a landing page "had
  // no way in" and the run stopped on the job description.
  const APPLYISH = /\bapply\b|\bstart\b.*\bapplication\b|\binterested\b/i;
  // An open modal owns the page: Workday's Apply opens "Start Your
  // Application" (Autofill with Resume / Apply Manually / …) over the posting,
  // and the old scan found the covered "Apply" behind it again on every step.
  // Only a dialog that is part of applying counts: a cookie/consent banner
  // is often role="dialog" too (Oracle's is), and owning the page to it hid
  // "Apply Now" behind "Accept all / Reject all".
  const CONSENT = /cookie|consent|onetrust|gdpr|privacy.?pref|truste/i;
  const STEPPY = /\b(apply|next|continue|start|submit|review)\b/i;
  const modal = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
    .find((m) => isVisible(m)
      && !CONSENT.test([m.id, m.className, m.getAttribute('aria-label'), m.getAttribute('aria-labelledby')].join(' '))
      && !m.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i]')
      && Array.from(m.querySelectorAll('button, a[href], [role="button"]'))
        .some((c) => isVisible(c) && STEPPY.test(c.textContent || c.getAttribute('aria-label') || '')));
  const root = modal || document;
  const buttons = Array.from(root.querySelectorAll(
    'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]',
  ));
  const links = Array.from(root.querySelectorAll('a[href]:not([role="button"])'));
  const out = [];
  let tag = 0;
  const push = (el, isLink) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    if (!isVisible(el)) return;
    const text = (el.value || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80) return;
    if (isLink && !APPLYISH.test(text)) return;
    // A per-scan handle the click can always resolve, even for a control
    // with no id/name (Oracle's "Apply Now" has neither). Only the advance
    // click uses it; the submit gate keeps requiring a real selector.
    tag += 1;
    el.setAttribute('data-jobagent-nav', String(tag));
    const href = el.tagName === 'A' && /^https?:/i.test(el.href || '') ? el.href : null;
    out.push({
      text,
      selector: selectorFor(el),
      navSelector: `[data-jobagent-nav="${tag}"]`,
      link: isLink,
      href,
      newTab: (el.getAttribute('target') || '').toLowerCase() === '_blank',
    });
  };
  for (const el of buttons) { if (out.length >= 60) break; push(el, false); }
  for (const el of links) { if (out.length >= 80) break; push(el, true); }
  return out;
}
/* c8 ignore stop */

async function collect(page) {
  if (!page || typeof page.evaluate !== 'function') return [];
  try {
    const list = await page.evaluate(collectClickables);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Find the control that advances to the next step (forward, not final submit).
 *
 * @param {object} page
 * @param {object} [options]
 * @param {boolean} [options.allowApplyStart=false] also accept "Apply now" /
 *   "Start application" — pass true ONLY on a fieldless JD landing page, where
 *   such a button opens the form (on a filled one-page form it IS the submit).
 * @returns {Promise<{selector: string|null, text: string}|null>}
 */
export async function findAdvanceControl(page, { allowApplyStart = false } = {}) {
  const list = await collect(page);
  // On a fieldless landing page the way IN wins over any "Next": a "Next"
  // there is a carousel of similar jobs or a pager, never the application.
  if (allowApplyStart) {
    const start = list.find((c) => !SUBMIT_RE.test(c.text) && !NOT_APPLY_START_RE.test(c.text)
      && APPLY_START_RE.test(c.text));
    if (start) return start;
  }
  for (const c of list) {
    if (c.link) continue; // links only ever count as a way in, above
    if (SUBMIT_RE.test(c.text)) continue; // never treat a final submit as "advance"
    if (ADVANCE_RE.test(c.text)) return c;
  }
  return null;
}

/**
 * Find a final submit control on the page (for when the packet has none).
 * @param {object} page
 * @returns {Promise<{selector: string|null, text: string}|null>}
 */
export async function findSubmitControl(page) {
  const list = await collect(page);
  const hit = list.find((c) => !c.link && SUBMIT_RE.test(c.text) && c.selector);
  return hit ?? null;
}

/**
 * Click a control and wait for the next step to settle.
 *
 * @param {object} page
 * @param {{selector: string|null, text: string}} control
 * @param {object} [deps]
 * @param {Function} [deps.wait] async settle hook (default: load-state + 400ms)
 * @param {object} [options]
 * @param {boolean} [options.selectorOnly=false] forbid the accessible-name
 *   fallback. Set for the FINAL submit: the runner earns the right to click only
 *   after verifying that one specific selector resolves to exactly one element.
 *   If the DOM changed since that check, falling back to "any button named
 *   Submit" could click a different form's submit, so we refuse and let the
 *   human finish instead.
 * @returns {Promise<boolean>} true if the click was issued
 */
export async function clickAndSettle(page, control, deps = {}, options = {}) {
  if (!control) return false;
  const submitNamed = SUBMIT_RE.test(control.text ?? '');
  const unique = async (selector) => {
    if (!selector || typeof page.locator !== 'function') return null;
    try { return (await page.locator(selector).count()) === 1 ? page.locator(selector).first() : null; }
    catch { return null; }
  };
  let loc = await unique(control.selector);
  if (!loc && options.selectorOnly === true) return false;
  // The fallbacks may never reach a submit. A submit-named control must earn
  // a unique selector (see selectorOnly), and a name match is EXACT: by
  // default Playwright matches the name as a case-insensitive SUBSTRING, so
  // a "Review" step resolved to a "Review and Submit" button and submitted.
  if (!loc && !submitNamed) loc = await unique(control.navSelector);
  if (!loc && !submitNamed && typeof page.getByRole === 'function' && control.text) {
    for (const role of control.link ? ['link', 'button'] : ['button', 'link']) {
      try {
        const byName = page.getByRole(role, { name: control.text, exact: true });
        const found = typeof byName.count === 'function' ? await byName.count() : 1;
        if (found > 0) { loc = byName.first(); break; }
      } catch { /* try the next role */ }
    }
  }

  // An Apply LINK that opens a new tab would leave the run filling the old
  // tab, so a plain http(s) link is followed in this tab instead.
  if (!submitNamed && control.href && control.newTab && typeof page.goto === 'function') {
    try { await page.goto(control.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { return false; }
    await settle(page, deps);
    return true;
  }
  if (!loc) return false;

  // An Apply BUTTON that pops a window (window.open) is caught the same way:
  // its address is reopened here and the extra tab closed.
  const context = contextOf(page);
  const popups = [];
  const onPopup = (p) => popups.push(p);
  try { context?.on?.('page', onPopup); } catch { /* no context on a fake */ }
  try {
    await loc.click({ timeout: 10000 });
  } catch {
    try { context?.off?.('page', onPopup); } catch { /* ignore */ }
    return false;
  }
  await settle(page, deps);
  try { context?.off?.('page', onPopup); } catch { /* ignore */ }
  const popup = popups[0];
  if (popup && !submitNamed && typeof page.goto === 'function') {
    try {
      await popup.waitForLoadState?.('domcontentloaded', { timeout: 15000 });
      const target = popup.url?.();
      if (/^https?:/i.test(target ?? '')) {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await popup.close?.();
        await settle(page, deps);
      }
    } catch { /* the popup stays open for the human; the run continues here */ }
  }
  return true;
}

/** The browser context a page or frame belongs to (null on fakes). */
function contextOf(scope) {
  try {
    if (typeof scope?.context === 'function') return scope.context();
    if (typeof scope?.page === 'function') return scope.page()?.context?.() ?? null;
  } catch { /* fall through */ }
  return null;
}

async function settle(page, deps) {
  if (typeof deps.wait === 'function') { await deps.wait(page); return; }
  try { await page.waitForLoadState?.('domcontentloaded', { timeout: 15000 }); } catch { /* ignore */ }
  await waitForSettledPage(page);
}

/* c8 ignore start - executes in the browser, not under node coverage */
function interactiveFingerprint() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  const controls = Array.from(document.querySelectorAll(
    'input:not([type="hidden"]), select, textarea, button, [role="button"], a[href]',
  )).filter(visible).length;
  const busy = document.querySelectorAll('[aria-busy="true"], progress:not([value])').length;
  return { controls, text: (document.body?.innerText || '').length, busy, ready: document.readyState };
}
/* c8 ignore stop */

/**
 * Wait until a page has RENDERED, not merely loaded. Single-page ATSes
 * (Oracle Recruiting Cloud, Workday, SuccessFactors) answer
 * `domcontentloaded` with an empty shell and draw the posting, its "Apply"
 * button and the form a few seconds later. Reading the page at that moment
 * found no controls at all, so the run reported "resume field not found" on
 * the job description and never clicked Apply.
 *
 * Polls until the page has interactive controls and its control count and
 * text length hold still across two polls with nothing marked busy. Bounded:
 * returns after `timeoutMs` regardless. No-op on fakes without `evaluate`.
 *
 * @param {object} page Playwright page or frame
 * @param {object} [options]
 * @param {number} [options.timeoutMs=12000]
 * @param {number} [options.pollMs=350]
 * @returns {Promise<boolean>} true when it settled before the deadline
 */
export async function waitForSettledPage(page, { timeoutMs = 12000, pollMs = 350 } = {}) {
  if (!page || typeof page.evaluate !== 'function') return true;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    let now;
    try { now = await page.evaluate(interactiveFingerprint); } catch { now = null; }
    if (now && now.controls > 0 && now.busy === 0 && now.ready !== 'loading'
      && last && now.controls === last.controls && now.text === last.text) {
      stable += 1;
      if (stable >= 2) return true;
    } else {
      stable = 0;
    }
    last = now;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
