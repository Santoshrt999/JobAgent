/**
 * Live DOM form scanner.
 *
 * Reads the *actual* fields rendered on the current application page (inputs,
 * textareas, selects, radio groups, checkboxes) so the assistant can fill forms
 * it did not know about ahead of time — multi-step ATS flows, custom questions,
 * etc. This is deliberately READ-ONLY: it reports what it sees and never types,
 * clicks, or submits. All filling is done downstream by the type-aware filler,
 * which only ever writes values sourced from the candidate profile / config
 * screening answers.
 *
 * The scan runs in the page via `page.evaluate`. If the page object has no
 * `evaluate` (e.g. a unit-test fake), `scanFields` returns an empty list so
 * callers degrade gracefully instead of throwing.
 */

/**
 * Browser-side collector. Serialized and executed inside the page by Playwright.
 * Returns a plain array of field descriptors (no DOM handles cross the bridge).
 * @returns {Array<object>}
 */
/* c8 ignore start - executes in the browser, not under node coverage */
function collectFields() {
  const MAX_FIELDS = 120;

  const cssEscape = (s) =>
    (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const textOf = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();

  // A NAME THAT NAMES NOTHING: a widget's placeholder or role word used as its
  // accessible name. Rippling labels every dropdown aria-label="Select" and
  // its location box aria-label="textbox"; read as labels they matched no
  // answer, and the person was asked to answer "Search" and "textbox"
  // (2026-11-12, a Rippling posting).
  const GENERIC_NAME = /^(?:-+\s*)?(?:please\s+)?(?:select|choose|pick|search|textbox|text\s*box|text\s*field|input|combobox|combo\s*box|dropdown|drop-down|type\s+here|type\s+to\s+search|enter\s+(?:a\s+)?(?:value|text))(?:\s+(?:an?\s+)?(?:option|one|answer|value|item|here))?\s*(?:\.{2,}|…)?\s*-*$/i;
  const isGeneric = (text) => !String(text || '').trim() || GENERIC_NAME.test(String(text).trim());
  // A form's internal field key ("z0v_CCXsxi", "6WjYMs0Dp") is not a label.
  const looksGenerated = (name) => {
    const n = String(name || '').trim();
    if (!n) return true;
    return (/\d/.test(n) && /[a-z]/.test(n) && /[A-Z]/.test(n)) || /[a-z][A-Z].*[a-z][A-Z]/.test(n)
      || /^[0-9a-f-]{16,}$/i.test(n);
  };
  const FORM_CONTROL = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radiogroup"], [role="listbox"], [role="radio"], [role="checkbox"]';
  const controlsIn = (node) => {
    if (!node || node.nodeType !== 1) return 0;
    return (node.matches(FORM_CONTROL) ? 1 : 0) + node.querySelectorAll(FORM_CONTROL).length;
  };
  const refText = (ids) => String(ids || '').split(/\s+/).filter(Boolean)
    .map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ').trim();

  // THE QUESTION PRINTED ABOVE A CONTROL that nothing associates with it.
  // Rippling's custom questions are a <p> in the block before the field, with
  // no <label for>, no aria-labelledby: the input's only "name" was its random
  // field key, so "What is your salary requirement?" went unanswered although
  // a salary answer was saved. Walks up while the ancestor holds ONLY this
  // control (so a neighbour's label is never borrowed) and takes the text of
  // the block right before it, when that block holds no control itself.
  const questionBefore = (el, maxLen = 400) => {
    let box = el;
    for (let depth = 0; box && box.parentElement && depth < 8; depth += 1) {
      const prev = box.previousElementSibling;
      if (prev && controlsIn(prev) === 0) {
        const t = textOf(prev);
        if (t) return t.length <= maxLen ? t : null;
      } else if (prev) {
        return null; // the block before is another field
      }
      const up = box.parentElement;
      if (!up || up.tagName === 'FORM' || up === document.body || controlsIn(up) > controlsIn(el)) return null;
      box = up;
    }
    return null;
  };

  // Best-effort human label for a control.
  const labelFor = (el) => {
    // 1. <label for="id">
    if (el.id) {
      const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    // 2. Wrapping <label>
    const wrap = el.closest('label');
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    // 3. aria-labelledby (every id it names), then a MEANINGFUL aria-label.
    //    labelledby wins, as in the accessible-name algorithm: Rippling's
    //    location box carries both, and "textbox" is the wrong one.
    const byText = refText(el.getAttribute('aria-labelledby'));
    if (byText && !isGeneric(byText)) return byText;
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria && !isGeneric(aria)) return aria;
    // 4. The question printed just before the control.
    const question = questionBefore(el);
    if (question) return question;
    // 5. A placeholder, a readable name, and only then a generic word.
    const placeholder = (el.getAttribute('placeholder') || '').trim();
    if (placeholder && !isGeneric(placeholder)) return placeholder;
    if (el.name && !looksGenerated(el.name)) return el.name.trim();
    return aria || placeholder || '';
  };

  // What a custom (non-<select>) dropdown is showing, or '' while it still
  // shows its placeholder ("Select", "Select...").
  const shownChoice = (el) => {
    const text = textOf(el);
    if (!text || isGeneric(text)) return '';
    if (text === (el.getAttribute('aria-label') || '').trim()) return '';
    return text;
  };
  // Does the control already hold an answer (typed by a person, restored by
  // the site, or filled from a parsed resume)? Reported as a flag only: the
  // value itself never leaves the page.
  const holdsValue = (el) => {
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const opt = el.selectedOptions?.[0];
      return Boolean(opt && String(opt.value || '').trim() && !isGeneric(textOf(opt)));
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (String(el.value || '').trim()) return true;
      const box = el.parentElement?.closest('[class*="select__control"], [class*="-control"], [class*="container"]') ?? el.parentElement;
      const committed = box?.querySelector?.('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
      return Boolean(committed && textOf(committed));
    }
    return Boolean(shownChoice(el));
  };

  // Stable, unique-ish selector for a control. A control with neither id nor
  // name gets a per-page handle: dropping it made a real quick-apply form look
  // like a fieldless landing page, and its "Apply now" (the final submit) was
  // then clicked as the way in.
  const handleFor = (el) => {
    let tag = el.getAttribute('data-jobagent-field');
    if (!tag) {
      window.__jobagentFieldSeq = (window.__jobagentFieldSeq || 0) + 1;
      tag = String(window.__jobagentFieldSeq);
      el.setAttribute('data-jobagent-field', tag);
    }
    return `[data-jobagent-field="${tag}"]`;
  };
  const selectorFor = (el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    if (el.name) {
      const tag = el.tagName.toLowerCase();
      const same = document.querySelectorAll(`${tag}[name="${cssEscape(el.name)}"]`);
      if (same.length === 1) return `${tag}[name="${cssEscape(el.name)}"]`;
      if (el.type) {
        const typed = `${tag}[name="${cssEscape(el.name)}"][type="${el.type}"]`;
        if (document.querySelectorAll(typed).length === 1) return typed;
      }
      return handleFor(el);
    }
    return handleFor(el);
  };

  // ONE definition of "required", for every control kind: the native
  // attribute, aria-required, or a label that says so ("Email *",
  // "Phone (required)"). Text fields used to honour only the native attribute,
  // so an aria-required question was treated as optional, left blank, and the
  // run reported the form ready.
  const REQUIRED_MARK = /\*\s*$|\(\s*required\s*\)|\brequired\s*$/i;
  const isRequired = (el, label) => el.required === true
    || el.getAttribute('aria-required') === 'true'
    || REQUIRED_MARK.test(String(label || ''));
  const cleanLabel = (label) => String(label || '').replace(/\s*(?:\*|\(\s*required\s*\))\s*$/i, '').trim();
  // The QUESTION a radio or checkbox group answers. A group's own options are
  // labelled "Yes" / "No" / "Day"; the question is the fieldset's legend, the
  // radiogroup's accessible name, or the text just before the group. Reading
  // only the first option's label turned "Are you willing to relocate?" into a
  // question called "Yes".
  const groupQuestion = (el, optionLabels) => {
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend && textOf(legend)) return textOf(legend);
    const group = el.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      if (group.getAttribute('aria-label')) return group.getAttribute('aria-label').trim();
      const by = group.getAttribute('aria-labelledby');
      const ref = by && document.getElementById(by.split(/\s+/)[0]);
      if (ref && textOf(ref)) return textOf(ref);
    }
    // Nearest ancestor that holds the whole group: the text before it.
    // Consent questions run long (Rippling's SMS opt-in is ~330 characters
    // and sits 6 levels above its inputs), hence the depth and length.
    const name = el.name;
    let box = el.parentElement;
    for (let depth = 0; box && depth < 8 && box.tagName !== 'FORM'; depth += 1, box = box.parentElement) {
      const all = name ? box.querySelectorAll(`input[name="${cssEscape(name)}"]`).length : 1;
      const mine = name ? document.querySelectorAll(`input[name="${cssEscape(name)}"]`).length : 1;
      if (all < mine) continue;
      const prev = box.previousElementSibling;
      const t = textOf(prev);
      if (t && t.length <= 600 && !optionLabels.includes(t) && controlsIn(prev) === 0) return t;
      const own = box.getAttribute('aria-label');
      if (own) return own.trim();
    }
    return null;
  };

  // A radio/checkbox OPTION's own text. A styled option hides its input inside
  // a role="radio" box whose text is the option ("Yes - I consent to ..."), so
  // the input has no <label>; reading the input's name instead turned both
  // options into "sms_opt_in".
  const optionLabelFor = (el) => {
    if (el.id) {
      const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lab && textOf(lab)) return textOf(lab);
    }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap);
    const byText = refText(el.getAttribute('aria-labelledby'));
    if (byText) return byText;
    if ((el.getAttribute('aria-label') || '').trim()) return el.getAttribute('aria-label').trim();
    const box = el.closest('[role="radio"], [role="checkbox"], [role="option"]');
    if (box) return refText(box.getAttribute('aria-labelledby')) || (box.getAttribute('aria-label') || '').trim() || textOf(box);
    return '';
  };
  // The visible box a styled radio/checkbox draws for its hidden input.
  const styledBoxOf = (el) => {
    const box = el.closest('[role="radio"], [role="checkbox"]');
    return box && box !== el && isVisible(box) ? box : null;
  };

  // Controls that are on the page but are NOT the application: a site search
  // box, a cookie/consent banner, a newsletter or job-alert signup. Reporting
  // them as ordinary fields meant a JD landing page with a header search box
  // "had fields", so its "Apply now" button was never allowed as the way in,
  // and the filler typed the candidate's email into the newsletter form.
  const SEARCHY = /search|keyword|query|\bq\b|find.?jobs/i;
  const SIGNUP = /newsletter|subscribe|subscription|job.?alert|talent.?(?:community|network)|get.?notified|sign.?up.?for|mailing.?list/i;
  // A site's DISPLAY-language picker (Rippling's job pages carry one). Counted
  // as an application question, it made a job description look like a form,
  // so "Apply now" was never taken as the way in and the run stopped on the
  // posting with "resume upload input not found" (2026-11-12, a Rippling posting).
  // An application question about languages you SPEAK is not one of these: it
  // is matched only by an interface phrase, or by a bare "Language" select
  // whose options are language names or locale codes.
  const UI_LANGUAGE = /\b(?:display|site|page|interface|website|portal|ui|app)\s+language\b|\b(?:change|select|choose|switch)\s+(?:the\s+|your\s+)?language\b/i;
  const BARE_LANGUAGE = /^\s*(?:language|lang|locale|languages?\s*\/\s*locale)\s*\*?\s*$/i;
  const LANGUAGE_OPTION = /^(?:english|espa[nñ]ol|spanish|deutsch|german|fran[cç]ais|french|portugu[eê]s|portuguese|italiano|italian|nederlands|dutch|polski|svenska|dansk|norsk|suomi|t[uü]rk[cç]e|日本語|中文|简体中文|繁體中文|한국어|русский|العربية|हिन्दी|bahasa(?:\s+\w+)?|tiếng việt|ελληνικά|čeština|magyar|română)\b/i;
  const LOCALE_CODE = /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i;
  // "United States (English)", "English (UK)", "Español": a current value
  // that names a display language.
  const LANGUAGE_VALUE = /\((?:english|espa[nñ]ol|spanish|deutsch|german|fran[cç]ais|french|portugu[eê]s|portuguese|italiano|italian|nederlands|dutch)\)/i;
  const isLanguagePicker = (el, label) => {
    // Rippling's picker is NOT a <select>: it is a searchable combobox,
    // <input role="combobox" aria-label="Display language" value="United States (English)">.
    // Recognising only <select> left the real page unchanged (2026-11-12, retry still blocked).
    const role = (el.getAttribute('role') || '').toLowerCase();
    const isSelect = el.tagName === 'SELECT';
    const isFormTag = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    const isCombo = (el.tagName === 'INPUT' && (role === 'combobox'
      || (el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox'
      || ['list', 'both'].includes((el.getAttribute('aria-autocomplete') || '').toLowerCase())))
      // a custom <div role="combobox"> / <button aria-haspopup="listbox"> picker
      || (!isFormTag && (role === 'combobox' || (el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox'));
    if (!isSelect && !isCombo) return false;
    const text = String(label || '').trim();
    if (UI_LANGUAGE.test(text) || UI_LANGUAGE.test(el.getAttribute('aria-label') || '')) return true;
    if (!BARE_LANGUAGE.test(text) && !/^(?:lang|locale|language)$/i.test(el.name || el.id || '')) return false;
    if (isCombo) {
      const value = String(isFormTag ? el.value || '' : textOf(el)).trim();
      return LANGUAGE_VALUE.test(value) || LANGUAGE_OPTION.test(value) || LOCALE_CODE.test(value);
    }
    const opts = Array.from(el.options || []);
    const languageLike = opts.filter((o) => LANGUAGE_OPTION.test((o.textContent || '').trim()) || LOCALE_CODE.test(o.value || '')).length;
    return languageLike >= 2 && languageLike >= opts.length / 2;
  };

  const incidentalReason = (el, label) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const hint = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
    if (isLanguagePicker(el, label)) return 'language-picker';
    if (type === 'search' || el.closest('[role="search"], search')) return 'search';
    // A custom dropdown in the site's header, navigation or footer (sort,
    // region, language, account menu) is page chrome. Counted as a field it
    // would make a job description look like a form, and "Apply now" would
    // never be taken as the way in.
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
      && el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], [role="menubar"], [role="toolbar"]')) {
      return 'page-chrome';
    }
    // Bot traps: a text box no person can see or reach (Oracle Recruiting's
    // "honey-pot" sits in a zero-height, overflow-hidden row, aria-hidden and
    // tabindex=-1). Typing into one flags the application as a bot.
    if (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file'].includes(type)) {
      const trapHint = [el.name, el.id, el.className, el.getAttribute('autocomplete')].join(' ');
      if (/honey.?pot|bot.?trap|\bhp[_-]|leave.?(?:this.?)?(?:field.?)?(?:blank|empty)/i.test(trapHint)) return 'honeypot';
      if (el.closest('[aria-hidden="true"]') && el.tabIndex === -1) return 'honeypot';
      for (let up = el.parentElement, depth = 0; up && depth < 4; up = up.parentElement, depth += 1) {
        const st = window.getComputedStyle(up);
        const r = up.getBoundingClientRect();
        if (st.overflow !== 'visible' && (r.height < 2 || r.width < 2)) return 'honeypot';
      }
    }
    if (el.closest('header, nav, [role="banner"], [role="navigation"]') && SEARCHY.test(hint)) return 'search';
    if (el.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i], [class*="gdpr" i]')) {
      return 'consent-banner';
    }
    const form = el.closest('form');
    const box = form || el.closest('[class*="newsletter" i], [id*="newsletter" i], [class*="subscribe" i]');
    if (box) {
      const text = [box.id, box.className, box.getAttribute('action'), box.getAttribute('aria-label'),
        (box.textContent || '').slice(0, 400)].join(' ');
      const size = box.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
      if (SIGNUP.test(text) && size <= 3) return 'signup';
    }
    return null;
  };

  const out = [];
  const seenRadioGroups = new Set();
  // Custom dropdowns are scanned in document order with everything else.
  // Rippling (and any headless-UI form) renders its choice questions as
  // <div role="combobox"> with no <select> and no <input> behind them: all
  // seven Yes/No questions on one Rippling posting, gender, ethnicity and veteran status
  // were invisible to the scanner, never filled, never reported (2026-11-12).
  const CUSTOM_SELECT = '[role="combobox"]:not(input):not(select):not(textarea), button[aria-haspopup="listbox"]';
  const controls = Array.from(document.querySelectorAll(`input, textarea, select, ${CUSTOM_SELECT}`));

  for (const el of controls) {
    if (out.length >= MAX_FIELDS) break;
    const tag = el.tagName.toLowerCase();

    if (!['input', 'textarea', 'select'].includes(tag)) {
      // An ARIA 1.1 combobox WRAPS its text input; the input is the field.
      if (el.querySelector('input:not([type="hidden"]), select, textarea')) continue;
      if (!isVisible(el) || el.getAttribute('aria-disabled') === 'true' || el.disabled) continue;
      const sel = selectorFor(el);
      const label = labelFor(el);
      out.push({
        kind: 'combobox', type: 'custom-select', typeable: false, selector: sel,
        label: cleanLabel(label), name: '', required: isRequired(el, label), options: [],
        hasValue: holdsValue(el),
      });
      continue;
    }

    const rawType = (el.getAttribute('type') || tag).toLowerCase();

    // Skip controls we must never touch automatically. File inputs ARE
    // reported (the workflow must see required uploads and verify attachments
    // persist) — but as kind:'file', which the text filler ignores; only
    // uploadRunner ever touches them.
    if (['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(rawType)) continue;
    if (el.disabled || el.readOnly) continue;
    // A STYLED checkbox/radio hides the real input (opacity 0, clipped, 0×0)
    // and draws its own box on the label. Oracle Recruiting's "I have read the
    // Important Privacy Information" is one: skipping it as invisible meant the
    // run never reported the required question, clicked Next, and only learnt
    // of it from "You need to agree to the terms and conditions."
    const styledChoice = (rawType === 'checkbox' || rawType === 'radio') && !isVisible(el)
      && (() => {
        const lab = (el.id && document.querySelector(`label[for="${cssEscape(el.id)}"]`)) || el.closest('label');
        // ...or draws a role="radio"/"checkbox" box around it (Rippling).
        return Boolean(lab && isVisible(lab) && lab.textContent.trim()) || Boolean(styledBoxOf(el));
      })();
    if (!isVisible(el) && !styledChoice) continue;

    if (rawType === 'file') {
      // ATS file inputs frequently carry no id/name (e.g. inside a labelled
      // <fieldset>) — fall back to a container-scoped selector so the field
      // is still reported.
      let sel = selectorFor(el);
      if (!sel) {
        const host = el.closest('fieldset[id], [id]');
        sel = host ? `#${cssEscape(host.id)} input[type="file"]` : 'input[type="file"]';
        if (document.querySelectorAll(sel).length !== 1) sel = null;
      }
      const label = labelFor(el)
        || (el.closest('fieldset')?.querySelector('legend')?.textContent ?? '').trim();
      if (sel) out.push({ kind: 'file', type: 'file', selector: sel, label: cleanLabel(label), name: el.name || '', required: isRequired(el, label) });
      continue;
    }

    if (tag === 'select') {
      const options = Array.from(el.options || []).map((o) => ({
        value: o.value, label: (o.textContent || '').trim(),
      }));
      const sel = selectorFor(el);
      const label = labelFor(el);
      if (sel) out.push({ kind: 'select', type: 'select', selector: sel, label: cleanLabel(label), name: el.name || '', required: isRequired(el, label), options, hasValue: holdsValue(el) });
      continue;
    }

    if (rawType === 'radio') {
      const groupKey = `${el.name || ''}`;
      if (!el.name || seenRadioGroups.has(groupKey)) continue;
      seenRadioGroups.add(groupKey);
      const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscape(el.name)}"]`));
      const options = radios.map((r) => ({
        value: r.value,
        label: optionLabelFor(r) || r.value,
        selector: `input[type="radio"][name="${cssEscape(el.name)}"][value="${cssEscape(r.value)}"]`,
      }));
      const question = groupQuestion(el, options.map((o) => o.label)) || labelFor(el) || el.name;
      const group = el.closest('[role="radiogroup"]');
      const required = radios.some((r) => r.required === true || r.getAttribute('aria-required') === 'true')
        || group?.getAttribute('aria-required') === 'true' || REQUIRED_MARK.test(question);
      const answered = radios.some((r) => r.checked || r.closest('[role="radio"]')?.getAttribute('aria-checked') === 'true');
      out.push({
        kind: 'radio', type: 'radio', selector: null, label: cleanLabel(question), name: el.name, required, options,
        hasValue: answered, ...(styledChoice ? { styled: true } : {}),
      });
      continue;
    }

    if (rawType === 'checkbox') {
      const sel = selectorFor(el);
      let label = labelFor(el);
      // A checkbox that is one of SEVERAL in a fieldset ("Which shifts can you
      // work?  [ ] Day  [ ] Night") is one answer to the legend's question.
      const fieldset = el.closest('fieldset');
      const siblings = fieldset ? fieldset.querySelectorAll('input[type="checkbox"]').length : 0;
      const legend = siblings > 1 ? textOf(fieldset.querySelector('legend')) : '';
      const required = isRequired(el, label);
      if (legend) label = `${cleanLabel(legend)}: ${cleanLabel(label)}`;
      if (sel) {
        out.push({
          kind: 'checkbox', type: 'checkbox', selector: sel, label: cleanLabel(label),
          name: el.name || '', required, options: [], ...(styledChoice ? { styled: true } : {}),
        });
      }
      continue;
    }

    // text-like inputs + textarea
    const sel = selectorFor(el);
    if (!sel) continue;

    // Detect typeahead / autocomplete / combobox widgets (e.g. Greenhouse's
    // "Location (City)" react-select). These look like a plain text input but
    // a plain fill() never commits the dropdown choice, so the form treats the
    // field as empty. Tagging them 'combobox' lets the filler type then pick an
    // option. Textareas are never comboboxes.
    const role = (el.getAttribute('role') || '').toLowerCase();
    const ariaAuto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
    const inReactSelect = !!el.closest('[class*="select__"], [class*="react-select"]');
    const hasList = !!el.getAttribute('list');
    const isCombobox = tag !== 'textarea' && (
      role === 'combobox' || ariaAuto === 'list' || ariaAuto === 'both' || inReactSelect || hasList
    );

    let listboxSelector = null;
    if (isCombobox) {
      const owns = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (owns) listboxSelector = `#${cssEscape(owns)}`;
    }

    const textLabel = labelFor(el);
    // A searchable SELECT ("Select..." you can type into) offers a fixed list
    // when opened, unlike a location typeahead that offers nothing until you
    // type. Its choices can be read before answering.
    const selectLike = isCombobox
      && /^(?:-+\s*)?(?:please\s+)?(?:select|choose)\b/i.test((el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim());
    out.push({
      kind: tag === 'textarea' ? 'textarea' : (isCombobox ? 'combobox' : 'text'),
      type: rawType,
      selector: sel,
      label: cleanLabel(textLabel),
      name: el.name || '',
      required: isRequired(el, textLabel),
      options: [],
      hasValue: holdsValue(el),
      ...(isCombobox ? { listboxSelector, ...(selectLike ? { selectLike: true } : {}) } : {}),
    });
  }

  // Tag (never drop) incidental controls, so callers decide what to ignore.
  for (const field of out) {
    let el;
    try { el = field.selector ? document.querySelector(field.selector) : null; } catch { el = null; }
    if (!el && field.kind === 'radio' && field.options?.[0]?.selector) {
      try { el = document.querySelector(field.options[0].selector); } catch { el = null; }
    }
    const reason = el ? incidentalReason(el, field.label) : null;
    if (reason) field.incidental = reason;
  }
  return out;
}
/* c8 ignore stop */

/**
 * The scanned fields that belong to the application itself (drops site
 * search, consent banners and newsletter/job-alert signups).
 *
 * @param {Array<object>} fields scanFields() result
 * @returns {Array<object>}
 */
export function applicationFields(fields = []) {
  return (Array.isArray(fields) ? fields : []).filter((f) => !f?.incidental);
}

/* c8 ignore start - executes in the browser, not under node coverage */
function countShadowControls() {
  let n = 0;
  const visit = (root, inShadow) => {
    for (const el of root.querySelectorAll('*')) {
      if (inShadow && el.matches('input:not([type="hidden"]), textarea, select')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) n += 1;
      }
      if (el.shadowRoot) visit(el.shadowRoot, true);
    }
  };
  visit(document, false);
  return n;
}
/* c8 ignore stop */

/**
 * Visible form controls inside OPEN shadow roots, which `scanFields` cannot
 * read (SmartRecruiters and other web-component forms). A page whose only
 * controls live there is a form the assistant cannot see, not a landing page.
 * 0 on pages or doubles that cannot be inspected.
 *
 * @param {object} scope Playwright page or frame
 * @returns {Promise<number>}
 */
export async function shadowFormControlCount(scope) {
  if (!scope || typeof scope.evaluate !== 'function') return 0;
  try { return Number(await scope.evaluate(countShadowControls)) || 0; } catch { return 0; }
}

/**
 * Scan the current page for fillable form fields.
 *
 * @param {object} page Playwright page (must expose `evaluate`) or a fake.
 * @returns {Promise<Array<{kind:string,type:string,selector:string|null,label:string,name:string,required:boolean,options:Array}>>}
 */
export async function scanFields(page) {
  if (!page || typeof page.evaluate !== 'function') return [];
  try {
    const fields = await page.evaluate(collectFields);
    return Array.isArray(fields) ? fields : [];
  } catch {
    return [];
  }
}

/**
 * URL patterns of known ATS application forms that are commonly EMBEDDED inside
 * a host careers page via an <iframe> (e.g. dropbox.com / samsara.com embedding
 * a Greenhouse form). When a page does this, `page.locator`/`page.evaluate` only
 * see the empty host document, so the assistant fills nothing. We detect the
 * embedded form frame and run all scanning/filling/uploading against it instead.
 */
const ATS_FRAME_RE = /(greenhouse\.io|grnhse|lever\.co|myworkdayjobs|ashbyhq|icims|jobvite|smartrecruiters|workable|bamboohr|breezy\.hr|teamtailor)/i;

/**
 * Resolve the frame that actually contains the application form.
 *
 * If the form lives in an embedded ATS iframe, returns that Playwright `Frame`
 * (which exposes the same `locator`/`evaluate`/`getByRole` API as a Page, so it
 * is a drop-in scope for the fillers). Otherwise — including unit-test fakes
 * with no `frames()` — returns the page unchanged.
 *
 * Embedded ATS iframes load asynchronously, so a single look at `page.frames()`
 * can race the iframe's navigation and silently fall back to the (empty) host
 * document. We therefore poll briefly: as long as an ATS-looking embed exists
 * but has no scannable fields yet, or a child frame is still on about:blank,
 * retry until `timeoutMs` elapses. Pages with no embeds return immediately.
 *
 * @param {object} page Playwright page (or a fake)
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] how long to wait for an embed to load
 * @param {number} [options.pollMs=150] delay between polls
 * @returns {Promise<object>} the page or an embedded form frame
 */
export async function resolveFormScope(page, { timeoutMs = 3000, pollMs = 150 } = {}) {
  if (!page || typeof page.frames !== 'function') return page;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let frames;
    try { frames = page.frames(); } catch { return page; }
    if (!Array.isArray(frames) || frames.length === 0) return page;

    // Only consider CHILD frames (skip the main frame). Track which look like
    // an embedded ATS form and which haven't navigated anywhere yet.
    const embeds = [];
    let pendingChild = false;
    for (const f of frames) {
      if (!f || typeof f.parentFrame !== 'function') continue;
      let parent;
      try { parent = f.parentFrame(); } catch { continue; }
      if (!parent) continue;
      let url;
      try { url = f.url() || ''; } catch { url = ''; }
      if (ATS_FRAME_RE.test(url)) embeds.push(f);
      else if (url === '' || url === 'about:blank') pendingChild = true;
    }

    for (const frame of embeds) {
      try {
        const fields = await scanFields(frame);
        if (fields.length > 0) return frame;
      } catch { /* try the next embed */ }
    }

    // Nothing fillable yet. If no embed exists (and none could still appear),
    // this is a plain top-level form — return the page without waiting.
    if (embeds.length === 0 && !pendingChild) return page;
    if (Date.now() >= deadline) return page;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}


/**
 * Detect visible validation errors on the current form step.
 *
 * ATSes surface rejection of a step as inline field errors rather than a
 * navigation failure, so after filling (and after every advance click) the
 * runner asks the live DOM for:
 *   - fields marked aria-invalid="true" (reported with their label), and
 *   - visible alert/error text (role="alert", .error/.field-error/.help-block,
 *     Greenhouse/Lever/Workday error classes).
 *
 * Returns [] on pages/frames that cannot evaluate (unit-test fakes) — the
 * check degrades gracefully, it never breaks a run.
 *
 * @param {object} scope Playwright Page or Frame
 * @returns {Promise<string[]>} human-readable error strings, deduplicated
 */
export async function detectValidationErrors(scope) {
  if (!scope || typeof scope.evaluate !== 'function') return [];
  try {
    const errors = await scope.evaluate(() => {
      const out = new Set();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelFor = (el) => {
        if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
        const id = el.getAttribute('aria-describedby');
        if (id) {
          const desc = document.getElementById(id.split(/\s+/)[0]);
          if (desc) return desc.textContent.trim();
        }
        return el.name || el.id || 'field';
      };
      for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
        if (visible(el)) out.add(`invalid field: ${labelFor(el).slice(0, 80)}`);
      }
      const errorSel = '[role="alert"], .field-error, .error-message, .help-block.error, '
        + '.field_with_errors, .invalid-feedback, [data-automation-id*="error"]';
      // A screen-reader announcement is not a form error. Workday keeps a
      // visually hidden role="alert" that says "<Job title> page is loaded";
      // read as an error, it stopped every Workday run before "Apply".
      const screenReaderOnly = (el) => {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width <= 2 || r.height <= 2 || /rect\(0(px)?,?\s*0(px)?/.test(st.clip)
          || /inset\(\s*50%/.test(st.clipPath);
      };
      const ANNOUNCEMENT = /^(?:.*\bpage is loaded|loading\b.*|.*\bhas loaded|\d+ results?\b.*)$/i;
      for (const el of document.querySelectorAll(errorSel)) {
        const text = (el.textContent || '').trim();
        if (!visible(el) || !text || text.length > 200) continue;
        if (el.matches('[role="alert"]') && (screenReaderOnly(el) || ANNOUNCEMENT.test(text))) continue;
        out.add(text);
      }
      return [...out].slice(0, 10);
    });
    return Array.isArray(errors) ? errors : [];
  } catch {
    return [];
  }
}

/**
 * Labels of every VISIBLE required control that is still empty on this step.
 *
 * The auto-submit gate used to trust `requiredFieldsSatisfied`, which only
 * knows about fields in the packet's static plan — and with an empty plan (the
 * normal case for a dynamically scanned form) it was vacuously true, so a form
 * with a blank required question could be submitted. This asks the live DOM
 * instead: `[required]` and `[aria-required="true"]` controls, radio groups by
 * name, checkboxes by `checked`, file inputs by their FileList.
 *
 * @param {object} scope Playwright Page or Frame
 * @returns {Promise<string[]|null>} empty labels, or null when the scope cannot
 *   be inspected (unit-test doubles)
 */
export async function unfilledRequiredControls(scope) {
  if (!scope || typeof scope.evaluate !== 'function') return null;
  try {
    const missing = await scope.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const textOf = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
      // Same rules as the scanner's labelFor: a placeholder word ("Select",
      // "textbox") is not a name, aria-labelledby beats aria-label, and an
      // unassociated question printed just above the field is its name.
      const GENERIC = /^(?:-+\s*)?(?:please\s+)?(?:select|choose|pick|search|textbox|text\s*box|text\s*field|input|combobox|combo\s*box|dropdown|drop-down|type\s+here|type\s+to\s+search|enter\s+(?:a\s+)?(?:value|text))(?:\s+(?:an?\s+)?(?:option|one|answer|value|item|here))?\s*(?:\.{2,}|…)?\s*-*$/i;
      const generic = (t) => !String(t || '').trim() || GENERIC.test(String(t).trim());
      const CONTROL = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radiogroup"], [role="listbox"], [role="radio"], [role="checkbox"]';
      const controlsIn = (n) => (n && n.nodeType === 1 ? (n.matches(CONTROL) ? 1 : 0) + n.querySelectorAll(CONTROL).length : 0);
      const questionBefore = (el) => {
        let box = el;
        for (let d = 0; box && box.parentElement && d < 8; d += 1) {
          const prev = box.previousElementSibling;
          if (prev && controlsIn(prev) === 0) { const t = textOf(prev); if (t) return t.length <= 400 ? t : null; }
          else if (prev) return null;
          const up = box.parentElement;
          if (!up || up.tagName === 'FORM' || up === document.body || controlsIn(up) > controlsIn(el)) return null;
          box = up;
        }
        return null;
      };
      const labelOf = (el) => {
        if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
        const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ');
        if (by && !generic(by)) return by;
        const aria = (el.getAttribute('aria-label') || '').trim();
        if (aria && !generic(aria)) return aria;
        return questionBefore(el) || aria || el.name || el.id || 'required field';
      };
      // A custom dropdown's committed choice is its visible text, once that is
      // no longer the placeholder.
      const shows = (el) => {
        const t = textOf(el);
        return Boolean(t) && !generic(t) && t !== (el.getAttribute('aria-label') || '').trim();
      };
      const out = [];
      const seenGroups = new Set();
      const controls = document.querySelectorAll(
        'input[required], select[required], textarea[required], [aria-required="true"]',
      );
      for (const el of controls) {
        const tag = el.tagName.toLowerCase();
        const type = String(el.getAttribute('type') || tag).toLowerCase();
        if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
        if (el.disabled) continue;
        if (type === 'radio') {
          if (!el.name || seenGroups.has(el.name)) continue;
          seenGroups.add(el.name);
          const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
          if (!group.some(visible)) continue;
          if (!group.some((r) => r.checked)) out.push(labelOf(el));
          continue;
        }
        if (!['input', 'select', 'textarea'].includes(tag)) {
          // An ARIA widget (radiogroup / combobox / listbox) marked required.
          if (!visible(el)) continue;
          // An open dropdown's list is marked required too; it is not a field.
          if (el.getAttribute('role') === 'listbox' && el.id && document.querySelector(`[aria-controls="${CSS.escape(el.id)}"], [aria-owns="${CSS.escape(el.id)}"]`)) continue;
          const chosen = el.querySelector('[aria-checked="true"], [aria-selected="true"]')
            || (el.getAttribute('aria-valuetext') || '').trim()
            || el.querySelector('[class*="single-value"], [class*="singleValue"]')
            || (el.getAttribute('role') === 'combobox' && shows(el));
          if (!chosen) out.push(labelOf(el));
          continue;
        }
        if (!visible(el)) continue;
        if (type === 'checkbox') { if (!el.checked) out.push(labelOf(el)); continue; }
        if (type === 'file') { if (!el.files || el.files.length === 0) out.push(labelOf(el)); continue; }
        if (String(el.value ?? '').trim()) continue;
        // A typeahead clears its input on commit and shows the choice beside it.
        const box = el.parentElement?.closest('[class*="select__control"], [class*="-control"], [class*="container"], [role="combobox"]')
          ?? el.parentElement;
        const committed = box?.querySelector?.('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
        if (committed && (committed.textContent || '').trim()) continue;
        out.push(labelOf(el));
      }
      return [...new Set(out.map((l) => l.replace(/\s+/g, ' ').slice(0, 120)))];
    });
    return Array.isArray(missing) ? missing : null;
  } catch {
    return null;
  }
}
