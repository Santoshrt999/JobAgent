/**
 * Field resolver / filler.
 *
 * Consumes a packet's fill plan and, against a live Playwright page, (a) checks
 * which planned selectors actually resolve to a single element and (b) fills the
 * resolved text fields. It only fills values that came from the candidate
 * profile or config-backed screening answers — it never invents input. Select /
 * radio / unknown widgets are reported as "needs human" rather than guessed.
 *
 * The page is accessed through a tiny interface (`locator(sel).count()/.fill()`)
 * so a fake page can drive unit tests, while the real Playwright page is used in
 * fixture integration tests.
 */

/**
 * Count how many elements a selector matches (0 if it errors).
 * @param {object} page
 * @param {string} selector
 * @returns {Promise<number>}
 */
async function safeCount(page, selector) {
  if (!selector) return 0;
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

/**
 * Resolve each fill-plan step against the page without typing anything.
 *
 * @param {object} page Playwright page (or compatible)
 * @param {object} fillPlan packet.fillPlan ({ steps: [...] })
 * @returns {Promise<{ resolved: object[], unresolved: object[] }>}
 */
export async function resolveFields(page, fillPlan = {}) {
  const steps = Array.isArray(fillPlan.steps) ? fillPlan.steps : [];
  const resolved = [];
  const unresolved = [];
  for (const step of steps) {
    const count = await safeCount(page, step.selector);
    if (count === 1 && step.value != null && step.value !== '') {
      resolved.push({ ...step, matchCount: count });
    } else {
      unresolved.push({ ...step, matchCount: count, reason: reasonFor(step, count) });
    }
  }
  return { resolved, unresolved };
}

function reasonFor(step, count) {
  if (!step.selector) return 'no selector';
  if (count === 0) return 'selector not found on page';
  if (count > 1) return `selector matched ${count} elements (ambiguous)`;
  if (step.value == null || step.value === '') return 'no value to fill';
  return 'unresolved';
}

/**
 * Fill the resolved text fields.
 *
 * @param {object} page
 * @param {object} fillPlan
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] resolve only; do not type
 * @returns {Promise<{ filled: object[], unresolved: object[], errors: object[] }>}
 */
export async function fillFields(page, fillPlan = {}, { dryRun = false } = {}) {
  const { resolved, unresolved } = await resolveFields(page, fillPlan);
  const filled = [];
  const errors = [];

  if (dryRun) {
    return { filled, unresolved, errors, plannedFills: resolved };
  }

  for (const step of resolved) {
    try {
      await page.locator(step.selector).first().fill(String(step.value));
      filled.push({ field: step.field, label: step.label, selector: step.selector, source: step.source });
    } catch (err) {
      errors.push({ field: step.field, selector: step.selector, error: err.message });
    }
  }
  return { filled, unresolved, errors };
}

/**
 * Are all required fields filled? Required = profile-sourced identity/contact
 * fields present in the plan. A missing required field blocks submission.
 *
 * @param {object[]} filled result of fillFields().filled
 * @param {object} fillPlan
 * @param {string[]} [required=['email']] canonical required field names
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function requiredFieldsSatisfied(filled = [], fillPlan = {}, required = ['email'], { strict = false } = {}) {
  const steps = Array.isArray(fillPlan.steps) ? fillPlan.steps : [];
  const filledSet = new Set(filled.map((f) => f.field));
  const planned = new Set(steps.map((s) => s.field));
  const missing = [];
  for (const field of required) {
    // Only enforce fields the form actually asks for.
    if (planned.has(field) && !filledSet.has(field)) missing.push(field);
    // STRICT (the auto-submit gate): with no static plan at all, "the form
    // does not ask for it" was vacuously assumed and an unplanned form passed
    // with nothing filled. Unplanned, the field must have been filled live.
    else if (strict && steps.length === 0 && !filledSet.has(field)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Verify that fields which reported a successful Playwright action still hold
 * an accepted value in the live DOM. This catches controlled React inputs that
 * briefly accept fill() and then reset, and native constraint failures before
 * the runner advances. No value is returned or persisted.
 *
 * Page doubles that cannot expose DOM state are reported as `unobservable`,
 * not as failures. Real Playwright Locator objects expose evaluate().
 */
export async function verifyFilledFields(page, filled = []) {
  const accepted = [];
  const rejected = [];
  const unobservable = [];
  const seen = new Set();

  for (const field of filled) {
    const selector = field?.selector;
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    let locator;
    try {
      if ((await page.locator(selector).count()) !== 1) {
        // A field from an earlier multi-step page is no longer observable. It
        // was validated before that page advanced and remains in the durable
        // completed-fields audit trail.
        unobservable.push({ ...field, reason: 'field not present on current step' });
        continue;
      }
      locator = page.locator(selector).first();
    } catch {
      unobservable.push({ ...field, reason: 'selector could not be inspected' });
      continue;
    }

    if (typeof locator.evaluate !== 'function') {
      unobservable.push({ ...field, reason: 'live value inspection unavailable' });
      continue;
    }

    try {
      const state = await locator.evaluate((el) => {
        // A custom dropdown (<div role="combobox">) has no value property: its
        // committed choice is the text it shows instead of its placeholder.
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
          const shown = String(el.textContent ?? '').replace(/\s+/g, ' ').trim();
          const placeholder = /^(?:-+\s*)?(?:please\s+)?(?:select|choose|pick|search)(?:\s+(?:an?\s+)?(?:option|one|answer|value|item))?\s*(?:\.{2,}|…)?\s*-*$/i;
          const present = Boolean(shown) && !placeholder.test(shown) && shown !== (el.getAttribute('aria-label') || '').trim();
          return { type: 'custom', valuePresent: present, committedPresent: present, checked: false, valid: el.getAttribute('aria-invalid') !== 'true' };
        }
        // react-select and friends clear the input on commit and render the
        // chosen value beside it; that IS the field's value.
        const box = el.parentElement?.closest('[class*="select__control"], [class*="-control"], [class*="container"], [role="combobox"]')
          ?? el.parentElement;
        const committed = box?.querySelector?.('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
        // A styled radio records its state on the box it draws.
        const radioBox = el.closest?.('[role="radio"]');
        return {
          type: String(el.type ?? '').toLowerCase(),
          valuePresent: String(el.value ?? '').trim().length > 0,
          committedPresent: String(committed?.textContent ?? '').trim().length > 0,
          checked: Boolean(el.checked) || radioBox?.getAttribute('aria-checked') === 'true',
          valid: typeof el.checkValidity === 'function' ? el.checkValidity() : true,
        };
      });
      const action = field.action ?? 'fill';
      let retained = state.valuePresent;
      if (action === 'combobox') retained = state.valuePresent || state.committedPresent === true;
      if (action === 'check') retained = state.checked;
      else if (action === 'uncheck') retained = !state.checked;
      else if (action === 'radio') retained = state.checked || state.valuePresent;
      const record = { ...field, accepted: Boolean(retained && state.valid) };
      if (record.accepted) accepted.push(record);
      else rejected.push({ ...record, reason: state.valid ? 'value did not remain set' : 'browser constraint validation failed' });
    } catch (err) {
      unobservable.push({ ...field, reason: err.message });
    }
  }
  return { accepted, rejected, unobservable };
}
