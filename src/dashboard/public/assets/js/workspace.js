/** The Applications workspace: a board of application stages, outcomes, follow-ups and the numbers behind them. */

import { $, el, fmt, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { cssEscape, loadDetail, revealInDetail, selectJob, syncDetailToList } from './detail.js';
import { autofillOne, scheduleRefresh } from './mutations.js';
import { openSubmitDialog } from './actions.js';
import { autofillBlockedReason, scheduleTodayReload } from './today.js';
import { savePreference } from './main.js';
import { signInStrip } from './signin.js';

/* ───────────────────────── Applications workspace ─────────────────────────
 * One column per stage, in the order an application moves: the three the
 * automation drives (review, ready, needs you), then the four recruiting
 * outcomes the user records once it is submitted.
 *
 * A DRAG IS A REQUEST, NEVER AN AUTHORIZATION. Dropping a card on an outcome
 * column posts that outcome, and the server checks it against the outcome
 * graph. Dropping an unsubmitted card on "Applied" opens the same "I submitted
 * it myself" dialog as everywhere else; nothing is approved, filled or
 * submitted by moving a card. Every move also has a keyboard/touch path: the
 * card's "Move" menu.
 */

/** Outcome-phase columns a drop records directly. "Closed" asks which kind. */
const STAGE_OUTCOME = { interviewing: 'interviewing', offer: 'offer' };
const CLOSING_OUTCOMES = ['hired', 'rejected', 'withdrawn'];
const OUTCOME_WORDS = {
  interviewing: 'Interviewing', offer: 'Offer received', hired: 'Hired',
  rejected: 'Rejected by employer', withdrawn: 'Withdrawn',
};

/** Shown in an empty column, so it says how a card gets there. */
const EMPTY_HINT = {
  review: 'Prepared resumes wait here for you to read.',
  ready: 'Approved applications wait here for auto-fill or your Submit.',
  attention: 'Nothing is stuck.',
  applied: 'Record a submission and it lands here.',
  interviewing: 'Move an application here when you hear back.',
  offer: 'Offers you receive.',
  closed: 'Hired, rejected or withdrawn.',
};

/**
 * The layout the Applications view shows: the saved choice ('kanban' by
 * default, or the stage-tab 'list'), except that a deep link onto one stage
 * shows the list it was counted from.
 */
export function appsLayout() {
  return state.appsLayout === 'list' || state.appsDeepLink ? 'list' : 'kanban';
}

/** Show the board or the list in the Applications view. */
export function applyAppsLayout({ load = true } = {}) {
  const inApps = state.view === 'applications';
  const kanban = inApps && appsLayout() === 'kanban';
  $('boardView').dataset.layout = kanban ? 'kanban' : 'list';
  // Applications read every search, so the role-search banner does not apply.
  $('boardView').dataset.view = inApps ? 'applications' : 'board';
  $('workspace').hidden = !kanban;
  $('appsLayout').hidden = !inApps;
  for (const button of $('appsLayout').querySelectorAll('[data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === appsLayout()));
  }
  if (kanban && load) loadWorkspace();
}

export function setAppsLayout(layout) {
  state.appsDeepLink = false;
  state.appsLayout = layout === 'list' ? 'list' : 'kanban';
  savePreference('appsLayout', state.appsLayout);
  applyAppsLayout();
}

let workspaceInFlight = null;
let workspaceTimer = null;

/** Reload the workspace soon, when it is on screen. */
export function scheduleWorkspaceReload(delay = 300) {
  if (state.view !== 'applications' || appsLayout() !== 'kanban') return;
  clearTimeout(workspaceTimer);
  workspaceTimer = setTimeout(loadWorkspace, delay);
}

export function loadWorkspace() {
  if (workspaceInFlight) return workspaceInFlight;
  if (!state.workspace) renderWorkspaceSkeleton();
  workspaceInFlight = (async () => {
    try {
      state.workspace = await api('/api/applications');
    } catch (err) {
      $('wsBoard').textContent = '';
      $('wsBoard').append(el('div', { class: 'ws-error panel empty', text: `Could not load applications: ${err.message}` }));
      return;
    }
    for (const item of state.workspace.items ?? []) {
      state.known.set(item.id, { ...(state.known.get(item.id) ?? {}), ...item });
    }
    renderWorkspace();
    if (state.syncDetail && state.view === 'applications') {
      state.syncDetail = false;
      syncDetailToList((state.workspace.items ?? []).map((i) => i.id));
    }
  })().finally(() => { workspaceInFlight = null; });
  return workspaceInFlight;
}

function renderWorkspaceSkeleton() {
  const board = $('wsBoard');
  board.textContent = '';
  const cols = el('div', { class: 'ws-cols', 'aria-hidden': 'true' });
  for (let i = 0; i < 4; i += 1) cols.append(el('div', { class: 'ws-col' }, el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })));
  board.append(el('div', { class: 'ws-band' }, cols));
}

/* ── rendering ── */

export function renderWorkspace() {
  const data = state.workspace;
  if (!data) return;
  renderMetrics(data.metrics, data.weekly);
  renderConversion(data.conversion, data.metrics);
  const board = $('wsBoard');
  const focusedId = document.activeElement?.closest?.('.ws-card')?.dataset.id;
  board.textContent = '';
  if (!data.items.length) {
    board.append(el('div', { class: 'ws-empty' },
      el('h3', { text: 'No applications yet' }),
      el('p', { class: 'muted', text: 'When you prepare a tailored resume for a job, or record one you submitted yourself, '
        + 'it appears here and moves across as you hear back.' }),
      el('button', { type: 'button', class: 'small primary', 'data-action': 'set-view', 'data-view': 'board', text: 'Find a job to apply to' })));
    return;
  }
  const signin = signInStrip(data.signInGroups ?? []);
  if (signin) board.append(signin);
  // Two bands, one per phase, so all seven stages fit a laptop screen
  // without sideways scrolling; a wide screen lays them out as one row (CSS).
  for (const phase of ['prepare', 'outcome']) {
    const stages = data.stages.filter((stage) => stage.phase === phase);
    const bandId = `ws-band-${phase}`;
    const band = el('section', { class: `ws-band band-${phase}`, 'aria-labelledby': bandId },
      el('h3', { class: 'ws-phase', id: bandId, text: phase === 'prepare' ? 'Before you apply' : 'After you apply' }));
    const cols = el('div', { class: 'ws-cols' });
    for (const stage of stages) {
      const items = data.items.filter((item) => item.stage === stage.key);
      const headingId = `ws-h-${stage.key}`;
      const col = el('section', { class: 'ws-col', 'data-stage': stage.key, 'data-phase': stage.phase, 'aria-labelledby': headingId });
      col.append(el('header', { class: 'ws-col-head', title: stage.hint },
        el('h4', { id: headingId, text: stage.label }),
        el('span', { class: 'ws-count', 'aria-label': `${items.length} application${items.length === 1 ? '' : 's'}`, text: String(items.length) })));
      const list = el('ol', { class: 'ws-list', 'aria-labelledby': headingId });
      for (const item of items) list.append(workspaceCard(item));
      if (!items.length) list.append(el('li', { class: 'ws-col-empty', text: EMPTY_HINT[stage.key] ?? '' }));
      col.append(list);
      cols.append(col);
    }
    band.append(cols);
    board.append(band);
  }
  if (focusedId) board.querySelector(`.ws-card[data-id="${cssEscape(focusedId)}"] .ws-card-title`)?.focus();
  markWorkspaceCurrent(state.selectedId);
}

/** Highlight the card whose detail is open. */
export function markWorkspaceCurrent(id) {
  for (const card of $('wsBoard')?.querySelectorAll('.ws-card.current') ?? []) card.classList.remove('current');
  if (id) $('wsBoard')?.querySelector(`.ws-card[data-id="${cssEscape(id)}"]`)?.classList.add('current');
}

function metric(value, label, { tone = '', title = '' } = {}) {
  return el('div', { class: `ws-metric ${tone}`.trim(), title },
    el('b', { text: fmt(value) }), el('span', { text: label }));
}

/** "33%" with the counts that qualify it, or a plain dash when there is nothing to divide by. */
function rateText({ n, of, pct }, of_) {
  return pct == null ? `— (no ${of_} yet)` : `${pct}% (${n} of ${of})`;
}

const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Response words for the weekly line, in process order. */
const RESPONSE_WORDS = [
  ['interviewing', 'interview'], ['offer', 'offer'], ['hired', 'hire'],
  ['rejected', 'rejection'], ['withdrawn', 'withdrawal'],
];

/**
 * The week in one sentence: "This week: 2 submitted · 1 interview · 1 follow-up
 * done. Next 7 days: 2 follow-ups due." Only what happened is named; a week
 * with nothing recorded says so instead of listing zeros.
 */
export function weeklyText(w) {
  if (!w) return '';
  const done = [];
  if (w.submitted) done.push(`${fmt(w.submitted)} submitted`);
  for (const [key, word] of RESPONSE_WORDS) if (w.responses?.[key]) done.push(plural(w.responses[key], word));
  if (w.followUpsDone) done.push(`${plural(w.followUpsDone, 'follow-up')} done`);
  const ahead = [];
  if (w.followUpsOverdue) ahead.push(`${plural(w.followUpsOverdue, 'follow-up')} overdue`);
  if (w.followUpsDueSoon) ahead.push(`${plural(w.followUpsDueSoon, 'follow-up')} due in the next 7 days`);
  const first = done.length ? `This week: ${done.join(' · ')}.` : 'Nothing recorded this week yet.';
  return ahead.length ? `${first} Coming up: ${ahead.join(' · ')}.` : first;
}

export function renderMetrics(m, weekly = null) {
  const host = $('wsMetrics');
  host.textContent = '';
  if (!m) return;
  // Before any submission the tiles are five zeros and the rates are dashes:
  // say what fills them instead.
  if (!m.submitted) {
    host.append(el('p', { class: 'ws-hint muted', text: 'Your numbers appear here once you record a submission: '
      + 'interviews, offers and response rates, from what you record.' }));
    return;
  }
  if (weekly) host.append(el('p', { class: 'ws-week', text: weeklyText(weekly) }));
  host.append(
    metric(m.submitted, 'Submitted', { title: 'Applications recorded as submitted' }),
    metric(m.awaiting, 'Awaiting reply', { tone: m.awaiting ? 'warn' : '', title: 'Submitted 14 or more days ago with no response recorded' }),
    metric(m.interviews, 'Interviews', { title: 'Applications that reached an interview, including ones that ended later' }),
    metric(m.offers, 'Offers', { tone: m.offers ? 'good' : '', title: 'Applications that reached an offer' }),
    metric(m.followUpsDue, 'Follow-ups due', { tone: m.followUpsDue ? 'accent' : '', title: 'Reminders you set that are due today or earlier' }),
  );
  host.append(el('p', { class: 'ws-rates muted' },
    el('span', { text: `Interview rate ${rateText(m.rates.interview, 'submissions')}` }),
    el('span', { 'aria-hidden': 'true', text: ' · ' }),
    el('span', { text: `Offer rate ${rateText(m.rates.offer, 'interviews')}` }),
    el('span', { class: 'ws-rates-note', text: ' · from outcomes you recorded' })));
}

const DIM_LABELS = { source: 'Where you found it', ats: 'Application system', scoreBand: 'Fit score', tier: 'Tier', applySpeed: 'Applied after posting' };

/** One conversion cell, in words: "2 of 9 (22%)" or "3 sent; too few to tell". Pure. */
export function conversionText(cell, minCell = 5) {
  if (cell.tooFew) return `${cell.submitted} sent; too few to tell (needs ${minCell})`;
  return `${cell.interviews} of ${cell.submitted} reached an interview (${cell.interviewRate}%)`;
}

/** "What gets interviews" (P2-9), under the numbers, once anything was submitted. */
export function renderConversion(conversion, metrics) {
  const host = $('wsMetrics');
  if (!host || !conversion || !metrics?.submitted) return;
  const details = el('details', { class: 'ws-conversion', 'data-key': 'ws-conversion' });
  details.append(el('summary', { text: 'What gets interviews' }));
  details.append(el('p', { class: 'faint', text: 'From the outcomes you recorded. A group with fewer than '
    + `${conversion.minCell} applications shows no percentage, so one lucky reply never looks like a pattern.` }));
  for (const [dim, label] of Object.entries(DIM_LABELS)) {
    const rows = conversion[dim] ?? [];
    if (!rows.length) continue;
    const table = el('table', { class: 'mini ws-conv-table' });
    table.append(el('caption', { text: label }));
    const body = el('tbody');
    for (const cell of rows) {
      body.append(el('tr', {}, el('th', { scope: 'row', text: cell.key }), el('td', { text: conversionText(cell, conversion.minCell) })));
    }
    table.append(body);
    details.append(table);
  }
  host.append(details);
}

const shortDay = (day) => {
  if (!day) return '';
  const at = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** Chips that say where the card stands, in words. */
export function cardSignals(item) {
  const out = [];
  if (item.stage === 'review' || item.stage === 'ready' || item.stage === 'attention') {
    // "Review resume" under "To review" says nothing; the other two columns
    // each hold more than one status, so theirs is worth a chip.
    if (item.stage !== 'review') out.push({ tone: item.stage === 'attention' ? 'warn' : '', text: item.statusLabel });
    if (item.sponsorshipGated) out.push({ tone: 'warn', text: 'Verify sponsorship' });
    if (item.linkState === 'closed') out.push({ tone: 'bad', text: 'Posting closed' });
  } else if (item.stage === 'applied') {
    if (item.appliedOn) out.push({ tone: '', text: `Applied ${shortDay(item.appliedOn)}` });
    if ((item.awaitingDays ?? 0) >= 14) {
      out.push({ tone: 'warn', text: `No reply · ${item.awaitingDays}d`, title: 'Submitted 14 or more days ago and no response recorded. Consider a follow-up.' });
    }
  } else if (item.outcome) {
    const tone = item.outcome.outcome === 'hired' || item.outcome.outcome === 'offer' ? 'good'
      : item.outcome.outcome === 'rejected' ? 'bad' : '';
    out.push({ tone, text: item.outcome.on ? `${item.outcome.label} · ${shortDay(item.outcome.on)}` : item.outcome.label });
  }
  if (item.followUp) {
    const f = item.followUp;
    out.push(f.due
      ? { tone: 'accent', text: f.daysLate ? `Follow-up ${f.daysLate}d overdue` : 'Follow up today' }
      : { tone: '', text: `Follow up ${shortDay(f.dueOn)}` });
  }
  return out;
}

/** Columns this card may be dropped on, with what the drop does. */
export function dropTargets(item) {
  const targets = {};
  if (item.appStatus !== 'submitted') {
    // The one human record of a submission; opens its dialog, never marks it.
    targets.applied = 'submit';
    return targets;
  }
  const allowed = new Set(item.allowedOutcomes ?? []);
  for (const [stage, outcome] of Object.entries(STAGE_OUTCOME)) if (allowed.has(outcome)) targets[stage] = 'outcome';
  if (CLOSING_OUTCOMES.some((o) => allowed.has(o))) targets.closed = 'choose';
  return targets;
}

export function workspaceCard(item) {
  const card = el('li', {
    class: `ws-card stage-${item.stage}${item.id === state.selectedId ? ' current' : ''}${item.followUp?.due ? ' is-due' : ''}`,
    'data-id': item.id, 'data-action': 'ws-open',
  });
  card.draggable = Object.keys(dropTargets(item)).length > 0;

  const top = el('div', { class: 'ws-card-top' },
    el('span', { class: 'ws-company', text: item.company ?? 'Unknown employer' }));
  if (item.sameCompany) {
    top.append(el('span', {
      class: 'ws-same', title: `${item.sameCompany} other application${item.sameCompany === 1 ? '' : 's'} at this employer, each tracked separately`,
      text: `+${item.sameCompany}`,
    }));
  }
  if (item.grade?.letter) top.append(el('span', { class: `grade ${item.grade.letter}`, title: item.grade.label, text: item.grade.letter }));
  card.append(top);
  // The title is the card's keyboard target: a real button, so the card can
  // hold its own action buttons without nesting interactive elements.
  card.append(el('button', {
    type: 'button', class: 'ws-card-title', 'data-action': 'ws-open', 'data-id': item.id,
    'aria-describedby': `ws-sig-${item.id}`, text: item.title,
  }));
  const chips = el('div', { class: 'ws-chips', id: `ws-sig-${item.id}` });
  for (const sig of cardSignals(item)) {
    chips.append(el('span', { class: `chip signal ${sig.tone}`.trim(), title: sig.title ?? '', text: sig.text }));
  }
  card.append(chips);

  const foot = el('div', { class: 'ws-card-foot' });
  const next = item.nextAction;
  if (next) {
    const attrs = {
      type: 'button', class: `small ${item.stage === 'attention' || next.kind === 'followup' ? 'primary' : ''} ws-go`.replace(/\s+/g, ' '),
      'data-action': 'ws-act', 'data-id': item.id, 'data-kind': next.kind, text: next.label,
    };
    const blocked = next.kind === 'autofill' ? autofillBlockedReason() : null;
    if (blocked) Object.assign(attrs, { disabled: true, title: blocked });
    foot.append(el('button', attrs));
  }
  if (item.appStatus === 'submitted' && (item.allowedOutcomes?.length || item.canUndoOutcome)) {
    foot.append(el('button', {
      type: 'button', class: 'small ghost ws-move', 'data-action': 'ws-move-menu', 'data-id': item.id,
      // A closed card can only be corrected (Undo), not moved on.
      // Name starts with the visible word (WCAG 2.5.3, label in name).
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-label': `${item.allowedOutcomes?.length ? 'Move' : 'Change'}: update the status of ${item.title}`,
      text: item.allowedOutcomes?.length ? 'Move' : 'Change',
    }));
  }
  if (foot.children.length) card.append(foot);
  return card;
}

/* ── moves ── */

const itemById = (id) => state.workspace?.items?.find((item) => item.id === id) ?? null;

/** Record an outcome; on success, offer the undo the server supports. */
export async function recordOutcome(id, outcome, { on = null, note = null } = {}) {
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/outcome`, { outcome, on, note });
    announce(`${result.title}: ${OUTCOME_WORDS[outcome] ?? outcome}`);
    undoToast(`Marked “${OUTCOME_WORDS[outcome] ?? outcome}”`, id);
    afterWorkspaceChange(id);
    return result;
  } catch (err) {
    toast(err.message, 'bad');
    return null;
  }
}

export async function undoLastOutcome(id) {
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/undo-outcome`, {});
    toast(`Back to “${result.outcome?.label ?? 'Awaiting response'}”`, 'good');
    afterWorkspaceChange(id);
  } catch (err) { toast(err.message, 'bad'); }
}

export async function followUp(id, action, { dueOn = null, note = null } = {}) {
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/follow-up`, { action, dueOn, note });
    toast(action === 'set' ? `Follow-up set for ${shortDay(dueOn)}`
      : action === 'done' ? 'Follow-up marked done' : 'Follow-up dismissed', 'good');
    afterWorkspaceChange(id);
    return result;
  } catch (err) {
    toast(err.message, 'bad');
    return null;
  }
}

function afterWorkspaceChange(id) {
  scheduleWorkspaceReload(0);
  scheduleTodayReload(200);
  scheduleRefresh(400);
  if (state.selectedId === id) loadDetail(id);
}

function undoToast(message, id) {
  const node = el('div', { class: 'toast good undo-toast', role: 'group', 'aria-label': message },
    el('span', { class: 'undo-msg', text: message }));
  const button = el('button', { class: 'small', type: 'button', text: '↩ Undo' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    await undoLastOutcome(id);
    node.remove();
  });
  node.append(button);
  $('toasts').append(node);
  setTimeout(() => node.remove(), 6000);
}

function announce(text) {
  const live = $('wsAnnounce');
  if (live) live.textContent = text;
}

/** Run a card's next action. */
export async function workspaceAct(target) {
  const id = target.dataset.id;
  switch (target.dataset.kind) {
    case 'autofill': await autofillOne(id); scheduleWorkspaceReload(600); break;
    case 'submit': openSubmitDialog(id); break;
    case 'outcome': openMoveMenu(target); break;
    case 'followup': await openApplicationDetail(id); break;
    // "See what stopped it", "Check the error", "Confirm it went through",
    // "Review resume": open the job at the part the button names.
    default: await revealInDetail(id);
  }
}

/** Open a job's detail and bring its Application section into view. */
export async function openApplicationDetail(id) {
  await selectJob(id, { user: true });
  const section = $('detail')?.querySelector('[data-section="application"]');
  section?.scrollIntoView({ block: 'nearest' });
  section?.querySelector('button, input, select')?.focus({ preventScroll: true });
}

/* ── the Move menu: the keyboard and touch path for every drag ── */

let openMenu = null;

export function closeMoveMenu({ returnFocus = false } = {}) {
  if (!openMenu) return;
  const { node, trigger } = openMenu;
  node.remove();
  trigger?.setAttribute('aria-expanded', 'false');
  openMenu = null;
  if (returnFocus) trigger?.focus();
}

/**
 * A small menu of the outcomes this application may move to, anchored to the
 * trigger. `only` narrows it (a drop on "Closed" asks which kind of closed).
 */
export function openMoveMenu(trigger, { only = null } = {}) {
  const id = trigger.dataset.id;
  const item = itemById(id);
  if (!item) return;
  const wasOpen = openMenu?.trigger === trigger;
  closeMoveMenu();
  if (wasOpen) return;
  const options = (item.allowedOutcomes ?? []).filter((o) => !only || only.includes(o));
  const menu = el('div', { class: 'ws-menu', role: 'menu', 'aria-label': `Update ${item.title}` });
  menu.append(el('div', { class: 'menu-label', role: 'presentation', text: only ? 'Closed as' : 'Mark as' }));
  for (const outcome of options) {
    menu.append(el('button', {
      type: 'button', role: 'menuitem', class: `ws-menu-item o-${outcome}`,
      'data-action': 'ws-record', 'data-id': id, 'data-outcome': outcome, text: OUTCOME_WORDS[outcome],
    }));
  }
  if (!only && item.canUndoOutcome) {
    menu.append(el('hr', { role: 'separator' }));
    menu.append(el('button', {
      type: 'button', role: 'menuitem', 'data-action': 'ws-undo-outcome', 'data-id': id,
      text: `Undo “${item.outcome?.label ?? 'last outcome'}”`,
    }));
  }
  if (!only) {
    menu.append(el('hr', { role: 'separator' }));
    menu.append(el('button', { type: 'button', role: 'menuitem', 'data-action': 'ws-open-application', 'data-id': id, text: 'Add a date, note or follow-up…' }));
  }
  const card = trigger.closest('.ws-card') ?? trigger;
  card.append(menu);
  trigger.setAttribute('aria-expanded', 'true');
  openMenu = { node: menu, trigger };
  menu.querySelector('[role="menuitem"]')?.focus();
}

document.addEventListener('keydown', (event) => {
  if (!openMenu) return;
  if (event.key === 'Escape') { event.preventDefault(); closeMoveMenu({ returnFocus: true }); return; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...openMenu.node.querySelectorAll('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement);
  if (at < 0) return;
  event.preventDefault();
  items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});
document.addEventListener('click', (event) => {
  if (openMenu && !openMenu.node.contains(event.target) && event.target !== openMenu.trigger) closeMoveMenu();
}, true);

/* ── drag and drop (pointer users; the Move menu covers keyboard and touch) ── */

let dragging = null;

/** Why a column refuses this card, shown on hover while dragging. */
const REFUSED = {
  prepare: 'These stages follow the resume review and auto-fill steps. Open the job to continue.',
  outcome: 'Outcomes only move forward. Use Undo in the Move menu to correct one.',
};

function clearDropMarks() {
  for (const col of $('wsBoard').querySelectorAll('.ws-col[data-drop]')) {
    delete col.dataset.drop;
    col.classList.remove('drop-over');
    col.removeAttribute('title');
  }
}

export function installWorkspaceDrag() {
  const board = $('wsBoard');
  board.addEventListener('dragstart', (event) => {
    const card = event.target.closest?.('.ws-card');
    const item = card && itemById(card.dataset.id);
    if (!item) return;
    closeMoveMenu();
    const targets = dropTargets(item);
    dragging = { id: item.id, from: item.stage, targets, card };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    card.classList.add('dragging');
    for (const col of board.querySelectorAll('.ws-col')) {
      if (col.dataset.stage === item.stage) continue;
      col.dataset.drop = targets[col.dataset.stage] ? 'ok' : 'no';
      if (col.dataset.drop === 'no') col.title = REFUSED[col.dataset.phase];
    }
  });
  board.addEventListener('dragend', () => {
    dragging?.card.classList.remove('dragging');
    dragging = null;
    clearDropMarks();
  });
  board.addEventListener('dragover', (event) => {
    const col = event.target.closest?.('.ws-col');
    if (!dragging || !col) return;
    const ok = col.dataset.drop === 'ok';
    if (ok) event.preventDefault();
    event.dataTransfer.dropEffect = ok ? 'move' : 'none';
    for (const other of board.querySelectorAll('.ws-col.drop-over')) if (other !== col) other.classList.remove('drop-over');
    col.classList.toggle('drop-over', ok);
  });
  board.addEventListener('drop', (event) => {
    const col = event.target.closest?.('.ws-col');
    if (!dragging || !col) return;
    event.preventDefault();
    const { id, targets, card } = dragging;
    const stage = col.dataset.stage;
    const what = targets[stage];
    clearDropMarks();
    if (!what) return;
    if (what === 'submit') { openSubmitDialog(id); return; }
    if (what === 'choose') {
      const trigger = card.querySelector('.ws-move') ?? card.querySelector('.ws-card-title');
      trigger.dataset.id = id;
      openMoveMenu(trigger, { only: CLOSING_OUTCOMES });
      return;
    }
    recordOutcome(id, STAGE_OUTCOME[stage]);
  });
}
