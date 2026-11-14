/** Writes and what they refresh: decisions, single-job actions, runs, link checks. */

import { $, toast } from './dom.js';
import { state } from './state.js';
import { postJson } from './api.js';
import { loadSections, loadStats, shiftViewCount } from './analytics.js';
import { captureRowFocus, loadBoard, restoreRowFocus, rowFor, scheduleBoardReload } from './board.js';
import { cssEscape, isAggregatorUrl, loadDetail, renderDetail, selectJob } from './detail.js';
import { autofillBlockedReason, loadToday, prepareBlockedNotice, scheduleTodayReload } from './today.js';
import { offerUndo } from './selection.js';
import { pollRun } from './runs.js';
import { loadWorkspace, scheduleWorkspaceReload } from './workspace.js';

/* ───────────────────── mutations + refresh ───────────────────── */

export let refreshTimer = null;

/**
 * After a mutation: the board page, and the numbers when the throttle allows.
 *
 * This used to be a full `refreshAll` — stats, board, sections, profile and
 * the detail again — after every click: seven requests for one decision, one
 * of them a ~6s whole-corpus read. The row and the rail are patched from the
 * mutation's own response; the board page is reloaded to pick up anything that
 * moved in or out of the current filter.
 */
export function scheduleRefresh(delay = 350) {
  scheduleBoardReload(delay);
  loadStats();
  if (state.view === 'today') scheduleTodayReload(delay);
  scheduleWorkspaceReload(delay);
}

/**
 * Everything, e.g. at boot, after a run, or on a long-idle tab.
 * @param {{ force?: boolean }} [options] bypass the stats throttle
 */
export async function refreshAll({ force = false } = {}) {
  clearTimeout(refreshTimer);
  await Promise.allSettled([loadStats({ force }), loadBoard(), loadToday(),
    state.view === 'applications' && !$('workspace').hidden ? loadWorkspace() : null]);
  loadSections();
  // A prepare/re-tailor run replaces the packet and its tailoring audit on
  // disk. Refresh the open detail rail too; otherwise it keeps displaying the
  // packet object fetched before the run and makes regeneration look inert.
  // (Reconciled, not rebuilt — see renderDetail.)
  if (state.selectedId) await selectJob(state.selectedId);
}

/** Update one row's derived fields locally so the UI responds immediately. */
export function patchRow(id, patch) {
  const known = state.known.get(id);
  if (known) state.known.set(id, { ...known, ...patch });
  const tr = $('rows').querySelector(`tr.job[data-id="${cssEscape(id)}"]`);
  if (tr && known) {
    const focus = captureRowFocus();
    tr.replaceWith(rowFor({ ...known, ...patch }));
    restoreRowFocus(focus);
  }
}

/** The status a decision will produce, for the optimistic row update. */
export const DECISION_STATUS = { shortlisted: 'shortlisted', rejected: 'rejected', archived: 'archived' };

/** Apply a decision's result to the row and the open rail without a refetch. */
export function applyDecisionLocally(id, patch) {
  // A closed job's old blocker is no longer "what to do next" — clearing
  // attention stops a rejected row still reading "Retry needed".
  const full = { attention: null, ...patch };
  patchRow(id, full);
  if (state.detailJob?.id === id) {
    state.detailJob = { ...state.detailJob, ...full };
    renderDetail(state.detailJob);
  }
}

/** Jobs with a decision request in flight: a second click waits for the first. */
const deciding = new Set();

export async function decide(id, decision) {
  const known = state.known.get(id);
  // Five fast clicks on Reject sent five requests, wrote five events and
  // stacked five undo toasts; with two, Undo restored "rejected", because
  // the second click saw the first one's optimistic result as "before".
  // One request per job at a time, and a click that would change nothing is
  // not a request.
  if (deciding.has(id)) return;
  if (decision !== 'clear' && known?.userDecision === decision) return;
  deciding.add(id);
  try { await decideOnce(id, decision, known); } finally { deciding.delete(id); }
}

async function decideOnce(id, decision, known) {
  const before = { appStatus: known?.appStatus, userDecision: known?.userDecision ?? null, attention: known?.attention ?? null };
  // Optimistic: the click shows its result at once, and is rolled back if
  // the server refuses it.
  if (DECISION_STATUS[decision]) applyDecisionLocally(id, { appStatus: DECISION_STATUS[decision], userDecision: decision });
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/decision`, { decision });
    if (decision === 'clear') {
      // Clearing returns a job to whatever it was before — only the server
      // knows that, so this one case re-reads the job.
      patchRow(id, { appStatus: result.appStatus, userDecision: result.userDecision });
      if (state.selectedId === id) loadDetail(id);
    } else {
      applyDecisionLocally(id, { appStatus: result.appStatus ?? DECISION_STATUS[decision], userDecision: result.userDecision ?? decision });
    }
    announceDecision(id, decision, before.userDecision ?? 'clear');
    scheduleRefresh();
  } catch (err) {
    if (DECISION_STATUS[decision] && before.appStatus) applyDecisionLocally(id, before);
    toast(err.message, 'bad');
  }
}

/** Which tab a packet action moves a job out of and into (see shiftViewCount). */
const TAB_MOVES = {
  approve: ['needs_review', 'needs_review', 'ready_apply'],
  'reject-packet': ['needs_review', 'needs_review', null],
  unapprove: ['approved', 'ready_apply', 'needs_review'],
};

export async function simpleAction(id, action, okMessage) {
  try {
    const was = state.known.get(id)?.appStatus;
    await postJson(`/api/jobs/${encodeURIComponent(id)}/${action}`);
    const move = TAB_MOVES[action];
    if (move && was === move[0]) shiftViewCount(move[1], move[2]);
    toast(okMessage, 'good');
    // Approve / reject-packet change the packet, which only the detail
    // payload carries — one job re-read, reconciled into the rail.
    if (state.selectedId === id) loadDetail(id);
    scheduleRefresh();
  } catch (err) { toast(err.message, 'bad'); }
}

export async function runPhase(phase) {
  if (state.running) { toast('A run is already in progress.', 'bad'); return; }
  try {
    await postJson('/api/run', { phase });
    toast(`${phase} started…`);
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

export async function autofillOne(id) {
  if (autofillBlockedReason()) { toast(autofillBlockedReason(), 'bad'); return; }
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  const job = state.known.get(id);
  if (job && isAggregatorUrl(job.url)) {
    toast('Use the direct employer/ATS URL for auto-fill. Open the listing and save its Apply URL.', 'bad');
    return;
  }
  try {
    await postJson(`/api/jobs/${encodeURIComponent(id)}/auto-apply`, {});
    toast('Auto-fill started — it stops before Submit.');
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

export async function prepareOne(id) {
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  if (prepareBlockedNotice()) { toast('Prepare is off until the template values in the notice at the top of the page are replaced.', 'bad'); return; }
  state.prepareFailures.delete(id);
  try {
    await postJson('/api/prepare-batch', { jobIds: [id] });
    toast('Preparing the tailored resume + packet…');
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

export async function checkLink(id) {
  const box = $('linkHealth');
  if (box) { box.className = 'linkhealth'; box.textContent = 'Checking the saved posting link…'; }
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/check-link`);
    const tone = ['reachable', 'open'].includes(result.status) ? 'good'
      : ['closed', 'broken', 'invalid', 'error'].includes(result.status) ? 'bad' : '';
    // An ATS answer is the whole story; the raw HTTP code only helps when we
    // fell back to fetching the page itself.
    const text = result.liveness
      ? `${result.message}${result.retired ? ' It has been removed from your board.' : ''}`
      : `${result.message}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`;
    const known = state.known.get(id);
    if (known && result.liveness?.state) {
      known.linkState = result.liveness.state;
      known.linkCheckedAt = new Date().toISOString();
    }
    state.linkHealth.set(id, { tone, text });
    if (box) { box.className = `linkhealth ${tone}`.trim(); box.textContent = text; }
    // Always surface it as a toast too: the inline slot only exists while the
    // detail rail is open, and the old build silently dropped the result.
    toast(text, tone);
    if (result.retired) {
      scheduleBoardReload();
      scheduleTodayReload();
    }
  } catch (err) {
    state.linkHealth.set(id, { tone: 'bad', text: err.message });
    if (box) { box.className = 'linkhealth bad'; box.textContent = err.message; }
    toast(err.message, 'bad');
  }
}

/**
 * Say what a single decision did — with a way back when it closed the job.
 *
 * Reject and Archive in the rail used to write immediately with nothing but a
 * "Marked rejected" toast; one mis-click lost the job from the board with no
 * recovery short of finding it under Closed jobs. They now get the same undo
 * the batch actions have, plus the optional one-click reason.
 */
export function announceDecision(id, decision, wasDecision) {
  if (decision !== 'rejected' && decision !== 'archived') {
    const cleared = { shortlisted: 'Removed from your shortlist', archived: 'Unarchived', rejected: 'No longer rejected' };
    toast(decision === 'clear' ? (cleared[wasDecision] ?? 'Decision cleared') : `Marked ${decision}`, 'good');
    return;
  }
  const job = state.known.get(id);
  const name = job?.title ? `“${job.title}”` : 'this job';
  offerUndo(`${decision === 'rejected' ? 'Rejected' : 'Archived'} ${name}`,
    new Map([[id, wasDecision]]), { reasonFor: { jobIds: [id], decision } });
}


/**
 * Check open postings against their ATS now, and take the closed ones off the
 * board. The dashboard also does this by itself every few hours; this is the
 * "I just saw a dead link, clean it up" button.
 */
export async function sweepClosedPostings() {
  try {
    const started = await postJson('/api/postings/sweep', { limit: 500 });
    toast(`Checking up to ${started.limit} open postings with their employers' job systems…`, '');
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }
  const deadline = Date.now() + 15 * 60_000;
  const poll = async () => {
    let status = null;
    try { status = await fetch('/api/postings/sweep').then((r) => r.json()); } catch { status = null; }
    if (status?.running && Date.now() < deadline) { setTimeout(poll, 3000); return; }
    const last = status?.last;
    if (!last || last.error) { toast(last?.error ?? 'The posting check did not finish.', 'bad'); return; }
    toast(last.retired
      ? `Checked ${last.checked} postings — ${last.retired} closed by the employer and removed from your board.`
      : `Checked ${last.checked} postings — all still open.`, 'good');
    scheduleBoardReload();
    scheduleTodayReload();
  };
  setTimeout(poll, 3000);
}


/**
 * Replace the template background in the active profile with what the master
 * resume states (roles, employers, education, skills). Search goals are left
 * alone. The placeholder notice's one-click fix.
 */
export async function fillProfileFromResume() {
  try {
    const result = await postJson('/api/search-profiles/refresh-background', {});
    if (!result.changed?.length) {
      toast('Your profile already matches your master resume.', 'good');
    } else {
      const names = { workHistory: 'work history', education: 'education', skills: 'skills', yearsExperience: 'years of experience',
        currentRoles: 'current roles', earlierRoles: 'earlier roles', certifications: 'certifications', industries: 'industries',
        seniority: 'seniority', leadership: 'leadership' };
      toast(`Profile updated from your resume: ${result.changed.map((k) => names[k] ?? k).join(', ')}.`
        + (result.warning ? ` ${result.warning}` : ''), result.warning ? 'bad' : 'good');
    }
    scheduleTodayReload();
    scheduleBoardReload();
  } catch (err) {
    toast(err.message, 'bad');
  }
}
