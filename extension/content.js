(() => {
  if (globalThis.__jobAgentFillInstalled) return;
  globalThis.__jobAgentFillInstalled = true;

  const PROTECTED = /\b(gender|sex|race|ethnicity|ethnic|disability|veteran|military status|date of birth|birth date|age|religion|sexual orientation|pronouns?)\b/i;
  const LEGAL = /\b(i agree|attest|certify|signature|terms|privacy policy|consent|acknowledge|truthful|accurate)\b/i;
  // Work-authorization questions are NEVER answered by the extension. Its
  // pattern matcher cannot see polarity: "Are you able to work here WITHOUT
  // requiring sponsorship?" matched `require sponsorship` and was answered
  // "Yes" for a candidate who needs it. Mirrors EXTENSION_MANUAL_LABEL in
  // src/extension/companion.js.
  const WORK_AUTH = /\b(sponsor\w*|visas?|authori[sz]\w*|citizen\w*)\b/i;
  // "How many years of experience do you have WITH SAP ABAP?" names a subject.
  // The local answer list only holds a career TOTAL, so answering it here
  // would state that total as experience with a skill the candidate may never
  // have used — the fabrication the server-side answerer already refuses.
  const YEARS_QUESTION = /\b(how many|number of|total)\s+years?\b|\byears?\s+of\s+(?:\w+\s+){0,2}experience\b/i;
  const NAMES_SUBJECT = /\byears?\b.*\b(?:with|in|using|on|doing|as an?|of hands-on)\s+(?!total\b|the industry\b|this field\b|your career\b)\S/i;
  const SKIP_TYPES = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'image']);
  const ALIASES = {
    firstName: ['first name', 'given name'], lastName: ['last name', 'surname', 'family name'],
    preferredName: ['preferred name', 'preferred first name', 'nickname'], fullName: ['full name', 'legal name', 'your name'],
    email: ['email', 'e-mail'], phone: ['phone number', 'mobile number', 'telephone', 'phone'],
    addressLine1: ['address line 1', 'street address'], addressLine2: ['address line 2', 'apartment', 'suite'],
    city: ['city'], state: ['state', 'province', 'region'], zip: ['zip code', 'postal code', 'postcode'],
    country: ['country'], location: ['current location', 'where are you located', 'location'],
    linkedin: ['linkedin'], github: ['github'], portfolio: ['portfolio', 'personal website', 'website url'],
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'JOB_AGENT_FILL') return false;
    fillPage(message.payload, message.connection).then(sendResponse, (e) => sendResponse({
      mainFrame: isMainFrame(), formDetected: false, filled: [], blockers: [e.message],
    }));
    return true;
  });

  async function fillPage(payload, connection) {
    const filled = [];
    const blockers = [];
    const contextVerified = verifyJobContext(payload, connection);
    if (!contextVerified) {
      const message = 'This page could not be verified as the selected job. Return to the employer application reached from that job posting.';
      showBanner(0, 1, message);
      return result({ contextVerified: false, blockers: [message] });
    }
    const applicationRoot = findApplicationRoot();
    if (!applicationRoot) {
      const start = connection?.allowStart ? findApplyStartControl() : null;
      if (start) {
        const label = controlText(start);
        start.click();
        return result({
          contextVerified: true, startedApplication: true, formDetected: false,
          observedUrl: location.href, filled, blockers,
          action: `clicked ${label}`,
        });
      }
      const message = 'No application form is open. On LinkedIn, click Easy Apply (or Continue/Apply on company website) first, then run Fill current step again.';
      showBanner(0, 1, message);
      return result({ contextVerified: true, formDetected: false, filled, blockers: [message] });
    }
    const controls = [...applicationRoot.querySelectorAll('input, textarea, select')].slice(0, 160);
    const profileValues = valuesFrom(payload.profile);
    const decisions = new Map(Object.entries(payload.screeningDecisions || {}).map(([k, v]) => [norm(k), v]));
    let resumeUsed = false;
    let coverUsed = false;

    for (const el of controls) {
      if (!visible(el) || el.disabled || el.readOnly) continue;
      const type = (el.type || el.tagName).toLowerCase();
      if (SKIP_TYPES.has(type)) continue;
      const label = labelFor(el).slice(0, 180);
      if (!label) continue;
      if (PROTECTED.test(label)) { blockers.push(`Review protected/voluntary question: ${label}`); mark(el, 'review'); continue; }
      if (LEGAL.test(label) || type === 'checkbox') { blockers.push(`Review checkbox/attestation manually: ${label}`); mark(el, 'review'); continue; }
      if (type !== 'file' && WORK_AUTH.test(label)) {
        blockers.push(`Answer this work-authorization question yourself: ${label}`); mark(el, 'review'); continue;
      }
      if (type !== 'file' && YEARS_QUESTION.test(label) && NAMES_SUBJECT.test(label)) {
        blockers.push(`Answer this experience question yourself (it asks about a specific skill): ${label}`); mark(el, 'review'); continue;
      }

      if (type === 'file') {
        const kind = /cover/i.test(label) ? 'cover-letter' : /resume|résumé|cv/i.test(label) ? 'resume' : null;
        if (!kind || (kind === 'resume' && resumeUsed) || (kind === 'cover-letter' && coverUsed)) {
          if (isRequired(el)) blockers.push(`Select required file manually: ${label}`);
          continue;
        }
        const artifact = kind === 'resume' ? payload.artifacts.resume : payload.artifacts.coverLetter;
        if (!artifact?.available) { if (isRequired(el)) blockers.push(`Approved packet has no file for: ${label}`); continue; }
        try {
          await attach(el, payload.job.id, kind, artifact.name);
          kind === 'resume' ? (resumeUsed = true) : (coverUsed = true);
          filled.push({ field: kind, label, source: 'approved_artifact' }); mark(el, 'filled');
        } catch (e) { blockers.push(`${label}: ${e.message}`); mark(el, 'review'); }
        continue;
      }

      const canonical = canonicalFor(label, el.name || '');
      let value = canonical ? profileValues[canonical] : null;
      let source = canonical ? 'candidate_profile' : '';
      if (!value) {
        // A decision the server already made for this exact question wins over
        // the local pattern match — including a decision to leave it alone.
        const decision = decisions.get(norm(label));
        if (decision?.action === 'ask_user') {
          if (isRequired(el)) blockers.push(`Required field needs your answer: ${label}`);
          mark(el, 'review');
          continue;
        }
        if (decision?.action === 'fill' && decision.answer) {
          value = decision.answer; source = `screening:${decision.matchedId || 'server'}`;
        } else {
          const screening = screeningFor(label, payload.screeningAnswers || []);
          if (screening) { value = screening.answer; source = `screening:${screening.id}`; }
        }
      }
      if (value == null || String(value).trim() === '') {
        if (isRequired(el)) { blockers.push(`Required field needs your answer: ${label}`); mark(el, 'review'); }
        continue;
      }

      const result = setControl(el, value);
      if (result.ok) { filled.push({ field: canonical || 'screening', label, source }); mark(el, 'filled'); }
      else { blockers.push(`${label}: ${result.reason}`); mark(el, 'review'); }
    }
    const requiredMissing = missingRequired(applicationRoot)
      .map((el) => labelFor(el) || el.name || 'required field');
    for (const label of requiredMissing) blockers.push(`Required field needs review: ${label}`);
    const finalSubmitVisible = [...applicationRoot.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .some((el) => visible(el) && /^(submit|submit application|send application|complete application)$/i.test(controlText(el)));
    const uniqueBlockers = [...new Set(blockers)].slice(0, 40);
    const readyForReview = finalSubmitVisible && requiredMissing.length === 0 && filled.length > 0;
    showBanner(filled.length, uniqueBlockers.length);
    return result({
      contextVerified: true, formDetected: true, readyForReview,
      finalSubmitVisible, requiredMissing, observedUrl: location.href,
      filled, blockers: uniqueBlockers,
    });
  }

  function result(values = {}) {
    return {
      mainFrame: isMainFrame(), startedApplication: false, formDetected: false,
      readyForReview: false, contextVerified: false, observedUrl: location.href,
      filled: [], blockers: [], ...values,
    };
  }

  function isMainFrame() { try { return window.top === window; } catch { return false; } }

  function verifyJobContext(payload = {}, connection = {}) {
    if (connection.trustedHost) return true;
    const expected = String(connection.expectedHost || '').toLowerCase();
    if (expected && location.hostname.toLowerCase() === expected) return true;
    if (!/(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter)\./i.test(expected)) return false;
    const page = norm(document.body?.innerText || '');
    const company = significantTokens(payload.job?.company);
    const title = significantTokens(payload.job?.title);
    const companyHits = company.filter((token) => page.includes(token)).length;
    const titleHits = title.filter((token) => page.includes(token)).length;
    return companyHits >= Math.max(1, Math.ceil(company.length / 2))
      && titleHits >= Math.min(2, Math.max(1, title.length));
  }

  function significantTokens(value) {
    const ignored = new Set(['the', 'company', 'inc', 'llc', 'corp', 'corporation', 'and', 'of', 'at', 'a']);
    return [...new Set(norm(value).split(' ').filter((token) => token.length > 2 && !ignored.has(token)))];
  }

  function findApplyStartControl() {
    const candidates = [...document.querySelectorAll('a, button, [role="button"], input[type="button"]')]
      .filter((el) => visible(el) && !el.disabled)
      .filter((el) => /^(apply|apply now|start application|begin application|continue application|apply for this job)$/i.test(controlText(el)))
      .filter((el) => !/submit|send application|complete application/i.test(controlText(el)));
    return candidates[0] || null;
  }

  function controlText(el) {
    return String(el.innerText || el.value || el.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
  }

  function controlHasValue(el) {
    const type = String(el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return Boolean(el.checked);
    if (type === 'file') return Boolean(el.files?.length);
    return String(el.value || '').trim().length > 0;
  }

  // REQUIRED, the way modern application forms say it. Greenhouse, Ashby,
  // Lever, Workday and LinkedIn render custom selects and radio groups that
  // carry aria-required="true" and no native `required`, so checking only
  // [required] reported "ready for review" with required answers still empty.
  function isRequired(el) {
    return Boolean(el.required) || el.getAttribute('aria-required') === 'true'
      || Boolean(el.closest('[aria-required="true"]'));
  }
  function missingRequired(root) {
    const found = [];
    for (const el of root.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]')) {
      if (found.some((outer) => outer.contains(el))) continue; // one widget, reported once
      const type = String(el.type || '').toLowerCase();
      if (type === 'hidden' || !visible(el)) continue;
      if (!widgetHasValue(el)) found.push(el);
    }
    return found;
  }
  function widgetHasValue(el) {
    const tag = el.tagName.toLowerCase();
    const role = String(el.getAttribute('role') || '').toLowerCase();
    if (role === 'radiogroup' || role === 'group' || tag === 'fieldset') {
      return Boolean(el.querySelector('input:checked, [role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"]'));
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (controlHasValue(el)) return true;
      return role === 'combobox' && comboHasSelection(el);
    }
    const inner = el.querySelector('input:not([type="hidden"]), textarea, select');
    if (inner && controlHasValue(inner)) return true;
    return comboHasSelection(el);
  }
  // A custom select shows its choice beside an empty search input: a hidden
  // input with the value, a "single value" element, or a selected option.
  function comboHasSelection(el) {
    if (String(el.getAttribute('aria-valuetext') || '').trim()) return true;
    const box = el.closest('[class*="select" i], [class*="combobox" i], [class*="dropdown" i]') || el.parentElement;
    if (!box) return false;
    if ([...box.querySelectorAll('input[type="hidden"]')].some((h) => String(h.value || '').trim())) return true;
    return Boolean(box.querySelector('[class*="single-value" i], [class*="singlevalue" i], [class*="multi-value" i], [aria-selected="true"]'));
  }

  function findApplicationRoot() {
    // LinkedIn Easy Apply and several ATS products render the active step in a
    // dialog. Prefer that narrow scope so page search/navigation fields are
    // never mistaken for application fields.
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')];
    const applyDialog = dialogs.find((el) => /\b(apply|application)\b/i.test(el.innerText || ''));
    if (applyDialog) return applyDialog;

    // Otherwise require a form with strong application evidence. This keeps
    // generic career pages/search pages read-only until their actual form opens.
    const forms = [...document.querySelectorAll('form')];
    const evidenced = forms.find((form) => {
      const text = [...form.querySelectorAll('label,legend,button,h1,h2,h3')]
        .map((el) => el.innerText || el.textContent || '').join(' ');
      const identitySignals = ['first name', 'last name', 'email', 'phone', 'resume', 'résumé', 'cover letter']
        .filter((term) => norm(text).includes(norm(term))).length;
      return form.querySelector('input[type="file"]') || identitySignals >= 2
        || /submit application|apply for this job|job application/i.test(text);
    });
    return evidenced || null;
  }

  function valuesFrom(profile = {}) {
    const id = profile.identity || {}, contact = profile.contact || {}, loc = profile.location || {}, links = id.links || {};
    const parts = String(id.fullName || '').trim().split(/\s+/);
    return {
      firstName: parts[0] || '', lastName: parts.slice(1).join(' '), preferredName: id.preferredName || parts[0] || '',
      fullName: id.fullName || '', email: contact.email || '', phone: contact.phone || '',
      addressLine1: loc.street || '', addressLine2: loc.street2 || '', city: loc.city || '', state: loc.state || '',
      zip: loc.zip || '', country: loc.country || '', location: [loc.city, loc.state].filter(Boolean).join(', '),
      linkedin: links.linkedin || '', github: links.github || '', portfolio: links.portfolio || links.website || '',
    };
  }

  function canonicalFor(label, name) {
    const text = norm(`${label} ${name}`);
    if (/phone.*(extension|device|type|country code)/.test(text)) return null;
    for (const [key, aliases] of Object.entries(ALIASES)) if (aliases.some((a) => text === a || text.includes(a))) return key;
    return null;
  }
  function screeningFor(label, answers) {
    const text = norm(label);
    const matches = answers.filter((a) => (a.patterns || []).some((p) => text.includes(norm(p))));
    matches.sort((a, b) => Math.max(...b.patterns.map((p) => norm(p).length)) - Math.max(...a.patterns.map((p) => norm(p).length)));
    return matches[0] || null;
  }

  function setControl(el, raw) {
    const value = String(raw).trim();
    if (el.tagName === 'SELECT') {
      const wanted = norm(value);
      const options = [...el.options];
      const exact = options.find((o) => norm(o.textContent) === wanted || norm(o.value) === wanted);
      const yesNo = /^yes\b/i.test(value) ? options.find((o) => /^yes\b/i.test(o.textContent))
        : /^no\b/i.test(value) ? options.find((o) => /^no\b/i.test(o.textContent)) : null;
      const option = exact || yesNo;
      if (!option) return { ok: false, reason: 'no exact safe dropdown option; choose manually' };
      el.value = option.value; fire(el); return { ok: true };
    }
    if ((el.type || '').toLowerCase() === 'radio') {
      const group = [...document.querySelectorAll(`input[type="radio"][name="${css(el.name)}"]`)];
      const wanted = /^yes\b/i.test(value) ? /^yes\b/i : /^no\b/i.test(value) ? /^no\b/i : new RegExp(`^${escapeRe(value)}$`, 'i');
      const target = group.find((r) => wanted.test(labelFor(r)) || wanted.test(r.value));
      if (!target) return { ok: false, reason: 'no exact safe radio option; choose manually' };
      target.click(); return { ok: true };
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    fire(el);
    return { ok: el.value.trim().length > 0, reason: 'value did not remain set' };
  }

  // The content script never sees the connection key or the server URL: it
  // runs inside a third-party page, and anything it holds that page can read.
  // It names WHAT it needs; the service worker builds the request itself.
  async function attach(input, jobId, kind, name) {
    const response = await chrome.runtime.sendMessage({ type: 'JOB_AGENT_FETCH_ARTIFACT', jobId, kind, name });
    if (!response?.ok) throw new Error(response?.error || 'could not load approved artifact');
    const binary = atob(response.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], response.name || name, { type: response.type || 'application/octet-stream' });
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; fire(input);
    if (!input.files?.length) throw new Error('browser rejected the file attachment; select it manually');
  }

  function labelFor(el) {
    if (el.labels?.length) return [...el.labels].map((x) => x.innerText).join(' ').trim();
    const aria = el.getAttribute('aria-label'); if (aria) return aria.trim();
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length) return ids.map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
    const legend = el.closest('fieldset')?.querySelector('legend')?.innerText;
    return (legend || el.placeholder || el.name || '').trim();
  }
  function visible(el) { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; }
  function fire(el) { for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true })); }
  function mark(el, state) { el.dataset.jobAgent = state; el.style.outline = state === 'filled' ? '2px solid #38b26f' : '2px solid #e4a11b'; }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function css(s) { return globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function showBanner(filled, blockers, detail = '') {
    document.getElementById('__job_agent_banner')?.remove();
    const b = document.createElement('div'); b.id = '__job_agent_banner';
    b.textContent = detail || `Job Agent filled ${filled} field(s); ${blockers} need review. It did not submit.`;
    Object.assign(b.style, { position:'fixed', top:'12px', right:'12px', zIndex:'2147483647', padding:'12px 16px', maxWidth:'360px', background:'#10141b', color:'#fff', border:'1px solid #4c8dff', borderRadius:'8px', font:'14px system-ui', boxShadow:'0 6px 24px #0008' });
    document.documentElement.appendChild(b); setTimeout(() => b.remove(), 10000);
  }
})();
