/** Multi-select, batch actions, undo toasts with reasons, and Compare. */

import { $, el, toast, withBusy } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { shiftViewCount } from './analytics.js';
import { statusLabel } from './board.js';
import { DECISION_REASONS, reasonLabel, renderDetail, verdictLabel } from './detail.js';
import { confirmAction, openDialog } from './dialogs.js';
import { scheduleRefresh } from './mutations.js';
import { autofillBlockedReason, prepareBlockedNotice } from './today.js';
import { pollRun } from './runs.js';
import { closeMenu } from './menus.js';
import { bulkStepReasons, primaryBulkStep } from './bulk.js';

/* ───────────────────────── selection ───────────────────────── */

export function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  syncSelectionBar();
  syncSelectAll();
}

export function syncSelectAll() {
  const all = state.visible.length > 0 && state.visible.every((id) => state.selected.has(id));
  const some = state.visible.some((id) => state.selected.has(id));
  const box = $('selAll');
  box.checked = all;
  box.indeterminate = !all && some;
}

/** What each bulk step does, shown when it is available. */
const STEP_TITLES = {
  prepare: 'Tailor a resume and build an application packet for each selected job.',
  approve: 'Approve the prepared packets of the selected jobs.',
  autofill: 'Prepare if needed, approve, open each posting, and fill it — always stopping before Submit.',
  compare: 'Compare the selected jobs side by side (up to 4).',
};
const STEP_ACTIONS = {
  prepare: 'batch-prepare', approve: 'batch-approve', autofill: 'batch-autofill', compare: 'compare',
};

let lastAnnounced = 0;

/**
 * Open or close the toolbar without moving the row being worked on.
 *
 * The toolbar takes 44px above the table only while rows are ticked, so
 * opening it pushes every row down. Measured against the row that has focus
 * (the one just ticked) or the first row on screen, the page is scrolled by
 * exactly that shift: the clicked checkbox stays under the pointer. On a phone
 * the bar is fixed, nothing shifts, and this scrolls by 0.
 */
function keepRowStill(change) {
  const rows = $('rows');
  const anchor = document.activeElement?.closest?.('#rows tr.job')
    ?? [...rows.querySelectorAll('tr.job')].find((tr) => tr.getBoundingClientRect().bottom > 0);
  const before = anchor?.getBoundingClientRect().top;
  change();
  if (anchor == null || before == null) return;
  const shift = anchor.getBoundingClientRect().top - before;
  if (shift) window.scrollBy({ top: shift, behavior: 'instant' });
}

export function syncSelectionBar() {
  const n = state.selected.size;
  const bar = $('selbar');
  $('selCount').textContent = `${n} selected`;
  const open = String(n > 0);
  if (bar.dataset.open !== open) keepRowStill(() => { bar.dataset.open = open; });
  if (n === 0) closeMenu($('bulkMenu'));

  const jobs = [...state.selected].map((id) => state.known.get(id)).filter(Boolean);
  const reasons = bulkStepReasons(n, jobs, { running: state.running, blocked: autofillBlockedReason() });
  const primary = primaryBulkStep(jobs, reasons);
  bar.dataset.primary = primary;
  for (const [step, action] of Object.entries(STEP_ACTIONS)) {
    // The bar's button AND its overflow-menu twin, kept in step.
    for (const button of bar.querySelectorAll(`[data-action="${action}"]`)) {
      button.disabled = n === 0 || Boolean(reasons[step]);
      button.title = reasons[step] ?? STEP_TITLES[step];
      if (button.closest('.selbar-pipeline')) button.classList.toggle('primary', step === primary);
    }
  }
  // Disabled buttons cannot be focused, so their reasons are also written
  // where a screen reader reads the toolbar's description.
  const unavailable = Object.values(reasons).filter(Boolean);
  $('selHint').textContent = unavailable.length ? `Unavailable: ${[...new Set(unavailable)].join('. ')}.` : '';

  if (n !== lastAnnounced) {
    $('selAnnounce').textContent = n ? `${n} job${n === 1 ? '' : 's'} selected` : 'Selection cleared';
    lastAnnounced = n;
  }
}

export function clearSelection() {
  state.selected.clear();
  syncSelectionBar();
  for (const box of $('rows').querySelectorAll('input[type=checkbox]')) box.checked = false;
  syncSelectAll();
}

/*
 * Toolbar keys. ←/→ (and Home/End) move between the bar's buttons, as the
 * toolbar role promises; Tab still moves through them too. Escape clears the
 * selection — unless a menu is open, which takes Escape first — and returns
 * focus to select-all, the control that begins a selection.
 */
$('selbar').addEventListener('keydown', (event) => {
  if (event.target.closest('[role="menu"]')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    clearSelection();
    $('selAll').focus();
    return;
  }
  const buttons = [...$('selbar').querySelectorAll('.selbar-inner > button, .selbar-inner > .selbar-group > button, .selbar-inner > .menu > button')]
    .filter((b) => !b.disabled && b.offsetParent !== null);
  const at = buttons.indexOf(document.activeElement);
  if (at === -1) return;
  const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  buttons[(next + buttons.length) % buttons.length].focus();
});

/**
 * Resolve every selected id to a row. Selections survive page/tab changes, so
 * some may not be loaded — fetch those rather than silently treating them as
 * unknown (the old build reported them as "closed or needs a direct link").
 */
export async function selectedJobs(ids = [...state.selected], { fresh = false } = {}) {
  const missing = fresh ? ids : ids.filter((id) => !state.known.has(id));
  if (missing.length) {
    const fetched = await Promise.allSettled(
      missing.map((id) => api(`/api/jobs/${encodeURIComponent(id)}`)),
    );
    for (const result of fetched) {
      if (result.status === 'fulfilled' && result.value?.id) state.known.set(result.value.id, result.value);
    }
  }
  return ids.map((id) => state.known.get(id)).filter(Boolean);
}

/**
 * Auto-fill the ticked jobs, or `ids` when given ("Retry all N at this
 * employer" after signing in once). Same confirmation, same server path; it
 * always stops before the final Submit button.
 */
export async function batchAutofill({ ids = null } = {}) {
  if (autofillBlockedReason()) { toast(autofillBlockedReason(), 'bad'); return; }
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  const jobs = ids ? await selectedJobs(ids, { fresh: true }) : await selectedJobs();
  if (!jobs.length) return;

  const CLOSED = new Set(['submitted', 'rejected', 'archived', 'discarded']);
  const canFill = (job) => !CLOSED.has(job.appStatus)
    && (job.appStatus !== 'blocked' || job.attention?.retryable === true);
  const actionable = jobs.filter(canFill);
  const skipped = jobs.length - actionable.length;

  if (!actionable.length) {
    toast(`All ${jobs.length} selected job(s) are already closed, submitted, or need a direct link.`, 'bad');
    return;
  }

  let message = `Auto-fill ${actionable.length} application(s)?\n`;
  message += '  For each job: tailor a resume packet if needed, approve it, open the posting, and fill '
    + 'every field it can. It always stops before the final Submit button.';
  if (skipped) message += `\n  ${skipped} selected job(s) will be skipped (closed, submitted, or not retryable).`;

  confirmAction(message, async () => {
    try {
      const result = await postJson('/api/assist-batch', { jobIds: actionable.map((j) => j.id) });
      toast(`Auto-filling ${result.queued} job(s), one browser at a time. Always stops before Submit.`);
      pollRun();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

export async function batchPrepare() {
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  if (prepareBlockedNotice()) { toast('Prepare is off until the template values in the notice at the top of the page are replaced.', 'bad'); return; }
  const ids = [...state.selected];
  if (!ids.length) return;
  for (const id of ids) state.prepareFailures.delete(id);
  try {
    const result = await postJson('/api/prepare-batch', { jobIds: ids });
    toast(`Preparing ${result.queued} packet(s)…`);
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

export async function batchApprove() {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const result = await postJson('/api/approve-batch', { jobIds: ids });
    const moved = result.approved.filter((id) => state.known.get(id)?.appStatus === 'needs_review').length;
    shiftViewCount('needs_review', 'ready_apply', moved);
    const failed = result.failed.length;
    toast(`Approved ${result.approved.length}${failed ? `, ${failed} skipped (no packet yet)` : ''}`,
      failed ? '' : 'good');
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

/**
 * Bulk shortlist / reject / archive, with a way back.
 *
 * Rejecting forty jobs is one click and, until now, had no recovery path at
 * all: the previous decision was overwritten and the selection was cleared in
 * the same breath, so a mis-click cost a manual pass through forty rows. Each
 * job's OWN prior decision is captured first — a single "clear" would not undo
 * this, because the selection routinely mixes already-shortlisted rows with
 * untouched ones, and clearing would silently discard the shortlist too.
 */
export async function batchDecide(decision, { ids = [...state.selected] } = {}) {
  if (!ids.length) return;
  // Read the prior state BEFORE the write, from the rows already in memory.
  const before = new Map(ids.map((id) => [id, state.known.get(id)?.userDecision ?? 'clear']));
  try {
    const result = await postJson('/api/decide-batch', { jobIds: ids, decision });
    clearSelection();
    scheduleRefresh(0);
    const done = new Set(result.updated);
    const closes = decision === 'rejected' || decision === 'archived';
    offerUndo(decision === 'clear'
      ? `Cleared the decision on ${result.updated.length} job(s)`
      : `Marked ${result.updated.length} as ${decision}`,
      new Map([...before].filter(([id]) => done.has(id))),
      closes ? { reasonFor: { jobIds: [...done], decision } } : {});
  } catch (err) { toast(err.message, 'bad'); }
}

/**
 * A toast that carries an Undo button for `wasDecision` (job id -> prior value).
 *
 * Undo asks the server to reverse each job's latest decision, so the restored
 * value and reason come from the event log, not from what this page loaded.
 */
export function offerUndo(message, wasDecision, { reasonFor = null } = {}) {
  if (!wasDecision.size) { toast(message, 'good'); return; }
  const node = el('div', { class: 'toast good undo-toast', role: 'group', 'aria-label': message },
    el('span', { class: 'undo-msg', text: message }));
  const button = el('button', { class: 'small', type: 'button', text: '↩ Undo' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      // The server restores each job's previous decision AND its reason from
      // the job's own event log. Restoring from the rows loaded in this page
      // turned an unloaded "shortlisted" into "cleared".
      for (const id of wasDecision.keys()) {
        await postJson(`/api/jobs/${encodeURIComponent(id)}/undo-decision`, {});
      }
      node.remove();
      toast(`Restored ${wasDecision.size} job(s)`, 'good');
      scheduleRefresh(0);
    } catch (err) {
      button.disabled = false;
      toast(`Could not undo: ${err.message}`, 'bad');
    }
  });
  node.append(button);
  if (reasonFor) node.append(reasonChips(reasonFor, node));
  $('toasts').append(node);
  // Longer than an ordinary toast: an undo you cannot reach is not an undo.
  // And never while the pointer or focus is on it — choosing a reason, or
  // reaching Undo by keyboard, must not race a timer.
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => node.remove(), 12000); };
  const hold = () => clearTimeout(timer);
  node.addEventListener('pointerenter', hold);
  node.addEventListener('pointerleave', () => { if (!node.contains(document.activeElement)) arm(); });
  node.addEventListener('focusin', hold);
  node.addEventListener('focusout', (event) => { if (!node.contains(event.relatedTarget)) arm(); });
  arm();
}

/**
 * "Why?" — optional, one click. Recorded as `reason` on the same decision
 * (the server treats a repeated decision as idempotent), so skipping it costs
 * nothing and choosing one never changes what was decided.
 */
export const reasonHandlers = new WeakMap();

export function reasonChips({ jobIds, decision }, toastNode) {
  const row = el('div', { class: 'reason-row', role: 'group', 'aria-label': 'Why? (optional)' },
    el('span', { class: 'faint', text: 'Why?' }));
  const send = async (reason, reasonNote) => {
    const body = { decision, reason, ...(reasonNote ? { reasonNote } : {}) };
    if (jobIds.length === 1) await postJson(`/api/jobs/${encodeURIComponent(jobIds[0])}/decision`, body);
    else await postJson('/api/decide-batch', { jobIds, ...body });
    for (const id of jobIds) {
      const known = state.known.get(id);
      if (known) known.decisionReason = reason;
      if (state.detailJob?.id === id) { state.detailJob.decisionReason = reason; renderDetail(state.detailJob); }
    }
    row.replaceChildren(el('span', { class: 'faint', text: `Reason saved: ${reasonLabel(reason)}` }));
  };
  for (const [key, label] of DECISION_REASONS) {
    row.append(el('button', {
      type: 'button', class: 'chipbtn', 'data-action': 'decision-reason', 'data-reason': key, text: label,
    }));
  }
  reasonHandlers.set(row, async (reason) => {
    if (reason !== 'other') { await send(reason); return; }
    // "Other" asks for a word or two rather than recording an empty category.
    const input = el('input', { type: 'text', class: 'reason-note', 'aria-label': 'Reason', placeholder: 'A few words…', maxlength: '200' });
    const save = el('button', { type: 'submit', class: 'small', text: 'Save' });
    const form = el('form', { class: 'reason-form' }, input, save);
    form.addEventListener('submit', (submit) => {
      submit.preventDefault();
      withBusy(save, () => send('other', input.value.trim()).catch((err) => toast(err.message, 'bad')));
    });
    row.replaceChildren(form);
    input.focus();
  });
  toastNode.dataset.reasons = 'true';
  return row;
}

export async function showCompare() {
  const jobs = (await selectedJobs()).slice(0, 4);
  if (jobs.length < 2) { toast('Select 2–4 jobs to compare', 'bad'); return; }
  const full = await Promise.all(jobs.map((j) => api(`/api/jobs/${encodeURIComponent(j.id)}`)));

  const body = $('compareBody');
  body.textContent = '';
  const table = el('table', { class: 'minitable' });
  const rows = [
    ['Company', (j) => j.company],
    ['Role', (j) => j.title],
    ['Score', (j) => `${j.score ?? '—'} (${verdictLabel(j)})`],
    ['Grade', (j) => j.grade?.letter ?? '—'],
    ['Sponsorship', (j) => j.sponsorship ?? '—'],
    ['Posted', (j) => j.postedLabel],
    ['Location', (j) => j.location ?? '—'],
    ['Type', (j) => j.employmentLabel ?? '—'],
    ['Source / ATS', (j) => `${j.source} / ${j.atsPlatform ?? '—'}`],
    ['Status', (j) => statusLabel(j)],
    ['ATS match', (j) => (j.atsScore != null ? `${j.atsScore}%` : '—')],
    ['Matched skills', (j) => (j.matchedKeywords ?? []).slice(0, 10).join(', ') || '—'],
    ['Missing', (j) => (j.missingKeywords ?? []).slice(0, 8).join(', ') || '—'],
  ];
  for (const [label, get] of rows) {
    const tr = el('tr', {}, el('th', { scope: 'row', text: label }));
    for (const job of full) tr.append(el('td', { text: String(get(job) ?? '—') }));
    table.append(tr);
  }
  body.append(table);
  openDialog($('dlgCompare'));
}
