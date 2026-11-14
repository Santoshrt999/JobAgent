/** The Today action queue, system notices, the Auto-fill gate and the setup checklist. */

import { $, el } from './dom.js';
import { state } from './state.js';
import { api, apiOptional } from './api.js';
import { statusLabel } from './board.js';
import { fitLabel, markCurrentRow, renderDetail, revealInDetail, syncDetailToList } from './detail.js';
import { autofillOne, decide, prepareOne, simpleAction } from './mutations.js';
import { syncSelectionBar } from './selection.js';
import { openHealth, openProfile } from './profile.js';
import { openSubmitDialog } from './actions.js';
import { savePreference } from './main.js';
import { APP_TABS, APP_TAB_KEYS } from './filters.js';
import { renderTabs } from './analytics.js';
import { freshnessOf } from './format.js';
import { loadBoard } from './board.js';
import { applyAppsLayout, openApplicationDetail } from './workspace.js';
import { signInStrip } from './signin.js';

/* ─────────────────────────── Today ───────────────────────────
 * The landing view: at most ten jobs, each with the ONE next action that
 * moves it forward. The board shows everything and asks the user to work out
 * what matters; this answers that question first, and the board stays one
 * click away.
 *
 * Contract: GET /api/today -> { generatedAt, items: [{ id, title, company,
 * location, score, grade, tier, appStatus, statusLabel, reason, nextAction:
 * { kind, label } }], systemNotices: [{ code, severity, message, fix }] }.
 * A server without the route gets the same view derived from
 * /api/sections?only=todaysPriorities, minus failed rows (a failure is not a
 * next step — its cause is, and that surfaces as a notice).
 */

export const VIEWS = ['today', 'board', 'applications'];

/** What each list view is for, in one line under its heading. */
const VIEW_COPY = {
  board: ['Jobs', 'Every open job that matches your search, best fit first.'],
  applications: ['Applications', 'Every application from tailored resume to offer, whichever search found it.'],
};

/**
 * Switch the main view.
 *
 * Jobs and Applications are the same board scoped to different stage tabs
 * (discovery stages vs application stages), so the VIEW follows the TAB: a
 * caller that opens the board on "Needs review" (a Today action, a metric, a
 * deep link) lands in Applications, and a Jobs stage opened from Applications
 * lands in Jobs. That keeps every existing `setView('board')` caller correct.
 *
 * `nav` marks a click on the view switch itself. Only that means "take me to
 * the Jobs list"; a programmatic `setView('board')` made while Applications is
 * open is a deep link onto its stage, and used to be reset to all jobs.
 */
export function setView(view, { save = true, nav = false } = {}) {
  if (!VIEWS.includes(view)) return;
  let tabChanged = false;
  if (view === 'applications') state.appsDeepLink = false;
  if (view !== 'today') {
    const appTab = APP_TAB_KEYS.has(state.activeTab);
    if (view === 'board' && appTab && nav) {
      // Jobs clicked from Applications: back to the discovery list.
      state.activeTab = 'all'; tabChanged = true;
    } else if (view === 'board' && appTab) {
      // A deep link (a next action, a metric) onto an application stage: show
      // the LIST, where the rows it counted are, not the workspace board.
      view = 'applications';
      state.appsDeepLink = true;
    } else if (view === 'applications' && !appTab) {
      state.activeTab = APP_TABS[0][0]; tabChanged = true;
    }
  }
  const changed = state.view !== view;
  state.view = view;
  // The next list to load decides what the rail shows (syncDetailToList).
  if (changed) state.syncDetail = true;
  $('todayView').hidden = view !== 'today';
  $('boardView').hidden = view === 'today';
  for (const button of document.querySelectorAll('[data-action="set-view"][aria-pressed]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  if (view !== 'today') {
    const [title, sub] = VIEW_COPY[view];
    $('boardHeading').textContent = title;
    $('boardSub').textContent = sub;
    if (changed || tabChanged) {
      state.page = 1;
      renderTabs();
      if (tabChanged) loadBoard();
      // The rows already on screen are this view's list: sync to them now.
      else if (state.syncDetail && view === 'board') { state.syncDetail = false; syncDetailToList(state.visible ?? []); }
    }
  }
  applyAppsLayout({ load: view === 'applications' && changed });
  if (save) savePreference('view', view);
  if (changed && view === 'today') loadToday();
}

export let todayInFlight = null;
export let todayTimer = null;

export function scheduleTodayReload(delay = 350) {
  clearTimeout(todayTimer);
  todayTimer = setTimeout(loadToday, delay);
}

export function loadToday() {
  if (todayInFlight) return todayInFlight;
  todayInFlight = (async () => {
    let data = null;
    try { data = await apiOptional('/api/today'); } catch { data = null; }
    if (!data) data = await deriveToday();
    state.today = data;
    for (const item of data.items ?? []) {
      state.known.set(item.id, { ...(state.known.get(item.id) ?? {}), ...item });
    }
    setSystemNotices(data.systemNotices ?? []);
    renderToday();
    // Today opens on its first card, so the rail beside it is never blank;
    // after a view switch, a job Today does not list is not left open.
    if (state.view === 'today' && (state.syncDetail || !state.selectedId)) {
      state.syncDetail = false;
      syncDetailToList((data.items ?? []).map((i) => i.id));
    }
  })().finally(() => { todayInFlight = null; });
  return todayInFlight;
}

/** What an older server's todaysPriorities row asks for next. */
export function derivedNextAction(row) {
  switch (row.appStatus) {
    case 'needs_review': return { kind: 'review', label: 'Review resume' };
    case 'approved': return { kind: 'autofill', label: 'Auto-fill' };
    case 'ready_for_submit': return { kind: 'submit', label: 'Record submission' };
    case 'submit_unverified': return { kind: 'submit', label: 'Verify submission' };
    case 'blocked': case 'cancelled': return { kind: 'review', label: 'See what stopped it' };
    case 'shortlisted': return { kind: 'prepare', label: 'Prepare resume' };
    default:
      return row.sponsorshipGated
        ? { kind: 'review', label: 'Check sponsorship' }
        : { kind: 'review', label: 'Review' };
  }
}

export function derivedReason(row) {
  const reasons = {
    needs_review: 'Packet prepared — review the tailored resume before it is used.',
    approved: 'Approved — ready to fill the application.',
    ready_for_submit: 'Filled and waiting for you to press Submit.',
    submit_unverified: 'Submitted automatically, but no confirmation page was seen.',
    blocked: 'Stopped at a step only you can do.',
    cancelled: 'You stopped the fill; it resumes from where it was.',
    shortlisted: 'Shortlisted — needs a tailored resume.',
  };
  if (reasons[row.appStatus]) return reasons[row.appStatus];
  const bits = [row.grade?.label ?? fitLabel(row.fit)];
  if (row.sponsorshipGated) bits.push('sponsorship unconfirmed — verify before applying');
  if (row.postedLast24h) bits.push('posted in the last 24h');
  return bits.filter(Boolean).join(' · ');
}

export const BROWSER_NOTICE = {
  code: 'browser_unavailable',
  severity: 'error',
  message: 'Auto-fill can’t start: the Playwright browser isn’t installed.',
  fix: 'Run `npx playwright install chromium` in the JobAgent folder, then retry.',
};
export const BROWSER_MISSING = /Executable doesn't exist|playwright install/i;

export async function deriveToday() {
  const [sections, failed] = await Promise.all([
    api('/api/sections?only=todaysPriorities').catch(() => null),
    // The one failure worth a notice is a missing browser: every auto-fill
    // fails the same way until it is installed, and the rows say so.
    api('/api/jobs?appStatus=failed&hideClosed=false&limit=50&fields=board').catch(() => null),
  ]);
  const items = (sections?.todaysPriorities ?? [])
    .filter((row) => row.appStatus !== 'failed')
    .slice(0, 10)
    .map((row) => ({ ...row, reason: derivedReason(row), nextAction: derivedNextAction(row) }));
  const browserDown = (failed?.jobs ?? []).some((job) => BROWSER_MISSING.test(job.statusReason ?? ''));
  return { generatedAt: new Date().toISOString(), derived: true, items, systemNotices: browserDown ? [BROWSER_NOTICE] : [] };
}

/* ── system notices ── */

export function setSystemNotices(list) {
  const notices = [...list];
  // The doctor's browser check is a second witness to the same problem.
  const browserCheck = state.health?.checks?.find((c) => c.id === 'browser');
  if (browserCheck?.status === 'fail' && !notices.some((n) => n.code === 'browser_unavailable')) {
    notices.push(BROWSER_NOTICE);
  }
  state.systemNotices = notices;
  const unavailable = notices.some((n) => n.code === 'browser_unavailable');
  // The template notice gates Prepare, so its items are part of what the open
  // job shows: a fixed value must drop out of that box, not wait for a click.
  const templated = JSON.stringify(notices.find((n) => n.code === 'profile_placeholders')?.items ?? null);
  const changed = unavailable !== state.browserUnavailable || templated !== state.templatedItems;
  state.browserUnavailable = unavailable;
  state.templatedItems = templated;
  renderNotices();
  renderSetupChecklist();
  if (changed) {
    // Every Auto-fill control reads this flag; redraw the ones on screen.
    syncSelectionBar();
    if (state.detailJob) renderDetail(state.detailJob);
    renderToday();
  }
}

/** Render a `fix` string, setting `code` spans as code with a Copy button. */
export function fixLine(fix) {
  const line = el('div', { class: 'notice-fix' });
  const parts = String(fix ?? '').split(/`([^`]+)`/);
  parts.forEach((part, i) => { if (part) line.append(i % 2 ? el('code', { text: part }) : part); });
  let command = parts[1];
  // The server may send the fix as a bare command ("npx playwright install
  // chromium") rather than prose with `code` in it: set the whole thing as code.
  if (!command && /^(npx|npm|node|python3?|pip3?|brew)\s/.test(String(fix ?? '').trim())) {
    command = String(fix).trim();
    line.textContent = '';
    line.append('Run ', el('code', { text: command }));
  }
  if (command) {
    line.append(' ', el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'copy-text', 'data-text': command,
      'aria-label': `Copy the command ${command}`, text: 'Copy',
    }));
  }
  return line;
}

export function renderNotices() {
  const host = $('systemNotices');
  host.textContent = '';
  for (const notice of state.systemNotices ?? []) {
    host.append(el('div', { class: `notice ${notice.severity === 'error' ? 'is-error' : 'is-warn'}`, role: 'status' },
      el('span', { class: 'notice-mark', 'aria-hidden': 'true', text: '!' }),
      el('div', { class: 'notice-body' },
        el('b', { text: notice.message }),
        notice.fix ? fixLine(notice.fix) : null,
        notice.items?.length ? placeholderList(notice.items) : null),
      NOTICE_ACTION[notice.code] ? el('div', { class: 'notice-actions' },
        ...NOTICE_ACTION[notice.code].map(([action, label], i) => el('button', {
          type: 'button', class: i === 0 ? 'small primary' : 'small', 'data-action': action, text: label,
        }))) : null));
  }
}

/**
 * The template-text notice while it blocks Prepare, else null.
 *
 * Prepare refuses a profile that still holds template text (preparePacket's
 * placeholder guard). The click used to start a run that failed in the
 * background and left only "Prepared 0 packet(s)", so it looked like nothing
 * happened. Controls read this to stay off and to say what to fix instead.
 */
export function prepareBlockedNotice() {
  return (state.systemNotices ?? []).find((n) => n.code === 'profile_placeholders') ?? null;
}

/** One line per template value: the field, what it still says, and where to fix it. */
export function placeholderList(items = []) {
  const list = el('ul', { class: 'notice-items' });
  for (const item of items) {
    list.append(el('li', {},
      el('b', { text: item.label }),
      ` still says “${item.value}”. Fix it in `,
      el('b', { text: item.where }),
      '.',
      fixLine(item.how)));
  }
  return list;
}

/** Notice code -> the dialog that resolves it. */
export const NOTICE_ACTION = {
  // The resume already states every value the template left behind, so the
  // one-click fix comes first; the editor stays for anything it cannot know.
  profile_placeholders: [['fill-profile-from-resume', 'Fill from my resume'], ['open-profile', 'Edit profile…']],
};

/** Why an Auto-fill control is unavailable, or null when it can be used. */
export function autofillBlockedReason() {
  return state.browserUnavailable
    ? 'Auto-fill can’t start until the Playwright browser is installed — see the notice at the top of the page.'
    : null;
}

/* ── cards ── */

export function renderToday() {
  const list = $('todayList');
  if (!list) return;
  const items = state.today?.items ?? [];
  list.textContent = '';
  const count = $('todayCount');
  count.hidden = items.length === 0;
  count.textContent = String(items.length);
  $('todaySub').textContent = todaySummary(items);

  if (!items.length) {
    list.append(el('li', { class: 'today-empty' },
      el('div', {
        class: 'big',
        text: state.today
          ? (Number(document.body.dataset.people) > 1 && document.body.dataset.person
            ? `Nothing needs ${document.body.dataset.person.split(' ')[0]} right now` : 'Nothing needs you right now')
          : 'Loading…',
      }),
      state.today ? el('p', { class: 'muted' },
        'New strong matches, packets to review and applications waiting on you land here. '
        + 'Run discovery to look for new postings — or, if runs keep finding nothing, widen what your search profile asks for.') : null,
      state.today ? el('div', { class: 'row-gap empty-actions' },
        el('button', { type: 'button', class: 'small primary', 'data-action': 'run', 'data-phase': 'discover', text: 'Find new jobs' }),
        el('button', { type: 'button', class: 'small', 'data-action': 'open-master', text: 'Widen my search…' }),
        el('button', { type: 'button', class: 'small ghost', 'data-action': 'set-view', 'data-view': 'board', text: 'Open the full board' })) : null));
    return;
  }

  const signin = signInStrip(state.today?.signInGroups ?? []);
  if (signin) list.append(el('li', { class: 'today-signin' }, signin));
  // Grouped by the KIND of work, in the order it should be done: finishing
  // an application you started beats deciding on a new match, and both beat
  // housekeeping. The server's order is kept inside each group.
  for (const group of TODAY_GROUPS) {
    const members = items.filter((item) => groupOf(item) === group.key);
    if (!members.length) continue;
    const headingId = `today-g-${group.key}`;
    const inner = el('ol', { class: 'today-group-list', 'aria-labelledby': headingId });
    for (const item of members) inner.append(todayCard(item, group));
    list.append(el('li', { class: `today-group g-${group.key}` },
      el('div', { class: 'today-group-head' },
        el('h3', { id: headingId, text: group.title }),
        el('span', { class: 'today-group-n', text: String(members.length) }),
        el('span', { class: 'today-group-hint muted', text: group.hint })),
      inner));
  }
  const proposals = proposalStrip(state.today?.proposals ?? []);
  if (proposals) list.append(el('li', { class: 'today-signin' }, proposals));
  markCurrentRow(state.selectedId);
}

/**
 * Patterns in what the person turns down (audit Backlog #8): each names its
 * evidence and offers an existing, undoable action or the setting behind it.
 */
export function proposalStrip(proposals = []) {
  if (!proposals.length) return null;
  const list = el('ul', { class: 'signin-list' });
  for (const p of proposals) {
    const attrs = { type: 'button', class: 'small', 'data-action': p.action, text: p.label };
    if (p.ids) attrs['data-ids'] = p.ids.join(',');
    list.append(el('li', { class: 'signin-row' },
      el('span', { class: 'signin-who', title: p.why ?? '' }, p.message),
      el('button', attrs)));
  }
  return el('section', { class: 'signin-strip proposal-strip', 'aria-label': 'Patterns in what you turn down' },
    el('div', { class: 'signin-head' },
      el('h3', { text: 'Patterns in what you turn down' }),
      el('p', { class: 'muted', text: 'From the reasons you gave. Nothing changes unless you choose it, and archiving can be undone.' })),
    list);
}

/** Today's groups, in the order the work should be done. */
export const TODAY_GROUPS = [
  { key: 'finish', title: 'Finish applications', hint: 'Work you started that is waiting on you', primary: true },
  { key: 'followup', title: 'Follow up', hint: 'Reminders you set on applications you submitted', primary: true },
  { key: 'decide', title: 'Decide on matches', hint: 'Strong and possible fits nobody has decided on', primary: false },
  { key: 'aging', title: 'Aging', hint: 'Posted over three weeks ago. Still worth it, or archive?', primary: false },
  { key: 'tidy', title: 'Tidy up', hint: 'Closed postings and leftovers', primary: false },
];

/** Which group a Today item belongs to. */
export function groupOf(item) {
  const kind = item.nextAction?.kind;
  if (kind === 'archive') return 'tidy';
  if (item.aging) return 'aging';
  if (kind === 'followup') return 'followup';
  if (['submit', 'answer', 'approve', 'autofill'].includes(kind)) return 'finish';
  // "review" covers both an unverified submit and a match to decide on.
  if (kind === 'review' && ['submit_unverified', 'blocked', 'failed'].includes(item.appStatus)) return 'finish';
  return 'decide';
}

/** One line under the heading that says what is waiting, by group. */
export function todaySummary(items) {
  if (!items.length) return 'Nothing is waiting on you.';
  if (items.every((i) => groupOf(i) === 'aging' || groupOf(i) === 'tidy')) {
    return `Nothing fresh is waiting on you. ${items.length} older item${items.length === 1 ? '' : 's'} to keep or archive.`;
  }
  const finish = items.filter((i) => groupOf(i) === 'finish').length;
  const follow = items.filter((i) => groupOf(i) === 'followup').length;
  const decide = items.filter((i) => groupOf(i) === 'decide').length;
  const parts = [];
  if (finish) parts.push(`${finish} application${finish === 1 ? '' : 's'} waiting on you`);
  if (follow) parts.push(`${follow} follow-up${follow === 1 ? '' : 's'} due`);
  if (decide) parts.push(`${decide} match${decide === 1 ? '' : 'es'} to decide on`);
  return parts.length ? `${parts.join(' · ')}.` : `${items.length} item${items.length === 1 ? '' : 's'} to tidy up.`;
}

/**
 * Plain signals for a card: what kind of posting this is, beyond its fit.
 * Each says what it means, so nothing is implied by colour alone.
 */
export function todaySignals(item) {
  const out = [];
  const fresh = freshnessOf(item.postedAt);
  if (item.linkState === 'closed') out.push({ tone: 'bad', text: 'Posting closed' });
  else if (fresh?.tone === 'stale') out.push({ tone: 'warn', text: `Posted ${fresh.days}d ago`, title: 'Over a month old. Check the link is still open before spending more time on it.' });
  else if (fresh?.tone === 'fresh' && fresh.days <= 2) out.push({ tone: 'good', text: 'New' });
  if (item.sponsorshipGated) out.push({ tone: 'warn', text: 'Verify sponsorship', title: 'A strong fit held back from automatic preparation until you confirm the employer sponsors.' });
  if (item.appStatus === 'needs_description') out.push({ tone: '', text: 'Description not read' });
  if (item.linkState === 'open') out.push({ tone: 'good', text: 'Link checked', title: 'The employer’s job system still lists this posting.' });
  return out;
}

export function todayCard(item, group = TODAY_GROUPS[0]) {
  const grade = item.grade;
  const card = el('li', { class: `tcard${item.id === state.selectedId ? ' current' : ''}`, 'data-id': item.id });
  card.append(el('span', {
    class: `grade ${grade ? grade.letter : 'none'}`,
    role: 'img',
    'aria-label': grade ? `grade ${grade.letter}, ${grade.label}` : 'not scored yet',
    text: grade ? grade.letter : '—',
  }));

  const main = el('div', { class: 'tcard-main' });
  // The title opens the job in the rail; the one primary button does the work.
  main.append(el('button', {
    type: 'button', class: 'tcard-title', 'data-action': 'today-review', 'data-id': item.id,
    title: 'Open this job’s details',
    text: item.title || 'Title not identified',
  }));
  const meta = el('div', { class: 'tcard-meta' });
  meta.append(el('span', { class: 'co', text: item.company || 'Company on posting' }));
  if (item.location) meta.append(el('span', { class: 'faint', text: ` · ${item.location}` }));
  main.append(meta);
  const chips = el('div', { class: 'tcard-chips' });
  // The server's own label, never re-derived: see verdictLabel.
  chips.append(el('span', {
    class: `chip ${item.fit ?? ''}`.trim(),
    text: [grade?.label ?? fitLabel(item.fit), item.score != null ? String(item.score) : null].filter(Boolean).join(' · '),
  }));
  if (item.statusLabel || item.appStatus) {
    chips.append(el('span', { class: `chip st-${item.appStatus}`, text: item.statusLabel ?? statusLabel(item) }));
  }
  for (const sig of todaySignals(item)) {
    chips.append(el('span', { class: `chip signal ${sig.tone}`.trim(), title: sig.title ?? '', text: sig.text }));
  }
  main.append(chips);
  if (item.reason) main.append(el('p', { class: 'tcard-reason', text: item.reason }));
  card.append(main);

  const next = item.nextAction ?? derivedNextAction(item);
  const attrs = {
    // Filled only where the work is already under way; a decision on a new
    // match is a quieter button, so ten identical blue buttons stop competing.
    type: 'button', class: `small ${group.primary ? 'primary' : ''} tcard-go`.replace(/\s+/g, ' '), 'data-action': 'today-act',
    'data-id': item.id, 'data-kind': next.kind, text: next.label,
  };
  const blocked = next.kind === 'autofill' ? autofillBlockedReason() : null;
  if (blocked) Object.assign(attrs, { disabled: true, title: blocked });
  const act = el('div', { class: 'tcard-act' }, el('button', attrs));
  // A reminder is done by doing it; "Done" records that without opening the job.
  if (next.kind === 'followup') {
    act.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'ws-followup', 'data-op': 'done', 'data-id': item.id, text: 'Done' }));
  }
  // Triage in place: deciding against a match, or retiring an aging one, used
  // to mean opening the job and finding the button in the rail. Both have Undo.
  if (group.key === 'decide' && ['scored', 'discovered', 'shortlisted'].includes(item.appStatus)) {
    act.append(el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'today-decide', 'data-decision': 'rejected', 'data-id': item.id,
      'aria-label': `Not for me: ${item.title ?? 'this job'}`, text: 'Not for me',
    }));
  }
  if (group.key === 'aging') {
    act.append(el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'today-decide', 'data-decision': 'archived', 'data-id': item.id,
      'aria-label': `Archive: ${item.title ?? 'this job'}`, text: 'Archive',
    }));
  }
  card.append(act);
  return card;
}

/** Run a Today card's next action. */
export async function todayAct(target) {
  const id = target.dataset.id;
  switch (target.dataset.kind) {
    case 'prepare': await prepareOne(id); break;
    case 'approve': await simpleAction(id, 'approve', 'Packet approved'); break;
    case 'autofill': await autofillOne(id); break;
    case 'answer': await openProfile(); break;
    case 'submit': openSubmitDialog(id); break;
    case 'fix_setup': await openHealth(); break;
    // A closed posting: archiving is the whole next step (with the usual Undo).
    case 'archive': await decide(id, 'archived'); break;
    case 'followup': await openApplicationDetail(id); break;
    default: await revealInDetail(id);
  }
  scheduleTodayReload(600);
}

/* ─────────────────────── setup checklist ───────────────────────
 * /api/health runs the doctor on demand. Its failing checks were visible only
 * inside System health, so a fresh install with placeholder profile values
 * and no browser looked "fine" until the first Auto-fill failed. Fetched once
 * when the page is idle, and shown as a short checklist on Today, each item
 * linked to the dialog that fixes it.
 */

/** Notice code -> the doctor check that reports the same problem. */
export const NOTICE_CHECK = { browser_unavailable: 'browser', profile_placeholders: 'profile-placeholders' };

/** Check id -> the control that fixes it. */
export const SETUP_FIX = {
  browser: { kind: 'copy' },
  profile: { action: 'open-profile', label: 'Open application profile' },
  'profile-placeholders': { action: 'open-profile', label: 'Open application profile' },
  'profile-active': { action: 'open-master', label: 'Open master resume' },
  resume: { action: 'open-master', label: 'Open master resume' },
};

export async function loadHealthChecks() {
  try { state.health = await api('/api/health'); } catch { return; }
  setSystemNotices(state.today?.systemNotices ?? []);
}

export function renderSetupChecklist() {
  const host = $('setupChecklist');
  if (!host) return;
  host.textContent = '';
  // A check already raised as a system notice is not listed twice.
  const noticed = new Set((state.systemNotices ?? []).map((n) => NOTICE_CHECK[n.code]).filter(Boolean));
  const failing = (state.health?.checks ?? []).filter((c) => c.status === 'fail' && !noticed.has(c.id));
  if (!failing.length) return;
  const card = el('section', { class: 'setup-card', 'aria-labelledby': 'setupTitle' });
  card.append(el('h3', { id: 'setupTitle', text: `Setup checklist — ${failing.length} to fix` }));
  const list = el('ul', { class: 'setup-list' });
  for (const check of failing) {
    const fix = SETUP_FIX[check.id] ?? { action: 'open-health', label: 'See details' };
    const item = el('li', {},
      el('span', { class: 'setup-mark', 'aria-hidden': 'true' }),
      el('div', { class: 'setup-text' },
        el('b', { text: check.label ?? check.id }),
        check.detail ? el('div', { class: 'faint clamp-2', title: check.detail, text: check.detail }) : null,
        fix.kind === 'copy' && check.fix ? fixLine(check.fix) : null));
    if (fix.action) {
      item.append(el('button', { type: 'button', class: 'small', 'data-action': fix.action, text: fix.label }));
    }
    list.append(item);
  }
  card.append(list);
  host.append(card);
}
