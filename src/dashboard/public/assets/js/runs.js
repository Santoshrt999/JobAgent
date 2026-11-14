/** Run status polling, the run pill, and run history. */

import { $, el, fmt, relTime, slowProgress } from './dom.js';
import { state } from './state.js';
import { api, apiOptional } from './api.js';
import { openDialog } from './dialogs.js';
import { refreshAll } from './mutations.js';
import { syncSelectionBar } from './selection.js';
import { loadProfileFlag } from './profile.js';

/* ─────────────────────── run status polling ─────────────────────── */

export let pollTimer = null;
export let wasRunning = false;

/**
 * Quiet background refresh for a tab left open a long time.
 *
 * `pollRun` only calls `refreshAll` when a run THIS TAB started transitions
 * from running to finished — it has no way to notice a `npm run score` (or
 * `watch`) invoked in a separate terminal, since that runs as a different OS
 * process with its own memory and never touches this tab's in-memory
 * `runState`. Without this, a tab can sit open for hours showing counts from
 * whenever it was last loaded while the database underneath has moved on —
 * exactly the shape of bug this was built to catch: a "posted 24h" number
 * that no longer has any relationship to "posted 1w" because they were
 * fetched at different, arbitrarily separated moments.
 *
 * Deliberately quiet: only when the tab is visible (no point refreshing what
 * nobody is looking at) and only when idle (a run's own progress rendering
 * already keeps itself current — refreshing over it would fight that).
 */
export const BACKGROUND_REFRESH_MS = 90_000;
export function scheduleBackgroundRefresh() {
  setTimeout(async () => {
    if (document.visibilityState === 'visible' && !state.lastRunStatus?.running) {
      lastFullRefreshAt = Date.now();
      await refreshAll();
    }
    scheduleBackgroundRefresh();
  }, BACKGROUND_REFRESH_MS);
}

export function prettyResult(result) {
  if (!result) return '';
  if (result.cancelled) return `${result.phase ?? 'run'} cancelled · finished work kept`;
  if (result.phase === 'assist-batch') {
    const list = result.results ?? [];
    const filled = list.filter((x) => x.status !== 'failed').length;
    const submitted = list.filter((x) => x.submitted).length;
    const skipped = (result.skipped ?? []).length;
    const parts = [];
    if (submitted) parts.push(`${submitted} submitted`);
    parts.push(`${filled - submitted} filled for review`);
    // Skips were previously invisible, so a fully-skipped batch read as "0/0".
    if (skipped) parts.push(`${skipped} skipped`);
    return `Auto-fill done · ${parts.join(' · ')}`;
  }
  if (result.phase === 'assist') return `Assist done · ${String(result.status ?? '').replace(/_/g, ' ')}`;
  const counters = result.counters ?? {};
  // A discovery pass reports five figures, so these are grouped: "Found 14461"
  // is materially harder to read at a glance than "Found 14,461".
  if (result.phase === 'prepare-selected') return `Prepared ${fmt(counters.jobs_prepared)} packet(s)`;
  if (result.phase === 'prepare') return `Prepared ${fmt(counters.jobs_prepared)} · scored ${fmt(counters.jobs_scored)}`;
  // NEW leads, because it is the only figure that answers "did this run find
  // me anything?". `jobs_found` is every posting every source returned — on a
  // mature corpus ~76,000, overwhelmingly already known — so leading with it
  // made a run that discovered 2,800 genuinely new roles read identically to
  // one that discovered none, which is exactly why discovery was reported as
  // "not finding new jobs" while it was in fact working.
  if (result.phase === 'discover') {
    const isNew = Number(counters.jobs_new ?? 0);
    const seen = Number(counters.jobs_found ?? 0);
    // When every posting seen was new (a first run, or a fresh database) the
    // two figures are identical, and "52,474 new · 52,474 seen" read as a
    // duplicated stat. Say it once.
    const head = seen > 0 && seen === isNew
      ? `${fmt(isNew)} new (all of them)`
      : `${fmt(isNew)} new · ${fmt(seen)} seen`;
    return `${head} · scored ${fmt(counters.jobs_scored)}`;
  }
  if (result.phase === 'score') return `Re-scored ${fmt(counters.jobs_rescored ?? counters.jobs_scored)}`;
  return `${result.phase ?? 'run'} done`;
}

/** What the user asked for, in their words — not the internal phase name. */
export const PHASE_LABELS = {
  discover: 'Finding new jobs',
  score: 'Re-scoring existing jobs',
  prepare: 'Finding & preparing',
  'prepare-selected': 'Preparing selected jobs',
  assist: 'Filling the application',
  'assist-batch': 'Auto-filling applications',
};

export function phaseLabel(phase) {
  const key = String(phase ?? '').replace(/\s*\(.*$/, '');
  return PHASE_LABELS[key] ?? `${key || 'Run'} running`;
}

/** mm:ss since an ISO timestamp — a long run should say how long it has been. */
export function elapsedSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The per-source (or per-job) breakdown behind "Details".
 *
 * Every field here was already in the run state and had nowhere to appear, so a
 * board that timed out or got throttled looked identical to one that returned
 * nothing. Rendered from state each poll so an open panel stays live.
 */
export function renderRunDetails(status) {
  const host = $('runDetails');
  host.textContent = '';
  const progress = status?.progress;
  const items = progress?.items ?? [];

  if (items.length) {
    const perSource = progress.kind === 'sources';
    host.append(el('h4', { text: perSource ? 'Job boards' : 'Jobs in this batch' }));
    for (const item of items) {
      const row = el('div', { class: 'run-row' });
      row.append(el('span', { class: 'who', text: perSource ? item.source : (state.known.get(item.jobId)?.company ?? item.jobId) }));
      const bits = [];
      if (perSource) {
        if (item.found) bits.push(`${fmt(item.found)} found`);
        if (item.errors) bits.push(`${item.errors} error(s)`);
        if (item.cached) bits.push('cached');
        if (Number.isFinite(item.durationMs) && item.durationMs > 0) bits.push(`${Math.round(item.durationMs / 1000)}s`);
      } else if (item.reason) bits.push(item.reason);
      if (bits.length) row.append(el('span', { class: 'num', text: bits.join(' · ') }));
      row.append(el('span', { class: `state ${item.status ?? ''}`.trim(), text: item.status ?? '' }));
      host.append(row);
    }
  }

  // Structured per-source failures. The classifier already works out WHY
  // (category + HTTP status), keeps the sanitized provider message, and carries
  // per-category guidance — but only `impact` was rendered, so the panel said
  // "16 results are missing" and never why. Cause, provider message, the fix,
  // and the cost are all shown now.
  const rca = status?.rca ?? [];
  if (rca.length) {
    host.append(el('h4', { text: status.partial ? 'Problems (partial results kept)' : 'Problems' }));
    for (const entry of rca.slice(0, 12)) {
      const block = el('div', { class: 'run-problem' });
      const head = el('div', { class: 'run-row' });
      const cause = [
        String(entry.category ?? 'unknown').replace(/_/g, ' '),
        entry.status ? `HTTP ${entry.status}` : null,
        entry.retryCount ? `${entry.retryCount} retr${entry.retryCount === 1 ? 'y' : 'ies'}` : null,
      ].filter(Boolean).join(' · ');
      head.append(el('span', { class: 'who' }, el('b', { text: entry.source ?? entry.operation ?? 'run' })));
      head.append(el('span', { class: 'num', text: cause }));
      if (entry.count > 1) head.append(el('span', { class: 'num', text: `×${entry.count}` }));
      // Label by what actually happened to the results, not by the mere
      // presence of an error. A source that returned 38,830 jobs and lost one
      // page is "partial"; only a source that delivered nothing is "failed".
      // Calling both "failed" was the single most misleading thing this panel
      // said, because it sat directly above the (equally wrong) claim that the
      // source's results were missing from the run.
      const outcome = entry.outcome
        ?? (entry.degraded ? 'degraded' : (Number(entry.kept) > 0 ? 'partial' : 'failed'));
      // Reuse the run-row state palette: `partial`/`skipped` are amber,
      // `failed` is red. Inventing a `warn` class here would have rendered
      // unstyled, which is how a "partial" badge ends up looking like plain text.
      const OUTCOME_CLASS = {
        degraded: 'partial', partial: 'partial', failed: 'failed', unknown: 'failed',
      };
      head.append(el('span', {
        class: `state ${OUTCOME_CLASS[outcome] ?? 'failed'}`,
        text: outcome === 'partial' && Number(entry.kept) > 0
          ? `partial · ${fmt(entry.kept)} kept`
          : outcome,
      }));
      block.append(head);
      if (entry.message) block.append(el('div', { class: 'run-why', text: entry.message }));
      if (entry.guidance) block.append(el('div', { class: 'run-fix', text: entry.guidance }));
      if (entry.impact) block.append(el('div', { class: 'run-impact', text: entry.impact }));
      host.append(block);
    }
  }

  if (!items.length && !rca.length) {
    host.append(el('div', { class: 'muted', text: 'No per-source detail was reported for this run.' }));
  }
  host.append(el('div', { class: 'run-more' }, el('button', {
    type: 'button', class: 'small ghost', 'data-action': 'open-runs', text: 'Run history…',
  })));
}

export function applyRunGate(status) {
  state.running = Boolean(status?.running);
  for (const id of ['btnDiscover', 'btnPrepare']) {
    const button = $(id);
    button.disabled = state.running;
    // Remember the real explanation the FIRST time, before it is replaced.
    // Reading it back from `button.title` restored the "run in progress" text
    // instead, so after one run these buttons never explained themselves again.
    if (button.dataset.title === undefined) button.dataset.title = button.title;
    button.title = state.running ? 'A run is in progress…' : button.dataset.title;
  }

  const box = $('runbox');
  const cancel = $('btnCancel');
  const details = $('btnRunDetails');
  const dismiss = $('btnRunDismiss');
  const line = $('runline');
  const progress = status?.progress;
  const finished = status?.finishedAt ?? null;
  // A finished result stays until it is dismissed OR superseded by a newer run.
  const dismissed = Boolean(finished) && state.runDismissedAt === finished;

  if (state.running) {
    box.dataset.state = 'running';
    $('runStatus').textContent = status.cancelRequested
      ? `Stopping ${phaseLabel(status.phase).toLowerCase()}…`
      : phaseLabel(status.phase);
    const meta = [];
    if (progress && Number.isFinite(progress.total) && progress.total > 0) {
      const unit = progress.kind === 'sources' ? 'sources' : 'jobs';
      meta.push(`${progress.completed ?? 0} of ${progress.total} ${unit}`);
      if (progress.currentSource) meta.push(progress.currentSource);
    }
    const elapsed = elapsedSince(status.startedAt);
    if (elapsed) meta.push(elapsed);
    $('runMeta').textContent = meta.join(' · ');

    // Determinate when the server knows the total; motion-only when it does not,
    // rather than a bar that pretends to know how far along it is.
    const total = Number(progress?.total);
    const done = Number(progress?.completed ?? 0);
    line.hidden = false;
    if (Number.isFinite(total) && total > 0) {
      line.classList.remove('indeterminate');
      // `--progress` drives a composited scaleX; see `.runline i` in app.css.
      $('runlineFill').style.setProperty('--progress', String(Math.min(1, done / total)));
    } else {
      line.classList.add('indeterminate');
      $('runlineFill').style.removeProperty('--progress');
    }
  } else if (status?.lastError && !dismissed) {
    box.dataset.state = 'error';
    $('runStatus').textContent = 'Run failed';
    $('runMeta').textContent = status.lastError;
    line.hidden = true;
  } else if (status?.lastResult && !dismissed) {
    box.dataset.state = status.partial || (status.rca ?? []).length ? 'warn' : 'ok';
    $('runStatus').textContent = prettyResult(status.lastResult);
    // "failed" overstates it: a source that hit one bad page still delivered
    // the rest, and this line sits right above the per-source breakdown that
    // now says so. Naming the count of affected sources is the useful part.
    $('runMeta').textContent = status.partial
      ? `${(status.rca ?? []).length || 'some'} source(s) had problems — results from healthy sources were kept`
      : '';
    line.hidden = true;
  } else {
    box.dataset.state = 'idle';
    line.hidden = true;
  }

  const idle = box.dataset.state === 'idle';
  cancel.hidden = !state.running;
  cancel.disabled = !state.running || status.cancelRequested;
  cancel.textContent = status?.cancelRequested ? 'Stopping…' : 'Cancel';
  dismiss.hidden = state.running || idle;
  // Shown for any non-idle state: even a run with no per-source detail links
  // to the run history from its popover.
  details.hidden = idle;
  if (details.hidden) setRunDetails(false);
  if ($('runDetails').hidden === false) renderRunDetails(status);
  // Keep the last payload so opening the panel does not need another fetch.
  state.lastRunStatus = status ?? null;

  syncSelectionBar();
}

/** Open/close the run breakdown. */
export function setRunDetails(open) {
  $('runDetails').hidden = !open;
  $('btnRunDetails').setAttribute('aria-expanded', String(open));
  if (open) renderRunDetails(state.lastRunStatus);
}

/*
 * One poll chain, ever. runPhase / autofill / cancel each call pollRun() to
 * poll NOW, and every call used to start another self-rescheduling chain — so
 * after a few actions the page polled several times a second. A generation
 * token makes any older chain stop at its next await.
 *
 * A hidden tab polls every 30s instead of every 1.5-5s, and a tab coming back
 * into view polls at once rather than waiting out that interval.
 */
export let pollGen = 0;
export const HIDDEN_POLL_MS = 30_000;

export async function pollRun() {
  const gen = ++pollGen;
  clearTimeout(pollTimer);
  const wasDown = state.serverUp === false;
  let status;
  try {
    status = await api('/api/run/status');
  } catch {
    if (gen === pollGen) pollTimer = setTimeout(pollRun, document.hidden ? HIDDEN_POLL_MS : 2000);
    return;
  }
  if (gen !== pollGen) return;
  applyRunGate(status);
  // While a run is going, lastResult is still the PREVIOUS run's.
  if (!status.running) recordPrepareOutcome(status.lastResult);
  const finished = !status.running && wasRunning;
  if (wasDown || finished) refreshAll({ force: true });
  // An auto-fill run is what adds questions to the profile's queue.
  if (finished && /assist/.test(String(status.lastResult?.phase ?? status.phase ?? ''))) loadProfileFlag();
  wasRunning = status.running;
  const delay = document.hidden ? HIDDEN_POLL_MS : status.running ? 1500 : 5000;
  pollTimer = setTimeout(pollRun, delay);
}

/**
 * Remember which jobs a Prepare run could not prepare, and why.
 *
 * The run summary said only "Prepared 0 packet(s)": the reason (a refused
 * profile, another person's resume, a closed posting) was in the server log,
 * so a failed Prepare looked like nothing happened. Kept per job until a later
 * Prepare of that job succeeds, and shown in its Tailored resume box.
 */
export function recordPrepareOutcome(result) {
  if (result?.phase !== 'prepare-selected') return;
  for (const { jobId } of result.prepared ?? []) state.prepareFailures.delete(jobId);
  for (const { jobId, error } of result.failed ?? []) state.prepareFailures.set(jobId, String(error ?? 'unknown error'));
}

export let lastFullRefreshAt = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  pollRun();
  if (Date.now() - lastFullRefreshAt > BACKGROUND_REFRESH_MS) {
    lastFullRefreshAt = Date.now();
    refreshAll();
  }
});

/* ─────────────────────────── run history ───────────────────────────
 * "What did last night's run do?" The run pill only ever describes the
 * latest run, and only until it is dismissed. GET /api/runs?limit=20 lists
 * recent runs newest first; both the documented shape ({ mode, startedAt,
 * endedAt, durationMs, counters, perSource, errors }) and the raw run_log
 * rows an older server returns are read.
 */

export const parseJsonList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

/** Outcome words the server uses, collapsed to the three a chip can show. */
export function outcomeTone(outcome) {
  const key = String(outcome ?? '').toLowerCase();
  if (['ok', 'done', 'success', 'succeeded', 'complete'].includes(key)) return 'ok';
  if (['partial', 'degraded', 'skipped'].includes(key)) return 'partial';
  return 'failed';
}

export function normalizeRun(raw) {
  const counters = raw.counters ?? {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = counters[key] ?? raw[key];
      if (value !== null && value !== undefined && value !== '') return Number(value);
    }
    return null;
  };
  const errors = parseJsonList(raw.errors);
  let perSource = Array.isArray(raw.perSource) ? raw.perSource.map((s) => ({
    source: s.source ?? s.name ?? 'source', outcome: s.outcome ?? s.status ?? 'ok', found: s.found ?? null,
  })) : null;
  if (!perSource) {
    // Older rows carry only the failures; each source is as bad as its worst.
    const worst = new Map();
    const rank = { ok: 0, partial: 1, failed: 2 };
    for (const entry of errors) {
      const source = entry.source ?? entry.operation ?? 'run';
      const tone = outcomeTone(entry.outcome ?? (Number(entry.kept) > 0 ? 'partial' : 'failed'));
      if ((rank[tone] ?? 2) >= (rank[worst.get(source)] ?? -1)) worst.set(source, tone);
    }
    perSource = [...worst].map(([source, outcome]) => ({ source, outcome, found: null }));
  }
  const startedAt = raw.startedAt ?? raw.started_at ?? null;
  const endedAt = raw.endedAt ?? raw.ended_at ?? null;
  const duration = Number(raw.durationMs);
  return {
    id: raw.runId ?? raw.run_id ?? startedAt,
    mode: raw.mode && raw.mode !== 'unknown' ? raw.mode : null,
    startedAt,
    endedAt,
    // A negative or missing duration is a row the process never closed, not
    // a run that took no time — shown as unknown.
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
    found: pick('found', 'jobs_found'),
    new: pick('new', 'jobs_new'),
    scored: pick('scored', 'jobs_scored'),
    discarded: pick('discarded', 'jobs_discarded'),
    prepared: pick('prepared', 'jobs_prepared'),
    perSource,
    errors,
  };
}

export function humanDuration(ms) {
  if (ms == null) return 'duration unknown';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ${secs % 60} s`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export const RUN_MODE_LABELS = { discover: 'Find new jobs', score: 'Re-score', prepare: 'Find & prepare', 'prepare-selected': 'Prepare selected', assist: 'Auto-fill', 'assist-batch': 'Auto-fill batch' };

export async function openRuns() {
  const body = $('runsBody');
  openDialog($('dlgRuns'));
  const stop = slowProgress(body, 'Reading recent runs…');
  let data;
  try { data = await apiOptional('/api/runs?limit=20'); }
  catch (err) { stop(); body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }
  stop();
  body.textContent = '';
  if (!data) {
    // An older server: say so once, and stop offering the entry points.
    for (const node of document.querySelectorAll('[data-action="open-runs"]')) node.hidden = true;
    body.append(el('div', { class: 'muted', text: 'Run history needs a newer dashboard server. Restart it with "npm run dashboard".' }));
    return;
  }
  const runs = (data.runs ?? []).map(normalizeRun);
  if (!runs.length) {
    body.append(el('div', { class: 'empty' }, el('div', { class: 'big', text: 'No runs recorded yet' }),
      'Each Find new jobs, re-score or prepare pass is listed here once it finishes.'));
    return;
  }
  const list = el('ol', { class: 'runlist' });
  for (const run of runs) list.append(runRecord(run));
  body.append(list);
}

export function runRecord(run) {
  const item = el('li', { class: 'runrec' });
  const head = el('div', { class: 'runrec-head' });
  head.append(el('b', { text: RUN_MODE_LABELS[run.mode] ?? (run.mode ? run.mode : 'Run') }));
  head.append(el('span', { class: 'muted', title: run.startedAt ?? '', text: relTime(run.startedAt) ?? 'time unknown' }));
  head.append(el('span', { class: 'faint', text: humanDuration(run.durationMs) }));
  item.append(head);

  const figures = [['found', run.found], ['new', run.new], ['scored', run.scored], ['discarded', run.discarded], ['prepared', run.prepared]]
    .filter(([label, value]) => value != null && !(value === 0 && ['prepared', 'new'].includes(label)));
  if (figures.length) {
    item.append(el('dl', { class: 'runrec-figs' }, ...figures.map(([label, value]) => el('div', { class: 'fig' },
      el('dt', { text: label }), el('dd', { text: fmt(value) })))));
  }
  if (run.perSource.length) {
    const chips = el('div', { class: 'runrec-sources', 'aria-label': 'Source outcomes' });
    for (const source of run.perSource) {
      const tone = outcomeTone(source.outcome);
      chips.append(el('span', {
        class: `chip src-${tone}`,
        title: `${source.source}: ${tone}${source.found != null ? ` · ${fmt(source.found)} found` : ''}`,
        text: `${source.source} · ${tone}`,
      }));
    }
    item.append(chips);
  }
  if (run.errors.length) {
    const more = el('details', { class: 'runrec-errors' });
    more.append(el('summary', { text: `${run.errors.length} problem${run.errors.length === 1 ? '' : 's'}` }));
    const ul = el('ul', { class: 'plan' });
    for (const entry of run.errors.slice(0, 20)) {
      ul.append(el('li', {},
        el('b', { text: entry.source ?? entry.operation ?? 'run' }), ' — ',
        [String(entry.category ?? '').replace(/_/g, ' '), entry.status ? `HTTP ${entry.status}` : null]
          .filter(Boolean).join(' · '),
        entry.message ? el('div', { class: 'run-why', text: entry.message }) : null,
        entry.guidance ? el('div', { class: 'run-fix', text: entry.guidance }) : null));
    }
    more.append(ul);
    item.append(more);
  }
  return item;
}
