/** The detail rail / sheet: keyed sections, notes autosave, action plans, resume card. */

import { compactLocation, withoutTitleTerms } from './format.js';
import { $, el, esc, relTime, safeHref, shortStamp, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { sponsorshipEvidence, sponsorshipTitle, statusLabel } from './board.js';
import { openDialog, placeToasts } from './dialogs.js';
import { autofillBlockedReason, BROWSER_MISSING, placeholderList, prepareBlockedNotice } from './today.js';
import { rewritesSection } from './rewrites.js';
import { versionsSection } from './versions.js';

/* ──────────────────────── detail rail ──────────────────────── */

/**
 * Narrow layouts show the detail in a sheet; wide ones in the sticky rail.
 *
 * At <=1240px the page is one column, and the rail used to land UNDER the
 * whole board: selecting a row changed something ~7,000px below the viewport
 * and nothing on screen. The sheet opens where the user is looking.
 */
export const SHEET_QUERY = matchMedia('(max-width: 1240px)');
export const isSheetLayout = () => SHEET_QUERY.matches;

export let selectTimer = null;

/** Mark the open job's row, and only that row. */
export function markCurrentRow(id) {
  for (const tr of $('rows').querySelectorAll('tr.job')) {
    // Present-or-absent, not "true"/"false": aria-current="false" is a valid
    // value meaning "not current", but it still marks the row as participating,
    // and 99 rows announcing their non-currency is noise.
    if (tr.dataset.id === id) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  }
  for (const card of document.querySelectorAll('.ws-card[data-id]')) card.classList.toggle('current', card.dataset.id === id);
  for (const card of document.querySelectorAll('.tcard[data-id]')) {
    card.classList.toggle('current', card.dataset.id === id);
  }
}

/**
 * Open a job in the detail rail.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {boolean} [options.focusRow] move focus to the job's board row
 * @param {boolean} [options.user] a person asked for this job (click, Enter,
 *   a Today card). On a narrow layout that opens the sheet; a background
 *   refresh re-rendering the same job never does.
 * @param {number} [options.defer] debounce the fetch, in ms. Arrow-key browsing
 *   fired one detail request per keypress; holding ↓ for a second queued ~30.
 */
export async function selectJob(id, { focusRow = false, user = false, defer = 0 } = {}) {
  // Leaving a job with an unsaved note saves it rather than dropping it.
  if (id !== state.selectedId) flushNote();
  state.selectedId = id;
  markCurrentRow(id);
  if (focusRow) {
    $('rows').querySelector(`tr.job[data-id="${cssEscape(id)}"]`)?.focus();
  }
  history.replaceState(null, '', `#job=${encodeURIComponent(id)}`);
  if (user && isSheetLayout()) openDetailSheet(id);

  clearTimeout(selectTimer);
  if (defer > 0) {
    await new Promise((resolve) => { selectTimer = setTimeout(resolve, defer); });
    if (state.selectedId !== id) return;
  }
  await loadDetail(id);
}

/**
 * Close the rail's job: nothing selected, the placeholder back, no #job= hash.
 */
export function clearDetail() {
  flushNote();
  clearTimeout(selectTimer);
  state.selectedId = null;
  markCurrentRow(null);
  if (location.hash.startsWith('#job=')) history.replaceState(null, '', location.pathname + location.search);
  const host = $('detail');
  if (!host || host.querySelector(':scope > .panel.empty')) return;
  host.textContent = '';
  host.append(el('div', { class: 'panel empty' },
    el('div', { class: 'big', text: 'Select a job' }),
    'Its grade, fit breakdown, sponsorship, tailored resume, and next best action appear here.'));
}

/**
 * Keep the rail in step with the list the person is looking at (BUG-11).
 * Switching Jobs -> Applications left an unrelated discovery job open beside
 * a list that did not contain it. The open job stays only when the new list
 * shows it; otherwise the list's first item opens on a wide layout (an empty
 * rail is a third of the screen doing nothing), and a phone shows nothing.
 *
 * @param {string[]} ids the list's job ids, in order
 */
export function syncDetailToList(ids = []) {
  if (state.selectedId && ids.includes(state.selectedId)) return;
  if (ids.length && !isSheetLayout()) selectJob(ids[0]);
  else if (state.selectedId) clearDetail();
}

/**
 * Open a job AND show the part of its detail a card's button promised.
 *
 * "See what stopped it" used to call selectJob alone. When that job was
 * already open (the board selects it, and the rail shows it beside the
 * board), nothing on screen changed, so the button read as broken. Now the
 * reason is scrolled into view, briefly marked, and the way out — "Retry
 * auto-fill", "Mark it submitted"… — takes focus so Enter acts on it.
 *
 * @param {string} id
 * @param {string[]} [keys] rail sections to reveal, first one present wins
 */
/**
 * What focus may be handed to unasked: the primary action first, never a
 * statement of fact (data-confirms) and never a button that opens a browser
 * and starts filling (data-launches). After "Approve only", focus landed on
 * "Fill in browser", so a second Enter meant for the first click started an
 * application nobody chose to start.
 */
const NOT_AUTO = ':not([disabled]):not([data-confirms]):not([data-launches])';
const AUTO_FOCUSABLE = [`button.primary${NOT_AUTO}`, `button${NOT_AUTO}`, 'a[href]'];
// When the person ASKED to be taken to the next step ("See what stopped it"),
// its launch button may take focus: that click was a choice, not a redraw.
const NOT_CONFIRM = ':not([disabled]):not([data-confirms])';
const ASKED_FOCUSABLE = [`button.primary${NOT_CONFIRM}`, `button${NOT_CONFIRM}`, 'a[href]'];
const firstAutoFocusable = (root, { asked = false } = {}) => (asked ? ASKED_FOCUSABLE : AUTO_FOCUSABLE)
  .map((sel) => root?.querySelector(sel)).find(Boolean) ?? null;

export async function revealInDetail(id, keys = ['attention', 'next']) {
  await selectJob(id, { user: true });
  if (state.selectedId !== id) return;
  const host = $('detail');
  const section = keys.map((key) => host?.querySelector(`[data-section="${key}"]`)).find(Boolean);
  if (!section) return;
  // Scroll the rail (or the sheet), never the window: scrollIntoView also
  // moved the page, sliding the section's heading under the sticky top bar.
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const scroller = railScroller();
  if (scroller?.contains(section)) {
    const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
  }
  section.classList.remove('is-spotlit');
  void section.offsetWidth; // restart the cue on a second click
  section.classList.add('is-spotlit');
  setTimeout(() => section.classList.remove('is-spotlit'), 1600);
  const nextSection = host.querySelector('[data-section="next"]');
  const way = firstAutoFocusable(nextSection, { asked: true });
  if (way) way.focus({ preventScroll: true });
  else if (nextSection) { nextSection.tabIndex = -1; nextSection.focus({ preventScroll: true }); }
}

export async function loadDetail(id) {
  const host = $('detail');
  let job;
  try {
    job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    if (state.selectedId !== id) return;
    host.textContent = '';
    host.append(el('div', { class: 'panel empty', text: err.message }));
    return;
  }
  if (state.selectedId !== id) return; // user moved on
  state.detailJob = job;
  state.known.set(job.id, { ...(state.known.get(job.id) ?? {}), ...job });
  renderDetail(job);
}

export function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/** The element that scrolls the detail: the sheet body, or the sticky rail. */
export function railScroller() {
  const sheet = $('dlgDetail');
  return sheet?.open ? $('dlgDetailBody') : document.querySelector('.rail-sticky');
}

/** Put #detail wherever the current layout shows it. */
export function placeDetail() {
  const detail = $('detail');
  const sheet = $('dlgDetail');
  if (!detail || !sheet) return;
  if (isSheetLayout()) {
    if (detail.parentElement !== $('dlgDetailBody')) $('dlgDetailBody').append(detail);
  } else {
    if (sheet.open) sheet.close();
    const rail = document.querySelector('.rail-sticky');
    if (detail.parentElement !== rail) rail.append(detail);
  }
}

/** Which job the sheet was opened for, so closing it can return focus there. */
export let sheetReturnId = null;

export function openDetailSheet(id) {
  const sheet = $('dlgDetail');
  sheetReturnId = id;
  placeDetail();
  if (!sheet.open) sheet.showModal();
  placeToasts();
  // Focus goes to the sheet's heading, not its first button: landing on
  // "Open posting" or "Reject" is one Enter away from an action nobody chose.
  $('dlgDetailTitle').focus();
}

/** The control that represents a job wherever it is currently visible. */
export function jobAnchor(id) {
  const selector = `tr.job[data-id="${cssEscape(id)}"], .tcard[data-id="${cssEscape(id)}"] .tcard-title`;
  return [...document.querySelectorAll(selector)].find((node) => node.offsetParent !== null) ?? null;
}

/*
 * THE RAIL IS RECONCILED, NOT REBUILT.
 *
 * Every refresh — the 90s background poll, each decision, each link save, the
 * end of a run — used to clear the rail and draw it again. That wiped a note
 * being typed (verified: the text was simply gone), threw focus to <body>,
 * shut every open <details>, jumped the rail back to the top and erased the
 * link-check result. The rail is now a list of keyed sections: re-rendering
 * the SAME job swaps only sections the user is not in, and leaves a section
 * holding focus — or an unsaved note — exactly as it is.
 */
export const railSection = (key, ...children) => el('div', { class: 'rail-sec', 'data-section': key }, ...children);

export function renderDetail(job) {
  const host = $('detail');
  const sections = detailSections(job);
  const current = host.querySelector(':scope > .panel[data-job-id]');
  if (current && current.dataset.jobId === job.id) {
    reconcileDetail(current, sections);
    return;
  }
  if (note.id !== job.id) {
    note.id = job.id;
    note.saved = job.notes ?? '';
  }
  host.textContent = '';
  const panel = el('div', { class: 'panel detail-panel', 'data-job-id': job.id });
  panel.append(...sections);
  host.append(panel);
  // A different job starts at its top; the same job keeps its place (above).
  const scroller = railScroller();
  if (scroller) scroller.scrollTop = 0;
}

/** A section is left untouched while the user is working inside it. */
export function keepSection(node, key) {
  if (key === 'notes' && note.isDirty()) return true;
  const active = document.activeElement;
  if (!active || !node.contains(active)) return false;
  // Kept only while you are IN something: typing, choosing, or inside an open
  // menu. A button that merely holds focus after you pressed it is not state —
  // keeping its section for that left "Do this next" showing the OLD step
  // after "I submitted it myself" changed the job (the dialog hands focus back
  // to the button that opened it).
  return active.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    || Boolean(active.closest('details[open]'));
}

/** Re-apply the open/closed state of keyed <details> to their replacement. */
export function carryOpenDetails(from, to) {
  for (const open of from.querySelectorAll('details[data-key][open]')) {
    to.querySelector(`details[data-key="${cssEscape(open.dataset.key)}"]`)?.setAttribute('open', '');
  }
}

export function reconcileDetail(panel, sections) {
  const scroller = railScroller();
  const top = scroller?.scrollTop ?? 0;
  const old = new Map([...panel.children].map((node) => [node.dataset.section, node]));
  const focused = document.activeElement;
  let refocus = null;
  let anchor = null;
  for (const node of sections) {
    const key = node.dataset.section;
    const prev = old.get(key);
    old.delete(key);
    let placed = node;
    // A kept node is never MOVED: detaching an element, even to reinsert it a
    // moment later, blurs whatever inside it had focus.
    if (prev && keepSection(prev, key)) placed = prev;
    else if (prev) {
      if (prev.contains(focused)) refocus = node;
      carryOpenDetails(prev, node);
      prev.replaceWith(node);
    }
    else if (anchor) anchor.after(node);
    else panel.prepend(node);
    anchor = placed;
  }
  for (const [key, prev] of old) if (!keepSection(prev, key)) prev.remove();
  if (!old.has('notes') && !note.isDirty()) note.saved = state.detailJob?.notes ?? note.saved;
  if (scroller) scroller.scrollTop = top;
  // Focus was on a button in a section that was just redrawn: hand it to the
  // same section's new first action, never drop it to <body>.
  if (refocus && refocus.isConnected) {
    const next = firstAutoFocusable(refocus);
    if (next) next.focus({ preventScroll: true });
    else { refocus.tabIndex = -1; refocus.focus({ preventScroll: true }); }
  }
}

/** The grade's own label is the verdict; `fit` is only the fallback. */
export function verdictLabel(job) {
  return job.grade?.label ?? fitLabel(job.fit);
}

const MONTH = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null;
};

/**
 * Employer history (sponsorship answers on other postings; reposts), or null.
 * Counts, never a verdict on this posting: the person weighs it.
 */
export function historyCard(job) {
  const h = job.history;
  if (!h) return null;
  const lines = el('ul', { class: 'readiness' });
  const e = h.employer;
  if (e && (e.sponsorYes || e.sponsorNo)) {
    const kind = e.verdict === 'unlikely' ? 'portal' : e.verdict === 'likely' ? 'instant' : 'unknown';
    const said = [e.sponsorYes ? `${e.sponsorYes} said they sponsor` : null, e.sponsorNo ? `${e.sponsorNo} said sponsorship is not available` : null]
      .filter(Boolean).join(', ');
    lines.append(el('li', { class: `rd rd-${kind}` },
      el('b', { text: e.verdict === 'unlikely' ? 'Other postings say no sponsorship' : e.verdict === 'likely' ? 'Other postings say they sponsor' : 'Mixed answers on sponsorship' }),
      el('span', { class: 'muted', text: `Of ${e.postings} postings from this employer in your store, ${said}. This posting's own wording decides; this is context.` })));
  }
  if (h.repost) {
    const since = MONTH(h.repost.since);
    lines.append(el('li', { class: 'rd rd-portal' },
      el('b', { text: `Posted ${h.repost.count} times${since ? ` since ${since}` : ''}` }),
      el('span', { class: 'muted', text: `The same title at this employer keeps reappearing over ${h.repost.spanDays} days — often an evergreen or reposted requisition rather than one open seat.` })));
  }
  return lines.children.length ? lines : null;
}

const PLATFORM_NAMES = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', jobvite: 'Jobvite',
  rippling: 'Rippling', workday: 'Workday', oraclerecruiting: 'Oracle Recruiting', oracle: 'Oracle Recruiting',
  icims: 'iCIMS', taleo: 'Taleo', successfactors: 'SuccessFactors',
};

/** Access (account or not) and open questions, as two plain lines. */
export function readinessCard(job) {
  const a = job.access ?? { kind: 'unknown', label: 'Application system not identified' };
  const name = PLATFORM_NAMES[a.platform] ?? null;
  const access = a.kind === 'instant'
    ? `${name ?? 'This system'} needs no account — Auto-fill can start straight away.`
    : a.kind === 'portal'
      ? `${name ?? 'This employer'} needs a candidate account. The first fill stops at sign-in; sign in once in that window and it is remembered.`
      : 'The application system is not identified yet; Auto-fill will find out when it opens the posting.';
  const questions = job.openQuestions ?? [];
  const wrap = el('ul', { class: 'readiness' });
  wrap.append(el('li', { class: `rd rd-${a.kind}` }, el('b', { text: a.label }), el('span', { class: 'muted', text: access })));
  const q = el('li', { class: `rd ${questions.length ? 'rd-portal' : 'rd-instant'}` },
    el('b', { text: questions.length ? `${questions.length} unanswered question${questions.length === 1 ? '' : 's'}` : 'No unanswered questions' }));
  if (questions.length) {
    q.append(el('span', { class: 'muted', text: questions.slice(0, 3).map((x) => `“${x.label}”`).join(', ') + (questions.length > 3 ? '…' : '') }),
      el('button', { type: 'button', class: 'small', 'data-action': 'open-profile', text: 'Answer them' }));
  } else {
    q.append(el('span', { class: 'muted', text: 'None recorded for this job. Questions a form asks that your answers cannot cover are saved here.' }));
  }
  wrap.append(q);
  return wrap;
}

/** The posting's buried conditions as small expandable tags. */
export function clauseStrip(clauses) {
  const list = el('ul', { class: 'clauses', 'aria-label': 'Conditions stated in this posting' });
  for (const c of clauses) {
    list.append(el('li', { class: `clause k-${c.kind}` },
      el('details', { 'data-key': `clause-${c.kind}` },
        el('summary', { text: c.label }),
        el('q', { class: 'clause-quote', text: c.quote }))));
  }
  return list;
}

export function detailSections(job) {
  const out = [];

  // header — the grade's label is the one verdict shown. A separate chip that
  // re-derived "medium fit" from `job.fit` could sit next to a grade reading
  // "Strong fit", and the two then contradicted each other.
  const head = el('div', { class: 'detail-head' });
  head.append(el('span', {
    class: `grade big ${job.grade ? job.grade.letter : 'none'}`,
    role: 'img',
    'aria-label': job.grade ? `grade ${job.grade.letter}, ${job.grade.label}` : 'not scored yet',
    text: job.grade ? job.grade.letter : '—',
  }));
  const headMain = el('div', { class: 'grow-1' });
  headMain.append(el('h2', { class: 'detail-title', text: `${job.company || 'Company on posting'} — ${job.title}` }));
  // "via greenhouse · ATS greenhouse" said one fact twice: when a job was
  // found on the employer's own application system, name it once.
  const ats = job.atsPlatform && job.atsPlatform !== job.source ? `applies on ${job.atsPlatform}` : null;
  const fullMeta = [job.location, job.remote ? 'remote' : null, job.postedLabel, `via ${job.source}`, ats]
    .filter(Boolean).join(' · ');
  const meta = [compactLocation(job.location), job.remote ? 'remote' : null, job.postedLabel, `via ${job.source}`, ats]
    .filter(Boolean).join(' · ');
  headMain.append(el('div', { class: 'muted detail-meta', title: fullMeta, text: meta }));

  const chips = el('div', { class: 'chiprow' });
  chips.append(el('span', {
    class: `chip ${job.fit}`,
    title: job.score != null ? `Skills-match score ${job.score}/100` : 'Not scored yet',
    text: job.score != null ? `${verdictLabel(job)} · ${job.score}` : verdictLabel(job),
  }));
  chips.append(el('span', {
    class: `chip ${esc(job.sponsorship ?? '')}`,
    title: sponsorshipTitle(job),
    text: `Sponsorship: ${job.sponsorship ?? 'unknown'}`,
  }));
  if (job.employmentLabel) chips.append(el('span', { class: 'chip', text: job.employmentLabel }));
  chips.append(el('span', { class: `chip st-${job.appStatus}`, text: statusLabel(job) }));
  if (job.decisionReason) {
    chips.append(el('span', { class: 'chip', title: 'Why you closed this job', text: `reason: ${reasonLabel(job.decisionReason)}` }));
  }
  // Checked against the posting's own ATS (daily in the background, or with
  // "Check link"): the one fact that decides whether applying is possible.
  if (job.linkState === 'open' || job.linkState === 'closed') {
    const when = relTime(job.linkCheckedAt);
    chips.append(el('span', {
      class: `chip ${job.linkState === 'open' ? 'good' : 'bad'}`,
      title: `Checked against the employer's job system${job.linkCheckedAt ? ` at ${shortStamp(job.linkCheckedAt)}` : ''}`,
      text: job.linkState === 'open'
        ? `● posting open${when ? ` · checked ${when}` : ''}`
        : '✕ closed by the employer',
    }));
  }
  if (job.atsScore != null) {
    // This number is keyword coverage of the posting by the tailored resume —
    // not a pass/fail from any applicant tracking system. It used to read
    // "ATS 65%" in a neutral chip even when the report's own band said
    // below_threshold, beside "ATS generic" (the platform) in the same header.
    const band = ATS_BANDS[job.atsBand] ?? null;
    chips.append(el('span', {
      class: `chip ${band?.tone ?? ''}`.trim(),
      title: 'How much of this posting\'s key terms the tailored resume covers (estimated). '
        + 'It is not a score from the employer\'s applicant tracking system.',
      text: `Keyword match ${job.atsScore}%${band ? ` · ${band.label}` : ''}`,
    }));
  }
  headMain.append(chips);
  head.append(headMain);
  out.push(railSection('head', head));
  // Conditions the posting buries (a 90-day onsite ramp-up under "Hybrid",
  // 50% travel, an on-call rotation): stated up top, each opening onto the
  // sentence it came from so it can be checked, not trusted.
  if (job.clauses?.length) out.push(railSection('clauses', clauseStrip(job.clauses)));
  out.push(railSection('stepper', stepper(job.progress)));

  // attention
  if (job.statusReason && ['blocked', 'failed', 'cancelled', 'rejected', 'discarded', 'skipped',
    'date_unconfirmed', 'submit_unverified', 'needs_description'].includes(job.appStatus)) {
    const box = el('div', { class: 'attention' });
    box.append(el('span', { class: 'mark', text: '!' }));
    const detail = el('div', {});
    detail.append(el('b', { text: statusLabel(job) }), el('br'),
      job.attention?.summary || job.statusReason);
    if (job.attention?.summary && job.statusReason !== job.attention.summary) {
      const more = el('details', { 'data-key': 'technical' });
      more.append(el('summary', { class: 'muted', text: 'Technical detail' }),
        el('div', { class: 'muted', text: job.statusReason }));
      detail.append(more);
    }
    box.append(detail);
    out.push(railSection('attention', el('h3', { text: 'Needs attention' }), box));
  }

  // next best action
  const next = nextBestAction(job);
  out.push(railSection('next', el('h3', { text: 'Do this next' }), next));

  const history = historyCard(job);
  if (history) out.push(railSection('history', el('h3', { text: 'This employer, from your saved postings' }), history));

  // Before a browser opens: will this need an employer account, and which of
  // the form's questions is nobody ready to answer?
  if (job.access && !['submitted', 'rejected', 'archived', 'discarded'].includes(job.appStatus)) {
    out.push(railSection('readiness', el('h3', { text: 'Auto-fill readiness' }), readinessCard(job)));
  }

  // After a submission, what the employer did and when to chase it. Right
  // under the next step, because once applied this IS the next step.
  if (job.application?.appStatus === 'submitted') {
    out.push(railSection('application', el('h3', { text: 'Application' }), applicationCard(job.application)));
  }

  // WHY THIS FIT, before the materials and buttons: the explanation is what
  // a decision is made on, and it sat below nine action buttons.
  out.push(railSection('fit', fitCard(job)));

  // resume card — the feature the workflow revolves around
  out.push(railSection('resume', resumeCard(job)));
  const rewrites = rewritesSection(job);
  if (rewrites) out.push(rewrites);
  const versions = versionsSection(job);
  if (versions) out.push(versions);

  // quick actions
  // Three groups: what you do most (open, shortlist, reject) stays visible;
  // the link tools, the less common decisions and the manual submit record go
  // behind one disclosure. Nine same-weight buttons in a wrap read as none.
  const actions = el('div', { class: 'actions' });
  const more = el('div', { class: 'actions more-actions-list' });
  // A row with no stored URL used to render a dead <a> with no href that looked
  // clickable and did nothing. Say what is missing instead.
  const postingHref = safeHref(job.url);
  if (postingHref) {
    actions.append(el('a', { class: 'btn', href: postingHref, target: '_blank', rel: 'noopener noreferrer', text: 'Open posting ↗' }));
    more.append(el('button', { class: 'small', 'data-action': 'check-link', 'data-id': job.id, text: 'Check link' }));
  } else {
    actions.append(el('span', { class: 'chip bad', title: 'This job has no application URL stored', text: 'no posting URL' }));
  }
  more.append(el('button', { class: 'small', 'data-action': 'open-link-dialog', 'data-id': job.id, text: 'Replace URL' }));
  // A decision "Do this next" already offers is not offered again one row
  // down — Shortlist sat in both. It moves into "More actions", so it is
  // still reachable from the same place as every other decision.
  const offered = new Set([...next.querySelectorAll('[data-action="decide"]')].map((b) => b.dataset.decision));
  // THE WAY BACK, NAMED AND IN VIEW. Undoing a decision was a generic "Clear"
  // under More actions, so "how do I unarchive this?" or "how do I take it off
  // my shortlist?" had no visible answer (Reject looked like the only way out,
  // and it is a different decision). The job's current decision is replaced by
  // the button that undoes it; with no decision there is nothing to undo.
  //
  // A submitted application is a record, not a candidate to sort: rejecting
  // it only skewed the counts while the row still read "Submitted".
  const current = job.userDecision ?? null;
  const decisions = ['submitted', 'submit_unverified'].includes(job.appStatus) ? [] : [['shortlisted', '★ Shortlist', true], ['rejected', '✕ Reject', true],
    ['archived', 'Archive', false], ['clear', UNDO_LABEL[current], true]];
  for (const [decision, label, visible] of decisions) {
    if (decision === current) continue;
    // "Do this next" already offers the undo for a rejected/archived job, under
    // the same name; a second copy hidden in More actions is only noise.
    if (decision === 'clear' && (!UNDO_LABEL[current] || offered.has('clear'))) continue;
    (visible && !offered.has(decision) ? actions : more).append(el('button', {
      class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': decision, text: label,
    }));
  }
  if (job.approvalStatus === 'pending_review') {
    more.append(el('button', { class: 'small', 'data-action': 'reject-packet', 'data-id': job.id, text: 'Reject packet' }));
  }
  // Available at every stage except the ones where it's meaningless: already
  // recorded (submitted) or a closed/dead row (rejected/archived/discarded).
  // Applying yourself, outside the guided flow, is not gated on having run
  // Prepare/Approve/Auto-fill first — a job can sit at `discovered` or `scored`
  // and still have been applied to on the employer's own site.
  if (!['submitted', 'rejected', 'archived', 'discarded'].includes(job.appStatus)) {
    more.append(el('button', { class: 'small', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'I submitted it myself' }));
  }
  const disclosure = el('details', { class: 'more-actions', 'data-key': 'more-actions' },
    el('summary', { class: 'small', text: 'More actions' }), more);
  actions.append(disclosure);
  // The last link check survives re-renders: it is a result the user asked
  // for, and redrawing the rail used to erase it a few seconds later.
  const health = state.linkHealth.get(job.id);
  out.push(railSection('actions', actions, el('div', {
    class: `linkhealth ${health?.tone ?? ''}`.trim(), id: 'linkHealth', 'aria-live': 'polite', text: health?.text ?? '',
  })));

  // submission record
  if (job.appStatus === 'submitted') {
    const box = el('div', { class: 'why' });
    box.append(`Submitted by you on ${shortStamp(job.appliedAt)}`);
    if (job.submittedConfirmation) {
      box.append(el('br'), 'Confirmation: ', el('b', { text: job.submittedConfirmation }));
    }
    out.push(railSection('submission', el('h3', { text: 'Submission record' }), box));
  }

  out.push(railSection('sponsorship', el('h3', { text: 'Sponsorship' }), sponsorshipEvidence(job)));


  out.push(railSection('notes', notesEditor(job)));

  // assist history
  if (job.assistFilledCount != null) {
    const box = el('div', {});
    box.append(`${job.assistFilledCount} field(s) filled`);
    if (job.assistBlockers?.length) {
      const ul = el('ul', { class: 'plan' });
      for (const blocker of job.assistBlockers) ul.append(el('li', { class: 'st-blocked', text: blocker }));
      box.append(ul);
    } else box.append(' · no blockers');
    out.push(railSection('assist', el('h3', { text: 'Last assisted fill' }), box));
  }

  if (job.packet) out.push(railSection('packet', packetSection(job.packet, job.id)));

  // job id (for the browser extension)
  const idRow = el('div', { class: 'row-gap' });
  idRow.append(el('code', { class: 'jobid', text: job.id }),
    el('button', { class: 'small', 'data-action': 'copy-id', 'data-id': job.id, text: 'Copy' }));
  out.push(railSection('jobid', el('h3', { text: 'Job id' }), idRow));

  if (job.events?.length) {
    const ul = el('ul', { class: 'plan' });
    for (const event of job.events) {
      ul.append(el('li', {},
        el('span', { class: 'faint', text: shortStamp(event.at) }), ` ${event.type} — ${event.message ?? ''}`));
    }
    out.push(railSection('audit', el('h3', { text: 'Audit trail' }), ul));
  }
  return out;
}

/* ─────────────────────────── notes ───────────────────────────
 * Notes save themselves: a debounce while typing, and immediately on blur or
 * when another job is opened. There was only a "Save note" button, and
 * anything typed without pressing it was lost to the next refresh. */

export const NOTE_DEBOUNCE_MS = 1200;

export const note = {
  /** Job the editor belongs to, and the value the server last confirmed. */
  id: null,
  saved: '',
  timer: null,
  inflight: null,
  box() {
    const box = $('noteBox');
    return box && box.dataset.id === this.id ? box : null;
  },
  isDirty() {
    const box = this.box();
    return Boolean(box) && (box.value !== this.saved || this.inflight !== null);
  },
};

export function notesEditor(job) {
  const wrap = el('div', { class: 'notes' });
  const textarea = el('textarea', {
    id: 'noteBox', 'data-id': job.id, rows: '3', 'aria-describedby': 'noteStatus',
    placeholder: 'Private reminders — saved as you type, and exported to CSV…',
  });
  textarea.value = job.notes ?? '';
  wrap.append(el('label', { for: 'noteBox', class: 'rail-label', text: 'Your notes' }), textarea,
    el('div', { class: 'note-foot' },
      el('span', { id: 'noteStatus', class: 'note-status faint', 'aria-live': 'polite', text: job.notes ? 'Saved' : '' }),
      el('button', { class: 'small ghost', 'data-action': 'save-note', 'data-id': job.id, text: 'Save now' })));
  return wrap;
}

export function setNoteStatus(kind, detail = '') {
  const node = $('noteStatus');
  if (!node) return;
  const text = {
    saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: `Couldn’t save — ${detail}`,
  }[kind] ?? '';
  node.textContent = text;
  node.className = `note-status ${kind === 'error' ? 'st-blocked' : kind === 'dirty' ? 'warn-text' : 'faint'}`;
}

export async function saveNote() {
  clearTimeout(note.timer);
  const box = note.box();
  if (!box) return;
  const id = note.id;
  // One write at a time per job; a later edit waits and then saves the latest.
  if (note.inflight) {
    await note.inflight.catch(() => {});
    if (note.id === id) await saveNote();
    return;
  }
  const value = box.value;
  if (value === note.saved) { setNoteStatus('saved'); return; }
  setNoteStatus('saving');
  note.inflight = postJson(`/api/jobs/${encodeURIComponent(id)}/note`, { note: value });
  try {
    await note.inflight;
    if (note.id !== id) return;
    note.saved = value;
    const known = state.known.get(id);
    if (known) known.notes = value;
    if (state.detailJob?.id === id) state.detailJob.notes = value;
    setNoteStatus(note.box()?.value === value ? 'saved' : 'dirty');
  } catch (err) {
    if (note.id === id) setNoteStatus('error', err.message);
  } finally {
    note.inflight = null;
  }
}

/** Save an unsaved note for the job being left, without waiting on it. */
export function flushNote() {
  const box = note.box();
  if (!box || box.value === note.saved) return;
  clearTimeout(note.timer);
  const id = note.id;
  const value = box.value;
  note.saved = value;
  postJson(`/api/jobs/${encodeURIComponent(id)}/note`, { note: value })
    .then(() => { const known = state.known.get(id); if (known) known.notes = value; })
    .catch((err) => toast(`Your note on the previous job was not saved: ${err.message}`, 'bad'));
}

document.addEventListener('input', (event) => {
  if (event.target.id !== 'noteBox') return;
  setNoteStatus('dirty');
  clearTimeout(note.timer);
  note.timer = setTimeout(saveNote, NOTE_DEBOUNCE_MS);
});
document.addEventListener('focusout', (event) => {
  if (event.target.id === 'noteBox') saveNote();
});
// Closing the tab mid-sentence: keepalive lets the request outlive the page,
// and unlike sendBeacon it can carry the X-Job-Agent header.
window.addEventListener('pagehide', () => {
  const box = note.box();
  if (!box || box.value === note.saved) return;
  fetch(`/api/jobs/${encodeURIComponent(note.id)}/note`, {
    method: 'POST', keepalive: true,
    headers: { 'content-type': 'application/json', 'X-Job-Agent': '1' },
    body: JSON.stringify({ note: box.value }),
  }).catch(() => {});
});

/**
 * The keyword-coverage bands written by src/resume/atsReport.py, in words and
 * tone. Unknown bands render the number alone rather than a guessed verdict.
 */
const ATS_BANDS = Object.freeze({
  below_threshold: { label: 'below target', tone: 'warn' },
  strong: { label: 'in target range', tone: 'good' },
  over_optimized: { label: 'possibly keyword-stuffed', tone: 'warn' },
});

/** Why a job was closed. Order is the order the chips are offered in. */
export const DECISION_REASONS = [
  ['salary', 'Salary'], ['location', 'Location'], ['seniority', 'Seniority'],
  // Key `stack` is stored data and stays; its LABEL is the profession-neutral
  // word — "Stack" only meant something to software roles.
  ['sponsorship', 'Sponsorship'], ['stack', 'Skills'], ['company', 'Company'],
  ['stale', 'Stale'], ['other', 'Other'],
];
export const reasonLabel = (key) => DECISION_REASONS.find(([k]) => k === key)?.[1] ?? String(key ?? '');

export function fitLabel(fit) {
  return { strong: 'strong fit', medium: 'medium fit', weak: 'weak fit', no_fit: 'no fit', unscored: 'unscored' }[fit] ?? fit;
}

export function keywordList(list = [], tone = '') {
  if (!list.length) return el('div', { class: 'muted', text: 'none' });
  const wrap = el('div', { class: 'kwlist' });
  for (const kw of list) wrap.append(el('span', { class: `chip ${tone}`, text: kw }));
  return wrap;
}

const OFF_RAMP_WORDS = Object.freeze({
  blocked: ['Paused — waiting on you', 'warn'],
  failed: ['Stopped by an error', 'bad'],
  cancelled: ['Paused — you stopped the run', ''],
  skipped: ['Skipped', ''],
  rejected: ['Rejected', ''],
  archived: ['Archived', ''],
  discarded: ['Discarded', ''],
  date_unconfirmed: ['Posting date not confirmed yet', 'warn'],
  submit_unverified: ['Submitted? Not confirmed yet', 'warn'],
  needs_description: ['Waiting for the job description', ''],
});

export function stepper(progress) {
  if (!progress) return el('div');
  const labels = ['Found', 'Scored', 'Shortlist', 'Prepared', 'Approved', 'Ready', 'Submitted'];
  if (progress.offRamp) {
    // Plain words for where the job is parked. "Off the happy path: blocked"
    // in alarm red read as a crash for what is usually one question to answer.
    const [words, tone] = OFF_RAMP_WORDS[progress.stage] ?? [progress.stage.replace(/_/g, ' '), ''];
    return el('div', { class: 'offramp' },
      el('span', { class: `offramp-dot ${tone}`.trim(), 'aria-hidden': 'true' }),
      el('span', { text: words }));
  }
  const wrap = el('div');
  const bars = el('div', { class: 'stepper' });
  labels.forEach((_, i) => {
    bars.append(el('div', { class: `s ${i < progress.index ? 'done' : i === progress.index ? 'now' : ''}`.trim() }));
  });
  wrap.append(bars, el('div', { class: 'steplabels' },
    el('span', { text: labels[0] }),
    el('span', { text: labels[progress.index] ?? '' }),
    el('span', { text: labels.at(-1) })));
  return wrap;
}

/** True when a URL is an aggregator listing rather than a real application form. */
export function isAggregatorUrl(url) {
  try {
    return /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice)\./i
      .test(new URL(url).hostname);
  } catch { return false; }
}

/**
 * "Why this fit": the score, what it means, and the evidence behind it, as
 * one card. The explanation, matched skills and missing skills used to be
 * three sections at the bottom of the rail, below every button.
 */
export function fitCard(job) {
  const unread = job.appStatus === 'needs_description';
  const missing = withoutTitleTerms(job.missingKeywords ?? [], job.title);
  // A term the scorer lists as BOTH found and missing is not evidenced in the
  // resume; showing it as a strength would overclaim.
  const missingSet = new Set(missing.map((t) => String(t).toLowerCase()));
  const matched = withoutTitleTerms(job.matchedKeywords ?? [], job.title)
    .filter((t) => !missingSet.has(String(t).toLowerCase()));
  const card = el('div', { class: 'fitcard' });
  const head = el('div', { class: 'fitcard-head' });
  head.append(el('h3', { text: job.grade?.label ? `Why: ${job.grade.label.toLowerCase()}` : 'Why this may be a fit' }));
  if (job.score != null && !unread) {
    const fill = el('i');
    fill.style.width = `${Math.max(4, Math.min(100, Number(job.score)))}%`;
    head.append(el('div', { class: `fitcard-score ${job.fit ?? ''}`.trim(), 'aria-label': `score ${job.score} out of 100` },
      el('b', { text: String(job.score) }), el('span', { class: 'muted', text: '/100' }),
      el('span', { class: 'fitmeter-bar', 'aria-hidden': 'true' }, fill)));
  }
  card.append(head);
  if (unread) {
    card.append(el('p', { class: 'fitcard-summary', text:
      'Not judged yet: only a summary of this posting was read. Read its description from More actions → Discovery and data quality, or open the posting.' }));
  } else {
    // Plain words first; the scorer's own breakdown stays one click away.
    const asked = matched.length + missing.length;
    const parts = [];
    if (job.grade?.label && job.score != null) parts.push(`${job.grade.label} at ${job.score}/100.`);
    if (asked) parts.push(`${matched.length} of the ${asked} skills this posting asks for are in your resume.`);
    if (job.sponsorshipGated) parts.push('Held back from automatic preparation until you confirm the employer sponsors.');
    if (parts.length) card.append(el('p', { class: 'fitcard-summary', text: parts.join(' ') }));
    const raw = job.explanation ?? job.discardReason ?? (parts.length ? null : 'Not scored yet.');
    if (raw && parts.length) {
      card.append(el('details', { class: 'fitcard-raw', 'data-key': 'score-detail' },
        el('summary', { text: 'How this score was calculated' }), el('div', { class: 'why', text: raw })));
    } else if (raw) {
      card.append(el('div', { class: 'why', text: raw }));
    }
  }
  if (!unread && (matched.length || missing.length)) {
    card.append(el('div', { class: 'fitcard-skills' },
      el('div', {},
        el('h4', { text: `Your skills found in this posting (${matched.length})` }), keywordList(matched, 'good')),
      el('div', {},
        el('h4', { text: `Asked for, not evidenced in your resume (${missing.length})` }), keywordList(missing, 'bad'))));
  }
  const evidence = (job.evidence ?? []).filter((e) => !String(job.title ?? '').toLowerCase().includes(String(e.term).toLowerCase()));
  if (!unread && evidence.length) card.append(evidenceList(evidence));
  return card;
}

/**
 * Where each asked-for skill is proven in the master resume, quoted. An
 * unproven skill says so and points at the master resume: if the person has
 * that experience, writing it there (truthfully, in their words) is the fix.
 */
export function evidenceList(evidence) {
  const proven = evidence.filter((e) => e.lines.length).length;
  const list = el('ul', { class: 'evidence' });
  for (const e of evidence) {
    const item = el('li', { class: e.lines.length ? 'ev ok' : 'ev none' }, el('b', { class: 'ev-term', text: e.term }));
    if (e.lines.length) for (const line of e.lines) item.append(el('q', { class: 'ev-line', text: line }));
    else item.append(el('span', { class: 'ev-line muted', text: 'No line in your master resume mentions this. If you have done it, add it there in your own words.' }));
    list.append(item);
  }
  const unproven = evidence.length - proven;
  const details = el('details', { class: 'fitcard-evidence', 'data-key': 'evidence' },
    el('summary', { text: `Evidence from your master resume (${proven} of ${evidence.length} proven)` }), list);
  if (unproven) details.append(el('button', { type: 'button', class: 'small', 'data-action': 'open-master', text: 'Open master resume' }));
  return details;
}

/** Local calendar day, `offset` days from today, as YYYY-MM-DD. */
export function localDay(offset = 0) {
  const at = new Date();
  at.setDate(at.getDate() + offset);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

const dayLabel = (day) => {
  const at = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? String(day ?? '')
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

const OUTCOME_CHOICES = {
  interviewing: 'Interviewing', offer: 'Offer received', hired: 'Hired',
  rejected: 'Rejected by employer', withdrawn: 'Withdrawn',
};

/**
 * The Application card: where a submitted application stands with the
 * employer, a form to record what happened next (validated server-side, and
 * undoable), the follow-up reminder, and the history so far.
 */
export function applicationCard(app) {
  const card = el('div', { class: 'appcard', 'data-id': app.id });
  const current = app.outcome?.label ?? 'Awaiting response';
  const tone = ['hired', 'offer'].includes(app.outcome?.outcome) ? 'good' : app.outcome?.outcome === 'rejected' ? 'bad' : '';
  const since = app.outcome?.on ? ` since ${dayLabel(app.outcome.on)}` : app.appliedOn ? `, applied ${dayLabel(app.appliedOn)}` : '';
  card.append(el('p', { class: 'appcard-status' },
    el('span', { class: `chip signal ${tone}`.trim(), text: current }), el('span', { class: 'muted', text: since })));
  if ((app.awaitingDays ?? 0) >= 14 && !app.followUp) {
    card.append(el('p', { class: 'appcard-hint', text: `No response recorded in ${app.awaitingDays} days. A short follow-up is often worth sending.` }));
  }

  if (app.allowedOutcomes?.length) {
    const form = el('div', { class: 'appcard-form', role: 'group', 'aria-label': 'Record what happened' });
    const select = el('select', { class: 'ap-outcome', 'aria-label': 'What happened' });
    for (const outcome of app.allowedOutcomes) select.append(el('option', { value: outcome, text: OUTCOME_CHOICES[outcome] ?? outcome }));
    form.append(
      el('div', { class: 'appcard-row' },
        select,
        el('input', { type: 'date', class: 'ap-on', 'aria-label': 'When it happened', value: localDay(), max: localDay() }),
        el('button', { type: 'button', class: 'small', 'data-action': 'ws-record-form', 'data-id': app.id, text: 'Record' })),
      el('input', { type: 'text', class: 'ap-note', maxlength: '500', 'aria-label': 'Note (optional)',
        placeholder: 'Note (optional): who you spoke with, next round…' }));
    card.append(form);
  }
  if (app.canUndoOutcome) {
    card.append(el('button', { type: 'button', class: 'linklike small', 'data-action': 'ws-undo-outcome', 'data-id': app.id,
      text: `Undo “${app.outcome.label}”` }));
  }

  // Follow-up: one open reminder at a time, or quick ways to set one.
  const follow = el('div', { class: 'appcard-follow' });
  follow.append(el('h4', { text: 'Follow-up' }));
  if (app.followUp) {
    const f = app.followUp;
    follow.append(el('p', { class: f.due ? 'appcard-due' : '' },
      el('b', { text: f.due ? (f.daysLate ? `Due ${f.daysLate} day${f.daysLate === 1 ? '' : 's'} ago` : 'Due today') : `By ${dayLabel(f.dueOn)}` }),
      f.note ? el('span', { class: 'muted', text: ` · ${f.note}` }) : null));
    follow.append(el('div', { class: 'appcard-row' },
      el('button', { type: 'button', class: 'small primary', 'data-action': 'ws-followup', 'data-op': 'done', 'data-id': app.id, text: 'Done' }),
      el('button', { type: 'button', class: 'small ghost', 'data-action': 'ws-followup', 'data-op': 'dismissed', 'data-id': app.id, text: 'Dismiss' })));
  } else if (app.stage !== 'closed') {
    follow.append(el('div', { class: 'appcard-row' },
      el('button', { type: 'button', class: 'small', 'data-action': 'ws-followup-set', 'data-days': '7', 'data-id': app.id, text: 'In 1 week' }),
      el('button', { type: 'button', class: 'small', 'data-action': 'ws-followup-set', 'data-days': '14', 'data-id': app.id, text: 'In 2 weeks' }),
      el('input', { type: 'date', class: 'ap-due', 'aria-label': 'Follow-up date', min: localDay() }),
      el('button', { type: 'button', class: 'small ghost', 'data-action': 'ws-followup-set', 'data-id': app.id, text: 'Set' })));
  } else {
    follow.append(el('p', { class: 'muted', text: 'Closed applications need no follow-up.' }));
  }
  card.append(follow);

  // History, oldest first: the submission, then every outcome still in effect.
  const steps = el('ol', { class: 'appcard-timeline', 'aria-label': 'Application history' });
  if (app.appliedOn) steps.append(el('li', {}, el('b', { text: 'Submitted' }), el('span', { class: 'muted', text: ` · ${dayLabel(app.appliedOn)}` })));
  for (const step of app.outcomeHistory ?? []) {
    steps.append(el('li', {}, el('b', { text: step.label }),
      el('span', { class: 'muted', text: step.on ? ` · ${dayLabel(step.on)}` : '' }),
      step.note ? el('div', { class: 'muted', text: step.note }) : null));
  }
  if (steps.children.length) card.append(steps);
  return card;
}

export function nextBestAction(job) {
  const box = el('div', { class: 'nba' });
  const { text, buttons } = actionPlan(job);
  box.append(el('div', { class: 'nba-text', text }));
  const row = el('div', { class: 'nba-actions' });
  // ONE primary. Several steps offered two or three filled buttons side by
  // side ("Review resume", "Auto-fill application"), so nothing read as THE
  // next step. The first stays primary; the rest become ordinary buttons.
  let primarySeen = false;
  for (const button of buttons) {
    if (!button?.nodeType) { if (button) row.append(button); continue; }
    if (button.classList?.contains('primary')) {
      if (primarySeen) button.classList.remove('primary');
      primarySeen = true;
    }
    row.append(button);
  }
  box.append(row);
  return box;
}

export const autofillButton = (id, label = 'Auto-fill application') => {
  const blocked = autofillBlockedReason();
  return el('button', {
    class: 'small primary', 'data-action': 'autofill-one', 'data-id': id, 'data-launches': '',
    disabled: Boolean(blocked),
    title: blocked ?? 'Prepare a packet if needed, approve it, open the posting, fill everything it can — and stop before Submit.',
    text: label,
  });
};

/** Where the filler's inputs live — offered wherever an auto-fill can stall. */
export const setupLinks = () => [
  el('button', { class: 'small ghost', 'data-action': 'open-profile', title: 'What the filler types, and how it answers form questions', text: 'Application profile' }),
  el('button', { class: 'small ghost', 'data-action': 'open-master', title: 'The resume every tailored version is built from', text: 'Master resume' }),
];

export function actionPlan(job) {
  const postingHref = safeHref(job.url);
  // No safe URL means nothing to open; an <a> without an href would look
  // clickable and do nothing, so the button simply is not offered.
  const openPosting = () => (postingHref ? el('a', {
    class: 'btn small', href: postingHref, target: '_blank', rel: 'noopener noreferrer', text: 'Open posting ↗',
  }) : null);
  const markSubmitted = () => el('button', {
    class: 'small primary', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'I submitted it myself',
  });
  // The same record, offered beside a retry rather than as the main step.
  const submittedMyself = () => el('button', {
    class: 'small', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: '✓ I submitted it myself',
  });

  if (job.appStatus === 'submitted') {
    // The automation's part is done; the application is not. What the
    // employer does next is recorded in the Application section below.
    const app = job.application;
    if (app?.followUp?.due) return { text: 'Submitted. Your follow-up is due — send it, then mark it done below.', buttons: [] };
    if (app?.stage === 'closed') return { text: `Submitted and closed: ${app.outcome?.label ?? 'finished'}.`, buttons: [] };
    return { text: 'Submitted. Record each response as it arrives, and set a follow-up if you want a reminder.', buttons: [] };
  }
  if (job.appStatus === 'submit_unverified') {
    return {
      // The server's explanation knows whether this was our click or the
      // human's own submit; fall back to the generic wording only without it.
      text: 'Did it go through? Check your email or the employer\'s site for a confirmation.',
      // Three ways out. This used to offer only "I submitted it myself" again,
      // which without a confirmation number changed nothing: a loop.
      buttons: [
        // data-confirms: a statement of fact, so focus is never moved onto it
        // for you — one stray Enter must not record a submission.
        el('button', { class: 'small primary', 'data-action': 'confirm-went-through', 'data-confirms': '', 'data-id': job.id, text: '✓ Yes, it went through' }),
        el('button', { class: 'small', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'Add confirmation number…' }),
        el('button', { class: 'small ghost', 'data-action': 'not-submitted', 'data-confirms': '', 'data-id': job.id, text: 'No, it didn\'t' }),
        openPosting(),
      ],
    };
  }
  // Closed, filtered, rejected, archived and unread jobs come FIRST: the fit
  // branches below would otherwise offer "Auto-fill application" on a job the
  // person rejected, or that the employer closed.
  if (job.appStatus === 'rejected' || job.appStatus === 'archived') {
    return {
      text: `You ${job.appStatus} this job, so nothing will be filled or sent. Restore it if you changed your mind.`,
      buttons: [el('button', { class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'clear', text: `↺ ${UNDO_LABEL[job.appStatus] ?? 'Restore'}` })],
    };
  }
  if (job.linkState === 'closed') {
    return { text: 'The employer has closed this posting, so there is nothing to apply to.', buttons: [openPosting()] };
  }
  if (job.appStatus === 'discarded') {
    return {
      text: `Filtered out${job.discardReason ? `: ${job.discardReason}` : ''}. Nothing is filled or sent for a filtered job.`,
      buttons: [openPosting()],
    };
  }
  if (job.appStatus === 'needs_description') {
    return {
      text: 'Not judged yet: only a summary was read, so the fit shown is not a verdict. Open the posting, or fetch the description from More actions.',
      buttons: [openPosting()],
    };
  }
  if (job.appStatus === 'needs_review') {
    const open = job.packet?.needsUser?.length ?? 0;
    return {
      text: 'Packet is prepared. Review the tailored resume, then auto-fill opens the application and stops for your review.'
        + (open ? ` ${open} question${open === 1 ? '' : 's'} still need${open === 1 ? 's' : ''} your answer (listed under "Questions left for you") before it can finish.` : ''),
      buttons: [
        el('button', { class: 'small primary', 'data-action': 'preview-resume', 'data-id': job.id, text: 'Review resume' }),
        autofillButton(job.id),
        el('button', { class: 'small', 'data-action': 'approve', 'data-id': job.id, text: '✓ Approve only' }),
      ],
    };
  }
  if (job.appStatus === 'approved') {
    return {
      text: 'Approved. Open it in a browser — it fills the form and stops before Submit.',
      buttons: [el('button', {
        class: 'small primary', 'data-action': 'assist', 'data-id': job.id, 'data-launches': '', text: '▶ Fill in browser',
        disabled: Boolean(autofillBlockedReason()), title: autofillBlockedReason(),
      }), el('button', { class: 'small', 'data-action': 'preview-resume', 'data-id': job.id, text: 'View resume' }),
      // Approving is reversible until the application is filled.
      el('button', { class: 'small ghost', 'data-action': 'unapprove', 'data-id': job.id, text: 'Unapprove' })],
    };
  }
  if (job.appStatus === 'ready_for_submit') {
    return {
      text: 'Filled and waiting — review the open browser tab, click Submit yourself, then record it here.',
      buttons: [markSubmitted(), autofillButton(job.id, '↻ Re-fill'), openPosting()],
    };
  }
  if (['blocked', 'failed', 'cancelled'].includes(job.appStatus)) {
    const kind = job.attention?.kind;
    if (isAggregatorUrl(job.url) || kind === 'aggregator') {
      return {
        text: 'This is an aggregator listing, not a reliable application form. Open it, follow Apply to the '
          + 'employer site, then save that direct URL here.',
        buttons: [openPosting(), el('button', {
          class: 'small', 'data-action': 'open-link-dialog', 'data-id': job.id, text: 'Save direct URL',
        }), submittedMyself()],
      };
    }
    if (['dead_link', 'restricted_link'].includes(kind)) {
      return {
        text: job.attention.summary,
        buttons: [
          el('button', { class: 'small primary', 'data-action': 'check-link', 'data-id': job.id, text: 'Check link' }),
          el('button', { class: 'small', 'data-action': 'open-link-dialog', 'data-id': job.id, text: 'Replace URL' }),
        ],
      };
    }
    // A missing browser is the cause, not this job: say so here rather than
    // offering a retry that is certain to fail the same way.
    if (state.browserUnavailable || BROWSER_MISSING.test(job.statusReason ?? '')) {
      return {
        text: 'Auto-fill could not start a browser. Install it once (npx playwright install chromium in the JobAgent folder), then retry.',
        buttons: [autofillButton(job.id, '↻ Retry auto-fill'), openPosting()],
      };
    }
    // Most stalls are a question the profile cannot answer or a field it
    // leaves blank — so the two places that fix them sit next to the retry.
    // "Needs attention" right above already says WHAT stopped it; repeating
    // that sentence here word for word made the panel read twice. This box
    // says what to DO.
    // Finishing the form by hand in the window we left open is the step this
    // panel asks for, so recording that must be right here. It used to exist
    // only on "ready to submit": a person who completed and submitted a
    // stopped application had no way to say so, and the job stayed "Needs
    // your help" (2026-11-12, Oracle).
    return {
      text: job.statusReason
        ? 'Sort out that step — in the open browser window, or in your Application profile if a question had no answer — then retry auto-fill. Finished and submitted it yourself? Record it.'
        : 'The assistant stopped because this step needs you. Complete it in the browser, then retry auto-fill — or record it if you submitted it yourself.',
      buttons: [autofillButton(job.id, '↻ Retry auto-fill'), submittedMyself(), openPosting(), ...setupLinks()],
    };
  }
  if (job.sponsorshipGated) {
    return {
      text: 'Strong fit, but sponsorship is unconfirmed — check the employer sponsors H-1B, then shortlist and prepare.',
      buttons: [
        openPosting(),
        el('button', { class: 'small primary', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'shortlisted', text: '★ Shortlist' }),
        // PREPARE, not auto-fill: filling an application whose tailored resume
        // nobody has read skipped the review step the whole workflow rests on.
        el('button', { class: 'small', 'data-action': 'prepare-one', 'data-id': job.id, text: 'Prepare anyway' }),
      ],
    };
  }
  if (job.appStatus === 'shortlisted') {
    return {
      text: 'Shortlisted — auto-fill prepares the tailored packet and fills the application in one pass.',
      buttons: [autofillButton(job.id), el('button', {
        class: 'small', 'data-action': 'prepare-one', 'data-id': job.id, text: 'Prepare only',
      })],
    };
  }
  if (['no_fit', 'weak'].includes(job.fit)) {
    return {
      text: 'Low fit — probably not worth your time. Reject it to keep the board focused.',
      buttons: [el('button', {
        class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'rejected', text: '✕ Reject',
      })],
    };
  }
  if (job.fit === 'strong') {
    return {
      text: 'Strong fit — auto-fill tailors the resume, fills the application, and stops before Submit.',
      buttons: [autofillButton(job.id), el('button', {
        class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'shortlisted', text: '★ Shortlist',
      })],
    };
  }
  return {
    text: 'Review the fit and sponsorship below, then shortlist or reject.',
    buttons: [autofillButton(job.id), el('button', {
      class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'shortlisted', text: '★ Shortlist',
    })],
  };
}

/**
 * How long the tailored resume is. Says "2 pages" only when a PDF was actually
 * rendered and counted; an estimate is labelled as one rather than presented as
 * a measurement.
 */
export function pageLabel(tailoring) {
  if (!tailoring) return null;
  if (Number.isFinite(tailoring.pageCount)) {
    return `${tailoring.pageCount} page${tailoring.pageCount === 1 ? '' : 's'}`;
  }
  if (Number.isFinite(tailoring.estimatedPages)) {
    return `~${Math.max(1, Math.ceil(tailoring.estimatedPages))} page(s) est.`;
  }
  return null;
}

/** The button that undoes each decision, in the words of what it undoes. */
export const UNDO_LABEL = Object.freeze({
  shortlisted: 'Remove from shortlist',
  archived: 'Unarchive',
  rejected: 'Undo reject',
});

/** Hover text on a Prepare control while template text blocks it. */
const PREPARE_BLOCKED_TITLE = 'Off until your profile holds no template text. The box below lists each value and where to fix it.';

/**
 * Why this job cannot be prepared, shown where Prepare is clicked and kept
 * there until fixed. A refused Prepare used to leave only a passing toast and
 * "Prepared 0 packet(s)", so it looked as if the click did nothing.
 */
export function prepareProblemBox(jobId) {
  const blocked = prepareBlockedNotice();
  if (blocked) {
    return el('div', { class: 'attention prepare-problem', role: 'status' },
      el('span', { class: 'mark', text: '!' }),
      el('div', {},
        el('b', { text: 'Prepare is off: your profile still holds template text.' }),
        el('div', { text: 'Replace each value below with your real, truthful one. This box clears once they are all fixed.' }),
        blocked.items?.length ? placeholderList(blocked.items) : null));
  }
  const failure = state.prepareFailures?.get(jobId);
  if (failure) {
    return el('div', { class: 'attention prepare-problem', role: 'status' },
      el('span', { class: 'mark', text: '!' }),
      el('div', {},
        el('b', { text: 'The last Prepare of this job failed.' }),
        el('div', { text: failure })));
  }
  return null;
}

/** The resume review card: status, what changed, and one-click preview. */
export function resumeCard(job) {
  const card = el('div', { class: 'resume-card' });
  const blocked = Boolean(prepareBlockedNotice());
  const head = el('div', { class: 'rc-head' });
  head.append(el('span', { class: 'rc-title', text: 'Tailored resume' }));

  const packet = job.packet;
  const hasFile = Boolean(job.resumeDocxPath || job.resumePdfPath);
  if (!hasFile) {
    head.append(el('span', { class: 'chip', text: 'not prepared' }));
    card.append(head);
    card.append(el('div', { class: 'muted', text: 'No tailored resume yet. Prepare this job to generate one from your master resume.' }));
    card.append(prepareProblemBox(job.id) ?? '');
    card.append(el('div', { class: 'actions' },
      el('button', {
        class: 'small primary', 'data-action': 'prepare-one', 'data-id': job.id, text: 'Prepare resume',
        disabled: blocked, title: blocked ? PREPARE_BLOCKED_TITLE : null,
      }),
      el('button', {
        class: 'small ghost', 'data-action': 'open-master',
        title: 'View, edit, or replace the master resume every tailored version is built from.',
        text: 'Master resume',
      }),
      el('button', {
        class: 'small ghost', 'data-action': 'open-profile',
        title: 'The details and answers the form filler uses on every application.',
        text: 'Application profile',
      })));
    return card;
  }

  head.append(el('span', {
    class: `chip ${packet?.resumeTailored ? 'good' : 'warn'}`,
    title: packet?.resumeTailored
      ? 'Built from your master resume for this posting'
      : 'Tailoring did not run — your master resume was used as-is',
    text: packet?.resumeTailored ? 'tailored' : 'master fallback',
  }));
  card.append(head);

  // Big, obvious click target straight into the preview.
  const thumb = el('button', { class: 'resume-thumb', 'data-action': 'preview-resume', 'data-id': job.id });
  thumb.append(el('span', { class: 'pageicon', 'aria-hidden': 'true' }));
  const tmeta = el('span', { class: 'rt-meta' });
  tmeta.append(el('b', { text: 'View tailored resume' }));
  const bits = [];
  // Length first: a resume that quietly ran to three pages is the single most
  // common thing to catch in review.
  const pages = pageLabel(packet?.tailoring);
  if (pages) bits.push(pages);
  if (packet?.atsReport?.match_score != null) bits.push(`ATS match ${packet.atsReport.match_score}%`);
  if (packet?.tailoring?.changes?.length) bits.push(`${packet.tailoring.changes.length} update(s)`);
  if (packet?.tailoring?.gaps?.length) bits.push(`${packet.tailoring.gaps.length} gap(s)`);
  tmeta.append(el('span', { text: bits.join(' · ') || 'Opens the PDF preview' }));
  thumb.append(tmeta);
  card.append(thumb);

  const links = el('div', { class: 'actions' });
  if (job.resumePdfPath) {
    links.append(el('a', {
      class: 'btn small', href: `/api/jobs/${encodeURIComponent(job.id)}/resume?format=pdf`,
      target: '_blank', rel: 'noopener', text: 'Open PDF ↗',
    }));
  }
  links.append(el('a', {
    class: 'btn small', href: `/api/jobs/${encodeURIComponent(job.id)}/resume?format=docx`, text: 'Download DOCX',
  }));
  if (packet?.resumeTailored && job.resumeDocxPath) {
    // Before and after, line by line: what moved, what was left out, and
    // whether any of it mattered. Left-out lines can be kept from here.
    const omittedCount = (packet?.tailoring?.changes ?? [])
      .find((c) => c.type === 'fit_to_page_budget')?.evidence?.[0]?.omitted?.length ?? 0;
    links.append(el('button', {
      class: 'small', 'data-action': 'open-resume-diff', 'data-id': job.id,
      title: 'See every difference from your master resume, and keep anything that was left out',
      text: omittedCount ? `Compare · ${omittedCount} left out` : 'Compare with master',
    }));
  }
  links.append(el('button', {
    class: 'small', 'data-action': 'prepare-one', 'data-id': job.id,
    title: blocked ? PREPARE_BLOCKED_TITLE : 'Regenerate the tailored resume and refresh this audit', text: '↻ Re-tailor',
    disabled: blocked,
  }));
  card.append(links);
  card.append(prepareProblemBox(job.id) ?? '');

  if (packet?.resumeWarning) {
    card.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: packet.resumeWarning })));
  }
  return card;
}

export function packetSection(packet, jobId = null) {
  const wrap = el('div');
  if (packet.error) {
    wrap.append(el('h3', { text: 'Application packet' }));
    wrap.append(el('div', { class: 'st-blocked', text: packet.error }));
    return wrap;
  }

  wrap.append(el('h3', { text: 'Application packet' }));
  const guarantee = el('div', { class: 'muted' });
  guarantee.append(`Stops before submit: ${packet.stopBeforeSubmit ? 'yes' : 'NO — report this'} · `);
  guarantee.append(`submit-ready flag: ${packet.submitReady ? 'YES — report this' : 'no'}`);
  wrap.append(guarantee);
  const letter = coverLetterSection(packet, jobId);
  if (letter) wrap.append(letter);

  if (packet.tailoring?.changes?.length || packet.tailoring?.gaps?.length) {
    wrap.append(el('h3', { text: 'What was changed in your resume' }));
    const ul = el('ul', { class: 'change-list' });
    for (const change of packet.tailoring.changes ?? []) {
      ul.append(el('li', { text: resumeChangeLabel(change) }));
    }
    if (!(packet.tailoring.changes ?? []).length) {
      ul.append(el('li', { class: 'muted', text: 'Nothing needed reordering — the master resume already led with the right content.' }));
    }
    wrap.append(ul);

    // Content that was left OUT to hold the page limit. Omissions matter as
    // much as changes at review time — this is the user's own experience being
    // held back, and they may want it in.
    const trimmed = (packet.tailoring.changes ?? [])
      .find((change) => change.type === 'fit_to_page_budget')
      ?.evidence?.[0]?.omitted ?? [];
    if (trimmed.length) {
      wrap.append(el('h3', { text: `Left out to fit the page limit (${trimmed.length})` }));
      wrap.append(el('div', {
        class: 'evidence-note',
        text: 'Whole bullets with the least relevance to this posting and no measured result, '
          + 'oldest roles first. Nothing was shortened or reworded, and your current role\'s '
          + 'evidence for required skills is never left out.',
      }));
      const omitted = el('ul', { class: 'change-list' });
      for (const entry of trimmed.slice(0, 8)) {
        omitted.append(el('li', { class: 'muted', text: entry.text }));
      }
      wrap.append(omitted);
      if (jobId) {
        wrap.append(el('button', {
          type: 'button', class: 'small', 'data-action': 'open-resume-diff', 'data-id': jobId,
          text: 'Compare and keep lines',
        }));
      }
    }

    if ((packet.tailoring.gaps ?? []).length) {
      wrap.append(el('h3', { text: 'Asked for, but not in your resume' }));
      wrap.append(el('div', {
        class: 'evidence-note',
        text: 'These were deliberately NOT added — they are job-description terms, not proven facts about you. '
          + 'If you genuinely have the experience, add a truthful bullet to your master resume and re-tailor.',
      }));
      const gaps = el('ul', { class: 'change-list' });
      for (const gap of packet.tailoring.gaps.slice(0, 8)) {
        gaps.append(el('li', {}, el('b', { text: gap.keyword ?? 'Requirement' }), ' — not evidenced'));
      }
      wrap.append(gaps);
    }
  }

  // Provenance for the optional grounded LLM requirement expansion.
  const llm = packet.llmRequirements;
  if (llm?.provenance) {
    wrap.append(el('h3', { text: 'Requirement analysis' }));
    const note = el('div', { class: 'grounded-note' });
    if (llm.provenance.skipped) {
      note.append(`Deterministic keyword matching only (${llm.provenance.skipped}).`);
    } else {
      note.append(`${llm.provenance.verified} requirement phrase(s) read from the posting`);
      if (llm.provenance.rejected) note.append(`, ${llm.provenance.rejected} rejected as not actually present`);
      note.append('. Every accepted phrase was found verbatim in the job description, and resume content '
        + 'stayed evidence-gated — nothing was written for you.');
    }
    wrap.append(note);
  }

  if (packet.prefillPlan?.length) {
    wrap.append(el('h3', { text: 'Form pre-fill plan' }));
    const ul = el('ul', { class: 'plan' });
    for (const field of packet.prefillPlan) {
      ul.append(el('li', {}, `${field.label} → `, el('b', { text: field.value }),
        ' ', el('span', { class: 'faint', text: `(${field.source})` })));
    }
    wrap.append(ul);
  }
  if (packet.needsUser?.length) {
    wrap.append(el('h3', { text: 'Questions left for you' }));
    const ul = el('ul', { class: 'plan' });
    for (const field of packet.needsUser) ul.append(el('li', { class: 'st-blocked', text: `${field.label} — needs you` }));
    wrap.append(ul);
  }
  if (packet.blockers?.length) {
    wrap.append(el('h3', { text: 'Blockers' }));
    const ul = el('ul', { class: 'plan' });
    for (const blocker of packet.blockers) ul.append(el('li', { class: 'st-blocked', text: blocker }));
    wrap.append(ul);
  }
  return wrap;
}

export function resumeChangeLabel(change = {}) {
  const labels = {
    reorder_skills: 'Reordered existing skills so this role’s requirements appear first.',
    reorder_summary: 'Prioritized existing summary content for this role.',
    reorder_experience_bullets: 'Prioritized existing bullets within the same role.',
    emphasize: 'Emphasized terms the posting asks for that your resume already supports.',
    focus_line: 'Added an evidence-backed role-focus line.',
    flatten_tables_for_ats: 'Converted layout tables to single-column text for safer ATS parsing.',
    stabilize_page_breaks: 'Kept section headings with their first content line.',
    normalize_layout: 'Cleaned up layout artifacts (manual page breaks, merged role blocks, blank filler).',
    fit_to_page_budget: 'Omitted the least relevant bullets from the oldest roles to hold the page limit.',
    rewrite: 'Used a rewording you accepted, backed by your own resume text.',
    rewrite_skipped: 'Skipped a rewording you accepted: that bullet is no longer in your master resume.',
  };
  const label = labels[change.type] || change.reason
    || String(change.type ?? 'Recorded an update').replace(/_/g, ' ');
  // These two describe WHAT they did in `after`, and that detail is the point.
  if (change.type === 'rewrite' && change.before && change.after) return `${label} "${change.before}" became "${change.after}"`;
  return ['normalize_layout', 'fit_to_page_budget'].includes(change.type) && change.after
    ? `${label} (${change.after})`
    : label;
}

/**
 * The job's cover letter: where its words came from, how it reads, and one
 * click to read or edit it. When no letter was written for the job, a draft
 * from the master cover letter is one click away instead.
 */
export function coverLetterSection(packet, jobId = null) {
  const grounding = packet.coverLetterGrounding;
  const wrap = el('div', { class: 'cl-grounding' });
  if (!packet.coverLetterGenerated || !grounding) {
    if (!jobId) return null;
    wrap.append(el('h3', { text: 'Cover letter' }));
    wrap.append(el('p', { class: 'muted', text: 'None was written for this job when it was prepared.' }));
    wrap.append(el('div', { class: 'row-gap' },
      el('button', { type: 'button', class: 'small', 'data-action': 'open-job-letter', 'data-id': jobId, text: 'Draft one' }),
      el('button', { type: 'button', class: 'small ghost', 'data-action': 'open-master-letter', text: 'Master cover letter' })));
    return wrap;
  }
  const head = el('div', { class: 'cl-head' }, el('h3', { text: 'Cover letter' }));
  const q = grounding.quality;
  if (q?.label) {
    const tone = q.label === 'Strong' ? 'good' : q.label === 'Good' ? 'info' : 'warn';
    head.append(el('span', { class: `chip ${tone}`, title: (q.issues ?? []).map((i) => i.message).join('\n') || 'No issues found', text: `${q.label} · ${q.words} words` }));
  }
  wrap.append(head);
  const from = {
    grounded: `Written from your resume: each of its ${grounding.paragraphs?.length ?? 0} paragraphs uses only lines it cites.`,
    master: `Tailored from your master cover letter${grounding.master?.depth ? ` (${grounding.master.depth} length for this match)` : ''}.`,
  }[grounding.mode] ?? (grounding.fallbackReason
    ? `Written from the basic template, because ${grounding.fallbackReason}.`
    : 'Written from the basic template. A master cover letter gives every job a fuller, more personal letter.');
  wrap.append(el('p', { text: from }));
  if (grounding.mode === 'grounded') {
    const ul = el('ul', { class: 'change-list' });
    for (const p of grounding.paragraphs ?? []) {
      ul.append(el('li', {}, el('span', { text: p.text }), el('span', { class: 'faint', text: ` (backed by ${p.evidence.length} resume line(s))` })));
    }
    wrap.append(ul);
  }
  if (grounding.dropped?.length) {
    wrap.append(el('p', { class: 'muted', text: `${grounding.dropped.length} suggested paragraph(s) were left out because your resume does not back them.` }));
  }
  const actions = el('div', { class: 'row-gap' });
  if (jobId) actions.append(el('button', { type: 'button', class: 'small', 'data-action': 'open-job-letter', 'data-id': jobId, text: 'Read and edit' }));
  if (grounding.mode !== 'master') actions.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'open-master-letter', text: 'Master cover letter' }));
  wrap.append(actions);
  if (packet.coverLetterDocxPath) {
    wrap.append(el('p', { class: 'faint', text: `Also saved as a Word document: ${String(packet.coverLetterDocxPath).split(/[\\/]/).pop()}` }));
  }
  // "Use template instead" for this job: takes effect when the application is
  // prepared again, which also sends an approved packet back to review.
  if (jobId && packet.letterMode === 'template') {
    wrap.append(el('p', { class: 'cl-choice', role: 'status', text: grounding.mode === 'grounded'
      ? 'You chose your own template for this job. Prepare this application again to rebuild the letter.'
      : 'You chose your own template for this job.' }));
    wrap.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-mode', 'data-id': jobId, 'data-mode': 'default', text: 'Write it from my resume again' }));
  } else if (jobId && grounding.mode === 'grounded') {
    wrap.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-mode', 'data-id': jobId, 'data-mode': 'template', text: 'Use my template for this job instead' }));
  }
  return wrap;
}

/* ─────────────────────── resume preview ─────────────────────── */

export async function openResumePreview(id) {
  const job = state.known.get(id) ?? state.detailJob;
  const dialog = $('dlgResume');
  $('dlgResumeSub').textContent = job ? `${job.company ?? ''} — ${job.title ?? ''}` : '';
  $('resumeFrameHost').textContent = '';
  const links = $('dlgResumeLinks');
  links.textContent = '';
  const status = $('resumePreviewStatus');
  status.className = 'preview-status';
  status.textContent = 'Preparing the PDF preview…';
  openDialog(dialog);

  try {
    const ready = await postJson(`/api/jobs/${encodeURIComponent(id)}/resume-preview`);
    const frame = el('iframe', {
      title: 'Tailored resume preview', loading: 'lazy',
      src: `${ready.url}&v=${Date.now()}`,
    });
    $('resumeFrameHost').append(frame);
    status.textContent = ready.generated ? 'Preview generated from the tailored DOCX.' : '';
    links.append(el('a', {
      class: 'btn small', href: ready.url, target: '_blank', rel: 'noopener', text: 'Full size ↗',
    }), el('a', {
      class: 'btn small', href: `/api/jobs/${encodeURIComponent(id)}/resume?format=docx`, text: 'Download DOCX',
    }));
  } catch (err) {
    status.className = 'preview-status bad';
    status.textContent = err.message;
    links.append(el('a', {
      class: 'btn small', href: `/api/jobs/${encodeURIComponent(id)}/resume?format=docx`, text: '⬇ Download DOCX instead',
    }));
  }
}

