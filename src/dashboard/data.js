/**
 * Dashboard data layer.
 *
 * Pure query/aggregation functions over the local SQLite store — no HTTP, no
 * DOM — so the entire dashboard contract is unit-testable. The server is a
 * thin JSON shell around these functions.
 *
 * Key concepts:
 *   - appStatus: ONE derived, human-meaningful status per job that merges the
 *     pipeline status, the approval queue, and the user's own triage decision
 *     (shortlist/reject/archive). Truthfulness rule: a job only ever reads
 *     "submitted" (jobs.applied = 1) when the human submitted it, or when the
 *     human-opted-in auto-submit VERIFIED the submission (confirmation page).
 *     An auto-submit click without confirmation reads "submit_unverified" and
 *     needs the human to confirm — it never counts as submitted on its own.
 *   - fitBucket: strong / medium / weak / no_fit, derived from the scoring tier.
 *   - whyFit: the stored score explanation + matched/missing keywords, so the
 *     UI can show exactly WHY a job ranked where it did.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

import { APPROVAL_STATUS, approve, reject, latestApprovalsByJob } from '../apply/approvalQueue.js';
import { APPROVAL_EVENT } from '../apply/approvalDigest.js';
import { jsonList } from '../utils/json.js';
import { isWithinLast24Hours, isWithinLastHours, formatPostedRelative, ageInDays } from '../utils/dates.js';
import { EMPLOYMENT_LABELS } from '../scoring/employmentClassifier.js';
import { applicationStatePath, legacyApplicationStatePath } from '../apply/applicationState.js';
import { isSponsorshipGated, configureGateThreshold, gateThreshold } from '../scoring/explainScore.js';
import { extractDocxText } from '../resume/docxText.js';
import { usLocationSignal, US_STATE_COUNT } from '../utils/usGeography.js';
import {
  APP_STATUS, APP_STATUS_LABELS, LIFECYCLE_TO_APP_STATUS, deriveAppStatus, fitBucket,
  gradeFromScore, FIT_LABELS, postedConfidence, resumeStatusOf,
} from '../domain/appStatus.js';
import { candidateTimeZone, dayOf } from '../domain/time.js';
import {
  FOLLOWUP_EVENT, OUTCOME, OUTCOME_EVENT, OUTCOME_LABELS, OUTCOME_VALUES, TERMINAL_OUTCOMES, WORKSPACE_STAGES,
  allowedOutcomes, applicationMetrics, conversionBreakdown, canRecordOutcome, daysBetween, isIsoDay, replayFollowUps, replayOutcomes, stageOf,
  NO_OUTCOME_EXPORT, outcomeEventsByJob, outcomeExport, weeklySummary,
} from '../domain/applicationOutcome.js';
import { findPlaceholders } from '../config/placeholders.js';
import { csvCell } from '../reports/csv.js';
import { masterResumeFile, workspacePaths } from '../profile/workspace.js';
import { letterModeFor } from '../apply/letterMode.js';
import { displayCompany } from '../utils/companyName.js';
import { extractHiddenClauses } from '../scoring/hiddenClauses.js';
import { applicationAccess, openQuestionsFor, signInGroups } from '../apply/autofillReadiness.js';
import { loadQuestionQueue } from '../apply/questionQueue.js';
import { evidenceFor, masterResumeLines } from '../resume/evidenceMap.js';
import { employerHistory } from './employerHistory.js';
import { preferenceProposals } from './preferenceProposals.js';

// The status vocabulary and the pure per-row rules moved to src/domain so the
// tracker, reports and CLI can use them without importing this whole data
// layer. Re-exported (alongside real local imports) so every existing import
// site keeps working unchanged.
export {
  APP_STATUS, APP_STATUS_LABELS, LIFECYCLE_TO_APP_STATUS, deriveAppStatus, fitBucket,
  gradeFromScore, FIT_LABELS, postedConfidence, resumeStatusOf,
};

/** User decisions accepted by applyDecision(). */
export const USER_DECISIONS = Object.freeze(['shortlisted', 'rejected', 'archived', 'clear']);

// The sponsorship gate is a SCORING concept; it lives in scoring/explainScore.js
// next to the rule that creates it. Re-exported here (alongside a real local
// import, since `export … from` alone would not bind it for use below) so every
// existing dashboard consumer and its tests keep one import site.
export { isSponsorshipGated, configureGateThreshold, gateThreshold };


/**
 * The happy-path pipeline a job advances through, plus terminal off-ramps. Used
 * to draw a progress bar so you can see at a glance where each job stands and
 * where the bottlenecks are.
 */
export const PROGRESS_STAGES = Object.freeze([
  'discovered', 'scored', 'shortlisted', 'prepared', 'approved', 'ready_for_submit', 'submitted',
]);

/** Off-ramp statuses that are not points on the linear pipeline. */
const OFFRAMP_STAGE = Object.freeze({
  [APP_STATUS.BLOCKED]: 'blocked',
  [APP_STATUS.FAILED]: 'failed',
  [APP_STATUS.CANCELLED]: 'cancelled',
  [APP_STATUS.SKIPPED]: 'skipped',
  [APP_STATUS.REJECTED]: 'rejected',
  [APP_STATUS.ARCHIVED]: 'archived',
  [APP_STATUS.DISCARDED]: 'discarded',
  [APP_STATUS.DATE_UNCONFIRMED]: 'date_unconfirmed',
  [APP_STATUS.SUBMIT_UNVERIFIED]: 'submit_unverified',
  // Not a failure, but genuinely off the main progress line: the row is parked
  // until its description is fetched, and no amount of waiting advances it.
  [APP_STATUS.NEEDS_DESCRIPTION]: 'needs_description',
});

/**
 * Map a board appStatus to a progress position.
 *
 * @param {string} appStatus an APP_STATUS value
 * @returns {{ stage: string, index: number, total: number, offRamp: boolean, percent: number }}
 */
export function progressFor(appStatus) {
  const total = PROGRESS_STAGES.length;
  if (OFFRAMP_STAGE[appStatus]) {
    return { stage: OFFRAMP_STAGE[appStatus], index: -1, total, offRamp: true, percent: 0 };
  }
  // needs_review sits at the "prepared" position (packet built, awaiting approval).
  const normalized = appStatus === APP_STATUS.NEEDS_REVIEW ? 'prepared' : appStatus;
  const index = PROGRESS_STAGES.indexOf(normalized);
  const i = index < 0 ? 0 : index;
  return { stage: PROGRESS_STAGES[i], index: i, total, offRamp: false, percent: Math.round((i / (total - 1)) * 100) };
}

/**
 * Best-effort "last thing that happened" timestamp + human label for a job, so
 * the board can show recency of action rather than just discovery time.
 * @param {object} job
 * @param {string} appStatus
 * @returns {{ at: string|null, label: string }}
 */
export function lastActionFor(job = {}, appStatus = '') {
  if (Number(job.applied) === 1 && job.applied_at) return { at: job.applied_at, label: 'submitted' };
  if (job.decided_at && job.user_decision) return { at: job.decided_at, label: job.user_decision };
  if (job.updated_at && job.updated_at !== job.created_at) return { at: job.updated_at, label: appStatus || 'updated' };
  return { at: job.created_at ?? null, label: 'discovered' };
}

/**
 * A failure of THIS MACHINE, not of the application: the Playwright browser
 * binary is missing. Every auto-fill fails the same way until it is installed,
 * so these rows are one setup problem, not N per-job blockers — and they were
 * being mis-filed as "Page / navigation problem" / "Browser needs attention",
 * which sent the user to fix job links that were fine.
 */
export const ENVIRONMENT_FAILURE_RE = /browser_unavailable|Executable doesn't exist|playwright install/i;

/** Does this row's recorded blocker say the browser is not installed? */
export function isEnvironmentFailure(jobOrRow = {}) {
  const blockers = Array.isArray(jobOrRow.assistBlockers)
    ? jobOrRow.assistBlockers : jsonList(jobOrRow.assist_blockers);
  const text = `${blockers.join(' ')} ${jobOrRow.statusReason ?? ''}`;
  return ENVIRONMENT_FAILURE_RE.test(text);
}

/** The one label every surface uses for an environmental failure. */
export const SETUP_BROWSER_LABEL = 'Setup: browser not installed';

/** The same failure once a live check says the browser IS installed now. */
export const SETUP_BROWSER_RECOVERED_LABEL = 'Retry: browser now installed';

/**
 * Is the Playwright browser installed right now? Set by the server from a live
 * check; null = unknown (tests, CLI), in which case a recorded failure is taken
 * at its word. Rows are history — on 2026-09-23 four rows still said
 * "Executable doesn't exist" eight days after Chromium was installed, and every
 * surface kept telling the user to install a browser they already had.
 */
let browserInstalledNow = null;
export function setBrowserAvailability(value) {
  const next = value === true ? true : value === false ? false : null;
  if (next === browserInstalledNow) return;
  browserInstalledNow = next;
  noteUserMutation(); // attention labels are cached with the decorated rows
}
function browserRecovered() {
  return browserInstalledNow === true;
}

/**
 * Drop box-drawing / block characters and collapse the whitespace they leave.
 * Playwright's "Executable doesn't exist" error arrives wrapped in a
 * ╔═══╗ banner, which rendered as a wall of line art in a one-line status cell.
 */
export function stripBannerChars(text) {
  return String(text ?? '')
    .replace(/[─-▟]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Plain-language explanation of WHY a job sits in its current status — the
 * answer to "why is this blocked / rejected / discarded?". Honest about the
 * common case where an older assisted-fill attempt stopped at a wall but did
 * not record the specific reason.
 *
 * @param {object} job jobs-table row
 * @param {string} appStatus derived board status
 * @param {object|null} approval latest approval row
 * @returns {string|null} a human reason, or null when none applies
 */
export function explainStatus(job = {}, appStatus = '', approval = null) {
  const reason = explainStatusRaw(job, appStatus, approval);
  return reason == null ? null : stripBannerChars(reason);
}

function explainStatusRaw(job = {}, appStatus = '', approval = null) {
  const blockers = jsonList(job.assist_blockers);
  switch (appStatus) {
    case APP_STATUS.NEEDS_DESCRIPTION:
      return 'The source gave only a title and no job description, so this row has NOT been judged on fit. '
        + 'Any score shown is provisional. Run `npm run enrich` to fetch the descriptions, after which it '
        + 'will be scored properly.';
    case APP_STATUS.SUBMIT_UNVERIFIED:
      // Two very different ways to land here: our own click with no proof it
      // landed, or the human finishing the form in the window we handed over
      // (the runner saw a confirmation page). Telling the second person that
      // "auto-submit clicked Submit" is simply false.
      if (/^you appear to have submitted/i.test(String(job.submitted_confirmation ?? ''))) {
        return 'You appear to have submitted this yourself: a confirmation page was seen in the window Job Agent '
          + `left open. ${CONFIRM_HOW}`;
      }
      // Neutral on purpose: this row may be your own report ("I submitted it
      // myself" without a number) or an unverified click. It used to say
      // "Auto-submit clicked Submit" to people who had pressed Submit
      // themselves. jobDetail words it precisely from the job's history.
      return `Reported as submitted, but not confirmed yet. ${CONFIRM_HOW}`;
    case APP_STATUS.BLOCKED:
      if (blockers.length) return `Assisted fill stopped: ${blockers.join('; ')}`;
      return 'An assisted-fill attempt stopped at an application wall (login, CAPTCHA, an account step, '
        + 'or a question it will not guess). The specific reason was not recorded, open the posting to finish '
        + 'manually, or re-run assisted fill to capture the current blocker.';
    case APP_STATUS.FAILED:
      return blockers.length
        ? `The last fill failed: ${blockers.join('; ')}`
        : 'The last fill failed unexpectedly. Review the Activity/RCA details, then Retry or Resume.';
    case APP_STATUS.CANCELLED:
      return 'You cancelled the fill at a safe checkpoint. Resume continues from the saved application URL.';
    case APP_STATUS.REJECTED:
      if (job.user_decision === 'rejected') return 'You rejected this job.';
      if (approval?.approval_status === APPROVAL_STATUS.REJECTED) return 'Its prepared packet was rejected, so it will not be applied to.';
      return 'Rejected.';
    case APP_STATUS.DISCARDED:
      return job.discard_reason
        ? `Filtered out during scoring: ${job.discard_reason}`
        : 'Filtered out during scoring (below threshold or an exclusion rule matched).';
    case APP_STATUS.DATE_UNCONFIRMED:
      return 'No reliable posting date was found, so its freshness cannot be trusted, verify before relying on "posted" age.';
    case APP_STATUS.SKIPPED:
      return 'You skipped this during an assisted-apply pass.';
    case APP_STATUS.ARCHIVED:
      return 'You archived this job.';
    default:
      return null;
  }
}

/**
 * Turn the overloaded technical `assist_blocked` state into the action the
 * person actually needs to take. This is presentation metadata only: it does
 * not weaken any automation guard or guess an answer.
 */
export function classifyAttention(job = {}, appStatus = '') {
  if (![APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED].includes(appStatus)) return null;
  const reason = jsonList(job.assist_blockers).join(' ').toLowerCase();
  let aggregator = false;
  try { aggregator = /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter|simplyhired|monster)\./i.test(new URL(job.url).hostname); }
  catch { /* invalid URL is classified below */ }
  if (appStatus === APP_STATUS.CANCELLED) return {
    kind: 'paused', label: 'Paused safely', summary: 'Resume Auto-fill when you are ready.', retryable: true,
  };
  // Checked before every per-site rule: a missing browser is not a login wall
  // or a navigation problem, and nothing about the posting needs fixing.
  if (ENVIRONMENT_FAILURE_RE.test(reason) && browserRecovered()) return {
    kind: 'retry', label: SETUP_BROWSER_RECOVERED_LABEL,
    summary: 'The last attempt failed only because the browser was not installed. It is now — retry Auto-fill '
      + '(prepare the packet again first if it is refused as another profile\'s).',
    retryable: true,
  };
  if (ENVIRONMENT_FAILURE_RE.test(reason)) return {
    kind: 'setup_browser', label: SETUP_BROWSER_LABEL,
    summary: 'Auto-fill can’t start: the Playwright browser is not installed. Run: npx playwright install chromium, then retry.',
    retryable: true,
  };
  if (/captcha|verification challenge|human verification/.test(reason)) return {
    kind: 'verification', label: 'Needs verification', summary: 'Complete the site verification in the open browser, then retry Auto-fill.', retryable: true,
  };
  if (/login|sign[ -]?in|account required|authenticate|\bmfa\b/.test(reason)) return {
    kind: 'sign_in', label: 'Needs sign-in', summary: 'Sign in on the employer site, then retry Auto-fill.', retryable: true,
  };
  if (/no application form found/.test(reason)) return {
    kind: 'form_step', label: 'Continue to form',
    summary: 'Auto-fill opened the posting but could not reach its application form. Open the posting, get to the form, then retry Auto-fill.',
    retryable: true,
  };
  if (/upload input not found|no upload selector resolved/.test(reason)) return {
    kind: 'form_step', label: 'Continue to form', summary: 'The resume field was not on the current page. Continue to the application form and retry Auto-fill.', retryable: true,
  };
  if (/could not start browser|profile.*lock|target.*closed/.test(reason)) return {
    kind: 'browser_session', label: 'Browser needs attention', summary: 'The browser session could not start. Retry with the dedicated Job Agent session.', retryable: true,
  };
  if (/404|not found|\bgone\b|posting.*closed/.test(reason)) return {
    kind: 'dead_link', label: 'Check posting link', summary: 'The saved posting may be closed or stale. Check it or replace it with the direct employer URL.', retryable: false,
  };
  if (/403|forbidden|access denied/.test(reason) || aggregator) return {
    kind: aggregator ? 'aggregator' : 'restricted_link', label: 'Open manually',
    summary: aggregator ? 'Use the employer Apply link, then save that direct URL here.' : 'The site restricts automated access; opening it manually may still work.',
    retryable: false,
  };
  // Say WHAT the form wanted, in its own words. Both used to fall through to
  // "Needs your help — open the application to complete the step…", which
  // hid "You need to agree to the terms and conditions" behind a fold.
  const raw = jsonList(job.assist_blockers).map(String);
  const asked = raw.map((b) => b.match(/^(?:required field needs user|screening needs user):\s*(.+)$/i)?.[1]).filter(Boolean);
  if (asked.length) {
    const more = asked.length > 1 ? ` (and ${asked.length - 1} more)` : '';
    return {
      kind: 'question', label: 'Answer a question',
      // The reason only: "Do this next" right below says what to do.
      summary: `The form needs your answer to "${clip(asked[0])}"${more}.`,
      retryable: true,
    };
  }
  const said = raw.map((b) => b.match(/^form validation:\s*(.+)$/i)?.[1]).filter(Boolean);
  if (said.length) return {
    kind: 'form_check', label: 'Finish a form step',
    summary: `The form said: "${clip(said[0])}"`,
    retryable: true,
  };
  if (appStatus === APP_STATUS.FAILED) return {
    kind: 'retry', label: 'Retry needed', summary: 'Review the recorded error, then retry Auto-fill.', retryable: true,
  };
  return {
    kind: 'needs_help', label: 'Needs your help', summary: 'Open the application to complete the step the assistant could not safely answer.', retryable: true,
  };
}

/** How an unverified submission is settled, in the buttons' own words. */
const CONFIRM_HOW = 'If it went through, choose "Yes, it went through" (add the confirmation number if you have one); '
  + 'if it didn\'t, choose "No, it didn\'t". It is NOT counted as submitted until you confirm.';

/** One blocker phrase, short enough for a card. */
function clip(text, max = 120) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** An Error carrying the HTTP status the server should reply with. */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** Latest approval row per job id (shared precedence with every consumer). */
const approvalsByJob = latestApprovalsByJob;

/*
 * Decoration cache.
 *
 * Every dashboard endpoint decorates the FULL jobs table per request; at tens
 * of thousands of rows that is ~1s of blocked event loop each, and the page's
 * initial burst (stats + sections + jobs + status) queues them back-to-back —
 * the UI reads as frozen. Cache the expensive computations, keyed by DATA, not
 * by the clock:
 *   - `PRAGMA data_version` — changes when ANOTHER connection commits (a CLI
 *     `watch`/`discover` writing the same file). The old key used only
 *     total_changes(), which counts this connection's writes and nothing else,
 *     so a CLI run was invisible to the dashboard until its 30 s bucket rolled;
 *   - total_changes() — this connection's own writes;
 *   - an in-process mutation counter (`noteUserMutation`) — user actions that
 *     change what the board SHOWS without writing a row (a sponsorship-gate or
 *     search-profile change).
 * The old key also carried a 30 s time bucket, so an idle dashboard threw away
 * a 5 s stats build every 30 s just to refresh "posted 3d ago". Time-derived
 * row fields are now refreshed in place at serve time (`refreshTimeFields`,
 * O(rows) string work, no decoration), and stats uses stale-while-revalidate.
 * Per-Database WeakMap so tests with separate in-memory DBs never collide.
 *
 * A bulk discover/score run upserts thousands of rows in quick succession,
 * so total_changes() moves on almost every request during one — the cache
 * would miss on every poll, exactly when the board is under the most load.
 * `setDuringBulkRun(true)` (called by the server around a discover/score run)
 * drops the write-count component for that stretch, falling back to a 30 s
 * bucket — bounded staleness instead of a per-write repaint. User mutations
 * still invalidate immediately.
 */
let duringBulkRun = false;

/** Toggle the decoration cache's write-invalidation behavior for the
 * duration of a bulk discover/score run (see comment above). */
export function setDuringBulkRun(flag) {
  duringBulkRun = Boolean(flag);
}

let userMutations = 0;

/**
 * Record a user mutation that must invalidate every cached board/stats value
 * immediately (decision, note, approval, profile or gate change). Row writes
 * already move the data key; this also covers changes that write no row.
 */
export function noteUserMutation() {
  userMutations += 1;
}

/** How long cached time-derived fields may go without a refresh. */
const TIME_REFRESH_MS = 60_000;

const _memo = new WeakMap();

/** Cache slot map for one database. */
function slotFor(db) {
  let slot = _memo.get(db);
  if (!slot) { slot = {}; _memo.set(db, slot); }
  return slot;
}

/** Epoch ms of `now` (a Date), or the wall clock. */
const msOf = (now) => (typeof now?.getTime === 'function' ? now.getTime() : Date.now());

/**
 * The data-change key for a database, or null when it cannot be read
 * (exotic stubs in tests — those skip caching entirely).
 * @returns {{key: string, local: string}|null} `local` is the part only THIS
 *   process moves (own writes + user mutations): a change there must be seen
 *   synchronously, while another process's writes may be served stale.
 */
function dataKey(db, now) {
  try {
    const version = db.db.prepare('PRAGMA data_version').get()?.data_version ?? 0;
    if (duringBulkRun) {
      const local = `bulk:${Math.floor(msOf(now) / 30_000)}:${userMutations}`;
      return { key: `${version}:${local}`, local };
    }
    const changes = db.db.prepare('SELECT total_changes() AS c').get().c;
    const local = `${changes}:${userMutations}`;
    return { key: `${version}:${local}`, local };
  } catch {
    return null;
  }
}

function cached(db, kind, now, compute) {
  const k = dataKey(db, now);
  if (!k) return compute();
  const slot = slotFor(db);
  if (slot[kind]?.key === k.key) return slot[kind].val;
  const val = compute();
  slot[kind] = { key: k.key, local: k.local, val };
  return val;
}

/**
 * Re-derive the fields of a decorated row that depend on the clock alone.
 * Kept next to boardRow so a new time-derived field is added in both places.
 */
function refreshTimeFields(row, now) {
  row.postedLabel = formatPostedRelative(row.postedAt, now);
  row.postedLast24h = isWithinLast24Hours(row.postedAt, now);
}

/**
 * `cached`, for arrays of decorated rows: a data change rebuilds, and mere
 * passage of time only refreshes the time-derived fields in place.
 */
function cachedRows(db, kind, now, compute) {
  const k = dataKey(db, now);
  if (!k) return compute();
  const slot = slotFor(db);
  const at = msOf(now);
  const entry = slot[kind];
  if (entry?.key === k.key) {
    if (Math.abs(at - entry.at) >= TIME_REFRESH_MS) {
      for (const row of entry.val) refreshTimeFields(row, now);
      entry.at = at;
    }
    return entry.val;
  }
  const val = compute();
  slot[kind] = { key: k.key, local: k.local, val, at };
  return val;
}

/**
 * Stale-while-revalidate for the expensive whole-table aggregates.
 *
 * A value is FRESH while the data key matches and it is under a minute old.
 * When it is stale only because another process wrote, a bulk run is writing,
 * or the clock moved, the cached value is returned at once (flagged
 * `stale: true`) and ONE recompute is scheduled after the response
 * (setImmediate, single-flight per kind). When the staleness is this
 * process's own doing — a click, a note, an assist result — it recomputes
 * synchronously, so the user always sees their own action reflected.
 *
 * Measured live (122,977 rows): a stats rebuild blocked the event loop for
 * 5.4 s; during a discovery run every poll paid it.
 *
 * @param {boolean} allowStale false (default): every stale case recomputes synchronously
 */
function cachedSwr(db, kind, now, compute, { allowStale = false } = {}) {
  const k = dataKey(db, now);
  if (!k) return compute();
  const slot = slotFor(db);
  const at = msOf(now);
  const entry = slot[kind];
  if (entry && entry.key === k.key && Math.abs(at - entry.at) < TIME_REFRESH_MS) {
    return entry.val;
  }
  if (allowStale && entry && entry.local === k.local) {
    if (!entry.refreshing) {
      entry.refreshing = true;
      setImmediate(() => {
        try {
          const fresh = dataKey(db, now);
          const val = compute();
          if (fresh) slot[kind] = { key: fresh.key, local: fresh.local, val, at };
        } catch { /* a closed db (shutdown) — keep serving the old value */ } finally {
          entry.refreshing = false;
        }
      });
    }
    return { ...entry.val, stale: true };
  }
  const val = compute();
  slot[kind] = { key: k.key, local: k.local, val, at };
  return val;
}

/**
 * The discovery scope a board read is about.
 *
 * Every row source below is scoped, and the cache key carries the scope with
 * it: a cached personalized board must never be handed back to a role-search
 * read, or the two modes would show each other's rows through the cache even
 * though the SQL kept them apart.
 *
 * @param {object} filters
 * @returns {{mode: string, query: string|null, key: string}}
 */
function discoveryScope(filters = {}) {
  const mode = filters.discoveryMode === 'role_search' ? 'role_search'
    : filters.discoveryMode === 'all' ? 'all' : 'profile';
  const query = mode === 'role_search' && filters.searchQuery
    ? String(filters.searchQuery) : null;
  return { mode, query, key: `${mode}:${query ?? ''}` };
}

/**
 * Every row, whichever search found it.
 *
 * The scoped default (`profile`) is right for anything that RECOMMENDS — the
 * board, the stats, the next-actions rail. It is wrong for anything that is a
 * RECORD of what the user has produced or done: an export, a documents list, a
 * staleness count. A packet built, or a job applied to, belongs in those
 * however it was found, so they ask for this scope explicitly.
 */
const EVERY_MODE = Object.freeze({ mode: 'all', query: null, key: 'all:' });

/** All jobs decorated as board rows (cached — see above). */
function allBoardRows(db, now, scope = discoveryScope()) {
  return cachedRows(db, `rows:${scope.key}`, now, () => {
    const approvals = approvalsByJob(db);
    return listSummaryRows(db, scope).map((job) => boardRow(job, approvals.get(job.id) ?? null, now));
  });
}

/**
 * Board rows EXCLUDING provably-`discarded` jobs — the set the default board
 * can actually display. See db.listOpenJobsSummary for why: the discard pile is
 * ~98% of the table on real data, so decorating it to render a page that hides
 * it was the dominant cost on every filter click.
 *
 * Falls back to the full set when the db has no such method (test stubs).
 */
/**
 * How many jobs the Jobs list's "All jobs" tab holds — the same predicate as
 * that tab, over the same cached rows — so another surface (Data quality)
 * can quote the number without disagreeing with it (BUG-10).
 */
export function activeJobCount(db, now = new Date()) {
  let n = 0;
  for (const row of openBoardRows(db, now)) if (BOARD_VIEWS.all(row)) n += 1;
  return n;
}

/**
 * Memoize any per-database derived value on the shared data key: recomputed
 * after a write or user mutation, otherwise served from memory.
 */
export function cachedForData(db, kind, now, compute) {
  return cached(db, `ext:${kind}`, now, compute);
}

function openBoardRows(db, now, scope = discoveryScope()) {
  if (typeof db.listOpenJobsSummary !== 'function') return allBoardRows(db, now, scope);
  return cachedRows(db, `openRows:${scope.key}`, now, () => {
    const approvals = approvalsByJob(db);
    return db.listOpenJobsSummary({ mode: scope.mode, query: scope.query })
      .map((job) => boardRow(job, approvals.get(job.id) ?? null, now));
  });
}

/**
 * All jobs without jd_text (board rows never render it; detail loads it via
 * getJob). Falls back to listJobs for test stubs that only implement that.
 */
function listSummaryRows(db, scope = discoveryScope()) {
  const args = { mode: scope.mode, query: scope.query };
  return typeof db.listJobsSummary === 'function' ? db.listJobsSummary(args) : db.listJobs(args);
}


/**
 * Was this row dropped purely because its posting date was unreadable?
 *
 * Matches both the current honest reason and the historical "stale: unknown
 * posting date" label, so counts stay correct on databases written before the
 * mislabeling was fixed (and whether or not the relabel migration has run).
 * @param {object} job jobs-table row
 */
export function isUndatedDrop(job = {}) {
  return /unknown posting date/i.test(String(job.discard_reason ?? ''));
}

/**
 * Posting-age windows the UI OFFERS, in hours.
 *
 * This is a presentation list, NOT a gate. It used to be both, and that was a
 * standing trap: the filter applied the window only if the value appeared here,
 * so a server process running an older copy of this list silently returned the
 * FULL board under an active "Posted < 1 week ago" chip. The filter now honors
 * any positive window and fails closed on an unusable one, so the two halves
 * can no longer disagree in a way that shows unfiltered rows as filtered — see
 * the note at the `postedWithinHours` filter in `boardPage`.
 *
 * 3h/6h/24h answer "be first to apply". 72h/168h exist because on real data
 * they are where the jobs actually are: one measured run held 5 postings under
 * 24 hours old and 4,439 under a week, so a board capped at 24h looks empty
 * while a week's worth of live, applicable roles sits one click away.
 */
export const POSTED_WINDOWS = Object.freeze([3, 6, 24, 72, 168]);

/** Statuses considered "closed" — hidden from the default board. */
export const CLOSED_STATUSES = Object.freeze([
  APP_STATUS.ARCHIVED, APP_STATUS.REJECTED, APP_STATUS.DISCARDED,
]);
const CLOSED_SET = new Set(CLOSED_STATUSES);

/**
 * Jobs already applied to (or deliberately passed on). Not "closed" — they are
 * the Applications record — but no longer a DISCOVERY decision. The Jobs list
 * promises "every open job that matches your search", and with these left in,
 * its top slots were permanently held by jobs already applied to (BUG-08).
 * Hidden from the default Jobs list (`hideApplied`) and its "All jobs" count.
 */
export const APPLIED_STATUSES = Object.freeze([
  APP_STATUS.SUBMITTED, APP_STATUS.SUBMIT_UNVERIFIED, APP_STATUS.SKIPPED,
]);
const APPLIED_SET = new Set(APPLIED_STATUSES);

/**
 * When was this job's packet prepared? Prefers the true prepared_at stamp;
 * legacy rows (prepared before the column existed) fall back to updated_at
 * ONLY while the row still sits in `prepared` (any later action bumps
 * updated_at and would otherwise re-count an old packet as "prepared today").
 * @param {object} job jobs-table row
 * @returns {string|null} ISO timestamp
 */
function preparedAtOf(job) {
  if (!job.application_packet_path) return null;
  if (job.prepared_at) return job.prepared_at;
  return job.status === 'prepared' ? (job.updated_at ?? null) : null;
}

/**
 * The single source of truth for the section tabs. Each view is a predicate
 * over a decorated board row. Because the SAME predicates drive both the tab
 * COUNTS and the board FILTER, a tab's badge always equals the number of rows
 * shown when you click it (fixing the old "Ready to submit: 19" badge over a
 * board of 0 rows).
 */
/*
 * Membership sets for the view predicates below.
 *
 * These were inline `[...].includes(x)` array literals. Each predicate runs once
 * per job per stats build, so on real data (~102k rows) that allocated hundreds
 * of thousands of throwaway arrays per dashboard refresh purely to answer a
 * fixed membership question. Hoisted to module-level Sets: same answers, no
 * per-row allocation.
 */
const VIEW_TODAY_ACTIONABLE = new Set([
  APP_STATUS.READY_FOR_SUBMIT, APP_STATUS.SUBMIT_UNVERIFIED,
  APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED, APP_STATUS.NEEDS_REVIEW,
]);
const VIEW_UNTRIAGED = new Set([APP_STATUS.SCORED, APP_STATUS.DISCOVERED]);
const VIEW_BLOCKED = new Set([APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED]);

export const BOARD_VIEWS = Object.freeze({
  // "All jobs" on the Jobs list: open AND still a decision to make.
  all: (r) => !CLOSED_SET.has(r.appStatus) && !APPLIED_SET.has(r.appStatus),
  today: (r) => VIEW_TODAY_ACTIONABLE.has(r.appStatus)
    || (r.postedLast24h && r.fit === 'strong' && VIEW_UNTRIAGED.has(r.appStatus))
    || (r.sponsorshipGated && !CLOSED_SET.has(r.appStatus)),
  // "Best matches" = strong, recommended jobs still awaiting your triage. Once
  // you shortlist/prepare them they move to their stage tab, so this list never
  // overlaps the other tabs — it is purely "new strong opportunities to act on".
  best: (r) => r.fit === 'strong' && r.grade?.recommend === true
    && (r.appStatus === APP_STATUS.SCORED || r.appStatus === APP_STATUS.DISCOVERED),
  shortlisted: (r) => r.appStatus === APP_STATUS.SHORTLISTED,
  needs_review: (r) => r.appStatus === APP_STATUS.NEEDS_REVIEW,
  // "Ready to apply": packet approved (ready to auto-fill) OR already filled and
  // waiting for your manual submit. Both need a human action next.
  ready_apply: (r) => r.appStatus === APP_STATUS.APPROVED || r.appStatus === APP_STATUS.READY_FOR_SUBMIT,
  blocked: (r) => VIEW_BLOCKED.has(r.appStatus),
  // The Applications "Needs you" tab: stopped fills AND a submission nobody
  // confirmed. An unverified submit used to sit in no application tab at all,
  // though only you can verify it — and the workspace's "Needs you" column
  // holds both. `blocked` stays as it was: "Unblock applications" counts it.
  needs_you: (r) => VIEW_BLOCKED.has(r.appStatus) || r.appStatus === APP_STATUS.SUBMIT_UNVERIFIED,
  submitted: (r) => r.appStatus === APP_STATUS.SUBMITTED,
  // Archived jobs had no tab: they were reachable only through the status
  // dropdown, so archiving looked like deleting, with no visible way back. This
  // is the one view that shows CLOSED rows, so it is left out of OPEN_ONLY_VIEWS.
  archived: (r) => r.appStatus === APP_STATUS.ARCHIVED,
});

/**
 * [key, predicate] pairs for BOARD_VIEWS, computed once.
 * `Object.entries` inside a per-row loop rebuilt this whole structure for every
 * job on every stats build; BOARD_VIEWS is frozen, so once is enough.
 */
const BOARD_VIEW_ENTRIES = Object.entries(BOARD_VIEWS);

/**
 * Views whose predicate can NEVER match a closed (archived/rejected/discarded)
 * row, so a request scoped to one of them may read the cheap open-only base set
 * (see openBoardRows) instead of the whole table.
 *
 * Every view above except `archived` qualifies: each either tests `!CLOSED_SET.has(...)`
 * directly or matches only specific non-closed statuses. That is a property of
 * the predicates, not a promise about them — so `dashboardFilters` has a test
 * that drives every listed view against the full cartesian product of the fields
 * these predicates read, with each closed status in turn, and fails if any
 * combination matches. Add a view that can surface a closed row and either keep
 * it out of this set or that test will catch it.
 */
/** Views that exist to show CLOSED rows. Every view is in exactly one of these two sets. */
export const CLOSED_ROW_VIEWS = new Set(['archived']);
export const OPEN_ONLY_VIEWS = new Set(Object.keys(BOARD_VIEWS).filter((key) => !CLOSED_ROW_VIEWS.has(key)));

/** Count rows per board view (each equals what clicking that tab shows). */
export function countViews(rows = []) {
  const counts = {};
  for (const key of Object.keys(BOARD_VIEWS)) counts[key] = 0;
  for (const r of rows) {
    for (const [key, pred] of BOARD_VIEW_ENTRIES) {
      if (pred(r)) counts[key] += 1;
    }
  }
  return counts;
}

/**
 * Discovery sources that ARE a specific ATS platform, one-to-one — the
 * board's "Any ATS" dropdown lists exactly these names alongside the generic-
 * scraper-detected ones (icims/taleo/jobvite/generic).
 *
 * REGRESSION GUARD. `ats_platform` is populated only when the generic
 * careers-page adapter detects an embedded ATS widget on a scraped company
 * page — verified against the real database, it is set on 0.5% of rows (242
 * of 45,609). Every job from the DIRECT Workday/Greenhouse/Lever/Ashby/
 * SmartRecruiters adapters leaves it null, because `source` already says
 * exactly which ATS it is; nothing had ever cross-referenced the two. The
 * dropdown's own option list (workday/greenhouse/lever/ashby/smartrecruiters)
 * matches these source names exactly, so filtering by ATS silently returned
 * near-empty results for the vast majority of the corpus — e.g. "Workday"
 * matched 13 rows instead of the real ~15,800.
 */
const ATS_NATIVE_SOURCES = new Set(['workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters']);

/** Decorate one db row with all derived board fields. */
function boardRow(job, approval, now) {
  const matched = jsonList(job.matched_keywords);
  const missing = jsonList(job.missing_keywords);
  const appStatus = deriveAppStatus(job, approval);
  const score = typeof job.score === 'number' ? job.score : null;
  const haystack = `${job.location ?? ''} ${job.employment_type ?? ''} ${job.title ?? ''}`.toLowerCase();
  const locationSignal = usLocationSignal(job.location);
  const fit = fitBucket(job.tier, score, job.sponsorship ?? null);
  const attention = classifyAttention(job, appStatus);
  return {
    id: job.id,
    // Rows stored before names were cleaned still hold board tokens.
    company: job.company == null ? job.company : displayCompany(job.company),
    // Historical provider rows can be incomplete. Never render a blank role
    // name (which also produces unusable checkbox/button accessible names).
    title: String(job.title ?? '').trim() || 'Title not identified',
    location: job.location,
    url: job.url,
    source: job.source || 'unknown',
    score,
    grade: gradeFromScore(score, fit),
    tier: job.tier ?? null,
    fit,
    sponsorshipGated: isSponsorshipGated(job),
    sponsorship: job.sponsorship ?? null,
    // The prose the verdict was read from, so a human can check the badge
    // instead of trusting it.
    sponsorshipSignals: jsonList(job.sponsorship_signals),
    employmentType: job.employment_type ?? null,
    employmentCategory: job.employment_category ?? null,
    employmentLabel: EMPLOYMENT_LABELS[job.employment_category] ?? null,
    compensation: job.compensation_text ?? null,
    remote: /\bremote\b/.test(haystack),
    // Where the role actually is, resolved once here so the board filter, the
    // coverage stats, and any future column all read the SAME answer rather
    // than each re-deriving it. `usLocationSignal` already distinguishes a
    // spelled-out state from a bare two-letter code and refuses to read
    // "Berlin, DE" as Delaware, so this must not be reimplemented locally.
    state: locationSignal.state ?? null,
    stateName: locationSignal.stateName ?? null,
    postedAt: job.posted_at ?? null,
    postedLabel: formatPostedRelative(job.posted_at, now),
    postedLast24h: isWithinLast24Hours(job.posted_at, now),
    postedConfidence: postedConfidence(job),
    undatedDrop: isUndatedDrop(job),
    appStatus,
    progress: progressFor(appStatus),
    statusReason: explainStatus(job, appStatus, approval),
    attention,
    // The one human label for the status column (attention wins: "Needs
    // sign-in" says more than "blocked").
    statusLabel: attention?.label ?? APP_STATUS_LABELS[appStatus] ?? appStatus,
    lastAction: lastActionFor(job, appStatus),
    userDecision: job.user_decision ?? null,
    // Is the posting still open at its source (search/postingLiveness.js)?
    linkState: job.link_state ?? null,
    linkCheckedAt: job.link_checked_at ?? null,
    // Why the user rejected/archived it (DECISION_REASONS), or null.
    decisionReason: job.decision_reason ?? null,
    atsPlatform: job.ats_platform ?? (ATS_NATIVE_SOURCES.has(job.source) ? job.source : null),
    resumeStatus: resumeStatusOf(job),
    atsScore: job.ats_score == null || job.ats_score === '' ? null : Number(job.ats_score),
    atsBand: job.ats_band ?? null,
    explanation: job.explanation ?? null,
    discardReason: job.discard_reason ?? null,
    matchedKeywords: matched,
    missingKeywords: missing,
    assistFilledCount: typeof job.assist_filled_count === 'number' ? job.assist_filled_count : null,
    assistBlockers: jsonList(job.assist_blockers),
    approvalId: approval?.id ?? null,
    approvalStatus: approval?.approval_status ?? null,
    packetPath: job.application_packet_path ?? null,
    resumePath: job.resume_path ?? null,
    resumeDocxPath: job.resume_docx_path ?? job.resume_path ?? null,
    resumePdfPath: job.resume_pdf_path ?? null,
    coverLetterPath: job.cover_letter_path ?? null,
    notes: job.notes ?? null,
    // Which search produced this row. Present on every row so the UI can label
    // a role-search result rather than letting it pass as a personalized match.
    discoveryMode: job.discovery_mode ?? 'profile',
    searchQuery: job.search_query ?? null,
    submittedConfirmation: job.submitted_confirmation ?? null,
    appliedAt: job.applied_at ?? null,
    createdAt: job.created_at ?? null,
    updatedAt: job.updated_at ?? null,
  };
}

/**
 * Headline stats for the dashboard tiles + source/status breakdowns.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object} [options.config] supplies the candidate timezone
 * @param {boolean} [options.allowStale=false] serve a stale cached value at once
 *   (flagged `stale: true`) and recompute in the background — the server's
 *   mode; see cachedSwr
 * @returns {object}
 */
export function dashboardStats(db, { now = new Date(), config = null, allowStale = false } = {}) {
  const timeZone = candidateTimeZone(config);
  // The cache key must include the zone: the same instant belongs to different
  // calendar days in different zones, so a cached UTC-day answer must not be
  // served after the profile's timezone changes.
  return cachedSwr(db, `stats:${timeZone ?? 'utc'}`, now,
    () => computeDashboardStats(db, now, timeZone), { allowStale });
}

/** Sponsorship verdicts reported on their own, everything else is "unconfirmed". */
const SPONSORSHIP_OPEN_KEYS = Object.freeze({
  Confirmed: 'confirmed', Likely: 'likely', Unconfirmed: 'unconfirmed', Denied: 'denied',
});

function computeDashboardStats(db, now, timeZone = null) {
  // Narrow column projection where available (see db.listJobsForStats); test
  // stubs that only implement listJobsSummary/listJobs still work.
  const jobs = typeof db.listJobsForStats === 'function'
    ? db.listJobsForStats()
    : listSummaryRows(db);
  const approvals = approvalsByJob(db);
  const today = dayOf(now.toISOString(), timeZone);

  // Last 7 calendar days (oldest first) for the daily-progress strip.
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    days.push(dayOf(new Date(now.getTime() - i * 86_400_000).toISOString(), timeZone));
  }
  const daily = new Map(days.map((d) => [d, { day: d, discovered: 0, prepared: 0, submitted: 0 }]));

  const stats = {
    generatedAt: now.toISOString(),
    totals: {
      jobsTracked: jobs.length,
      discoveredToday: 0,
      discoveredLast24h: 0,
      postedLast24h: 0,
      postedLast7d: 0,
      strongFit: 0,
      mediumFit: 0,
      weakFit: 0,
      shortlisted: 0,
      rejected: 0,
      skipped: 0,
      dateUnconfirmed: 0,
      // Rows the freshness gate dropped ONLY because the source gave no
      // parseable posting date. These are not stale and not judged on fit —
      // they are unreviewed. Counted separately (and including closed rows,
      // since that is exactly where they land) so the volume is never hidden.
      undatedDropped: 0,
      preparedToday: 0,
      submittedToday: 0,
      submittedThisWeek: 0,
      qualifiedToday: 0,
      needsSponsorshipCheck: 0,
      pendingReview: 0,
      blocked: 0,
      readyForSubmit: 0,
      submitUnverified: 0,
      submittedTotal: 0,
      // Part of `blocked` whose cause is a missing Playwright browser.
      blockedSetup: 0,
    },
    // ISO timestamp of the most recent discovery (max created_at) so the UI can
    // show "last discovery Nh ago" — this explains a legitimate "0 discovered
    // today" when discovery simply has not run yet today.
    lastDiscoveryAt: null,
    bySource: {},
    byStatus: {},
    // sponsorship status -> { count, strong } so feasibility is visible at a glance
    bySponsorship: {},
    // Actionable rows only — see the loop. `notEvaluated` = no verdict recorded.
    sponsorshipOpen: { confirmed: 0, likely: 0, unconfirmed: 0, denied: 0, notEvaluated: 0 },
    // USPS code -> { count, strong }. Makes nationwide coverage VERIFIABLE
    // rather than assumed: the searches say "United States", and this says
    // which states actually came back. A gap here is a real coverage gap.
    byState: {},
    daily: [],
    nextActions: [],
    // Section-tab counts — derived from the SAME predicates the board filters by,
    // so each tab badge equals exactly what clicking it shows.
    views: Object.fromEntries(Object.keys(BOARD_VIEWS).map((k) => [k, 0])),
  };

  for (const job of jobs) {
    const approval = approvals.get(job.id) ?? null;
    const status = deriveAppStatus(job, approval);
    const fit = fitBucket(
      job.tier,
      typeof job.score === 'number' ? job.score : null,
      job.sponsorship ?? null,
    );
    const source = job.source || 'unknown';
    /*
     * Values reused several times below, each computed ONCE per row.
     *
     * These were recomputed at every use site: `postedLast24h` three times,
     * `applied`/`isOpen` five and six times, and each of them parses a date or
     * walks a Set. Multiplied by the whole jobs table (~102k rows on real data)
     * that repetition was a large part of why a single dashboard refresh
     * blocked the event loop for seconds. Same expressions, evaluated once.
     */
    const isOpen = !CLOSED_SET.has(status);
    const applied = Number(job.applied) === 1;
    const postedLast24h = isWithinLast24Hours(job.posted_at, now);
    const createdDay = dayOf(job.created_at, timeZone);
    const gated = isSponsorshipGated(job);

    if (createdDay === today) stats.totals.discoveredToday += 1;
    if (isWithinLast24Hours(job.created_at, now)) stats.totals.discoveredLast24h += 1;
    if (job.created_at && (!stats.lastDiscoveryAt || job.created_at > stats.lastDiscoveryAt)) {
      stats.lastDiscoveryAt = job.created_at;
    }
    // Posted-in-last-24h counts ACTIONABLE jobs only (not discarded/closed) so
    // the header chip always reconciles with what the board's "last 24h"
    // filter shows — a big raw count over a mostly-hidden board reads as a bug.
    if (postedLast24h && isOpen) stats.totals.postedLast24h += 1;
    // The week window matters more than it looks: on real data the 24h count
    // is routinely single digits while a week holds hundreds of live roles, so
    // a board that only offers 24h reads as "nothing to apply to today".
    // Counted on the same actionable basis so its chip also reconciles.
    if (isOpen && isWithinLastHours(job.posted_at, 168, now)) stats.totals.postedLast7d += 1;
    // Fit tiles count ACTIONABLE jobs only (not archived/rejected/discarded) so
    // clicking a tile shows exactly as many rows as the tile promised — the
    // default board hides closed jobs.
    if (isOpen) {
      if (fit === 'strong') stats.totals.strongFit += 1;
      if (fit === 'medium') stats.totals.mediumFit += 1;
      if (fit === 'weak') stats.totals.weakFit += 1;
      // Strong-fit roles parked by the sponsorship gate: the next action is to
      // verify the employer's sponsorship posture, not to discard the job.
      if (gated) stats.totals.needsSponsorshipCheck += 1;
    }
    if (job.user_decision === 'shortlisted') stats.totals.shortlisted += 1;
    if (status === APP_STATUS.REJECTED) stats.totals.rejected += 1;
    if (status === APP_STATUS.SKIPPED) stats.totals.skipped += 1;
    if (status === APP_STATUS.DATE_UNCONFIRMED) stats.totals.dateUnconfirmed += 1;
    // REGRESSION GUARD. This used to count isUndatedDrop() alone, but the
    // tile's own declared click-filter is `{ undated: true }` — the SAME
    // broader filter the separate "Date unknown" checkbox uses, which also
    // matches postedConfidence === 'unconfirmed' (see boardPage below). That
    // catches live scored/needs_review jobs that simply lack a confirmed
    // date, not just ones actually held back for it. Verified live: 2 such
    // jobs (status: scored, needs_review) inflated the filter's row count
    // 2 past what this stat reported — the same "tile promises a number
    // clicking it doesn't open" bug as everywhere else in this file.
    if (isUndatedDrop(job) || postedConfidence(job) === 'unconfirmed') stats.totals.undatedDropped += 1;
    if (!applied && dayOf(preparedAtOf(job), timeZone) === today) stats.totals.preparedToday += 1;
    if (applied && dayOf(job.applied_at, timeZone) === today) stats.totals.submittedToday += 1;
    if (applied && job.applied_at
        && (now.getTime() - new Date(job.applied_at).getTime()) < 7 * 86_400_000) {
      stats.totals.submittedThisWeek += 1;
    }
    // "New qualified" means the POSTING is genuinely fresh, not merely that
    // an older job happened to enter our database today.
    if (fit === 'strong' && postedLast24h && isOpen) {
      stats.totals.qualifiedToday += 1;
    }
    if (status === APP_STATUS.NEEDS_REVIEW) stats.totals.pendingReview += 1;
    if (VIEW_BLOCKED.has(status)) stats.totals.blocked += 1;
    if (status === APP_STATUS.READY_FOR_SUBMIT) stats.totals.readyForSubmit += 1;
    if (status === APP_STATUS.SUBMIT_UNVERIFIED) stats.totals.submitUnverified += 1;
    if (applied) stats.totals.submittedTotal += 1;

    let bySource = stats.bySource[source];
    if (!bySource) {
      bySource = { found: 0, strong: 0, prepared: 0, submitted: 0 };
      stats.bySource[source] = bySource;
    }
    bySource.found += 1;
    if (fit === 'strong') bySource.strong += 1;
    if (job.application_packet_path) bySource.prepared += 1;
    if (applied) bySource.submitted += 1;

    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;

    // Section-tab counts via the shared board-view predicates.
    const viewRow = {
      appStatus: status,
      fit,
      grade: gradeFromScore(typeof job.score === 'number' ? job.score : null, fit),
      postedLast24h,
      sponsorshipGated: gated,
    };
    for (const [key, pred] of BOARD_VIEW_ENTRIES) {
      if (pred(viewRow)) stats.views[key] += 1;
    }

    // The same verdicts over ACTIONABLE rows only (open and not yet submitted).
    // `bySponsorship` counts the whole table, which is ~97% discarded rows, so
    // its "Unconfirmed" figure described the discard pile, not the jobs a user
    // could still apply to. Rows never classified are `notEvaluated`, apart.
    if (isOpen && !applied) {
      const openKey = SPONSORSHIP_OPEN_KEYS[job.sponsorship];
      if (openKey) stats.sponsorshipOpen[openKey] += 1;
      else stats.sponsorshipOpen.notEvaluated += 1;
    }

    const spon = job.sponsorship ?? 'Unclassified';
    let bySpon = stats.bySponsorship[spon];
    if (!bySpon) {
      bySpon = { count: 0, strong: 0 };
      stats.bySponsorship[spon] = bySpon;
    }
    bySpon.count += 1;
    if (fit === 'strong') bySpon.strong += 1;

    // Where the jobs actually are. Remote-only and unnamed locations carry no
    // state, and are counted as such rather than guessed at.
    if (isOpen) {
      const signal = usLocationSignal(job.location);
      const key = signal.state ?? (signal.isUs ? 'US' : 'unknown');
      let byState = stats.byState[key];
      if (!byState) {
        byState = { count: 0, strong: 0, name: signal.stateName ?? (key === 'US' ? 'Nationwide / remote' : 'Not stated') };
        stats.byState[key] = byState;
      }
      byState.count += 1;
      if (fit === 'strong') byState.strong += 1;
    }

    // Daily progress strip. `daily` only ever holds the last 7 days, so the
    // has()/get() pairs are cheap; reuse createdDay from above.
    const createdBucket = daily.get(createdDay);
    if (createdBucket) createdBucket.discovered += 1;
    const preparedDay = dayOf(preparedAtOf(job), timeZone);
    if (preparedDay) {
      const preparedBucket = daily.get(preparedDay);
      if (preparedBucket) preparedBucket.prepared += 1;
    }
    if (applied) {
      const submittedBucket = daily.get(dayOf(job.applied_at, timeZone));
      if (submittedBucket) submittedBucket.submitted += 1;
    }
  }

  stats.daily = [...daily.values()];
  // "Are we really searching the whole country?" answered with data, not a
  // promise: how many distinct states the open board actually covers.
  const statesSeen = Object.keys(stats.byState).filter((key) => key !== 'US' && key !== 'unknown');
  stats.coverage = {
    statesCovered: statesSeen.length,
    statesPossible: US_STATE_COUNT,
    nationwide: stats.byState.US?.count ?? 0,
    unstated: stats.byState.unknown?.count ?? 0,
  };
  // The untriaged-strong action opens the Best matches view, so it must be
  // COUNTED by that view's predicate. Keeping a second, slightly different
  // predicate here is how the sentence and the board came to disagree.
  // Of the blocked total, how many are the SAME setup problem (no browser).
  // They are counted apart so the action plan says "install the browser"
  // once instead of "N applications need a login or CAPTCHA".
  applyApplicationScope(stats, db, now);
  try {
    stats.totals.blockedSetup = (db.listAttentionBlockers?.() ?? [])
      .filter((row) => isEnvironmentFailure(row)).length;
  } catch { stats.totals.blockedSetup = 0; }
  stats.nextActions = buildNextActions(stats.totals, stats.views.best);
  return stats;
}

/**
 * Concrete "do this next" guidance, ordered by impact. Each action carries the
 * board filter that shows exactly those jobs.
 * @returns {Array<{ text: string, filter: object|null }>}
 */
export function buildNextActions(totals, strongUntriaged = 0) {
  const actions = [];
  /*
   * Each entry carries BOTH a full sentence and its parts.
   *
   * `text` is the whole guidance in one line — it stays because it is the
   * accessible description and because callers already read it. The parts exist
   * because the panel that renders these was a wall of six identical blue
   * sentences: the count, which is the only scannable thing in each, sat buried
   * mid-sentence in link-coloured prose, and the ORDER of this array — which is
   * a real priority ranking, submit-unverified before ready-to-submit before
   * approvals — was flattened away by rendering every item the same.
   *
   * `verb` is deliberately imperative and short. The stage tabs above the board
   * are NOUNS ("Needs review", "Needs you"); four of these actions point at the
   * very same queues, so saying "Approve prepared packets" rather than
   * "179 prepared packet(s) await your approval" is what stops this panel from
   * being a third restatement of the same counts in a third visual language.
   *
   * `kind: 'system'` marks a notice about the TOOL rather than a queue of jobs,
   * so the renderer can keep it out of the ranked list where it does not belong.
   */
  const add = ({ count, verb, detail, text, filter, kind = 'job' }) => {
    actions.push({ text: text ?? `${count} ${detail}`, count: count ?? null, verb, detail, filter, kind });
  };

  // Unverified auto-submits come first: until confirmed, the job is neither
  // safely "submitted" nor safe to re-fill — only the human can resolve it.
  if (totals.submitUnverified > 0) {
    add({
      count: totals.submitUnverified,
      verb: 'Confirm auto-submits',
      detail: 'check your email for the ATS confirmation, then Mark submitted (or finish manually)',
      text: `${totals.submitUnverified} auto-submit(s) could not be confirmed, check your email for the ATS `
        + 'confirmation, then Mark submitted (or finish manually)',
      filter: { appStatus: APP_STATUS.SUBMIT_UNVERIFIED },
    });
  }
  if (totals.readyForSubmit > 0) {
    add({
      count: totals.readyForSubmit,
      verb: 'Submit filled applications',
      detail: 'review each browser tab and click Submit yourself',
      text: `${totals.readyForSubmit} application(s) are filled and waiting, review each browser tab and click Submit yourself`,
      filter: { appStatus: APP_STATUS.READY_FOR_SUBMIT },
    });
  }
  if (totals.pendingReview > 0) {
    add({
      count: totals.pendingReview,
      verb: 'Approve prepared packets',
      detail: 'read the tailored resume, then approve it for auto-fill',
      text: `${totals.pendingReview} prepared packet(s) await your approval`,
      filter: { appStatus: APP_STATUS.NEEDS_REVIEW },
    });
  }
  // A missing browser is ONE fix for the machine, not N walls on N sites. It
  // used to be counted inside "Unblock applications" and described as "a
  // login, CAPTCHA or unanswered question", which is exactly what it is not.
  const setup = Math.min(Number(totals.blockedSetup ?? 0), Number(totals.blocked ?? 0));
  if (setup > 0 && browserRecovered()) {
    add({
      count: setup,
      verb: SETUP_BROWSER_RECOVERED_LABEL,
      detail: 'these failed only because the browser was missing; it is installed now',
      text: `${setup} auto-fill(s) failed only because the browser was missing — it is installed now, retry them`,
      filter: { view: 'blocked' },
      kind: 'system',
    });
  } else if (setup > 0) {
    add({
      count: setup,
      verb: SETUP_BROWSER_LABEL,
      detail: 'auto-fill cannot start until it is installed: npx playwright install chromium',
      text: `${setup} auto-fill(s) could not start because the Playwright browser is not installed — run `
        + '"npx playwright install chromium", then retry',
      filter: { view: 'blocked' },
      kind: 'system',
    });
  }
  const walls = Number(totals.blocked ?? 0) - setup;
  if (walls > 0) {
    add({
      count: walls,
      verb: 'Unblock applications',
      detail: 'a login, CAPTCHA or unanswered question stopped the fill',
      text: `${walls} application(s) are blocked (login / CAPTCHA / unanswered questions) and need you`,
      // totals.blocked counts blocked + failed + cancelled, so this must open
      // the "Needs you" VIEW. Filtering on appStatus: blocked alone showed
      // fewer rows than the sentence promised.
      filter: { view: 'blocked' },
    });
  }
  if (strongUntriaged > 0) {
    add({
      count: strongUntriaged,
      verb: 'Decide on strong fits',
      detail: 'shortlist the ones worth pursuing, reject the rest',
      text: `${strongUntriaged} strong-fit job(s) have no decision yet, shortlist or reject them`,
      // "No decision yet" is exactly the Best matches view. The old
      // { fit: 'strong' } filter also showed every strong job already
      // shortlisted, prepared, or submitted, so the board returned far more
      // rows than the count.
      filter: { view: 'best' },
    });
  }
  if (totals.needsSponsorshipCheck > 0) {
    add({
      count: totals.needsSponsorshipCheck,
      verb: 'Verify sponsorship',
      detail: "check the employer's careers page and past H-1B filings, then shortlist and prepare",
      text: `${totals.needsSponsorshipCheck} strong-fit job(s) only need a sponsorship check, verify the employer `
        + 'sponsors H-1B (their careers page, past filings), then shortlist and prepare',
      // The count is isSponsorshipGated(); the board has a filter for exactly
      // that. Matching on sponsorship: 'Unconfirmed' both missed gated rows
      // classified differently and included ungated ones.
      filter: { sponsorshipGated: true },
    });
  }
  if (totals.dateUnconfirmed > 0) {
    add({
      count: totals.dateUnconfirmed,
      verb: 'Confirm posting dates',
      detail: 'the source gave no confirmed date, so these were held back',
      text: `${totals.dateUnconfirmed} job(s) have no confirmed posting date, review them manually`,
      filter: { appStatus: APP_STATUS.DATE_UNCONFIRMED },
    });
  }
  // Only nudge to re-run discovery when nothing has been found in the last 24h.
  // A plain "0 discovered today" right after midnight is normal and not worth a
  // warning (this avoids the confusing "0 discovered today" vs "many posted
  // last 24h" mismatch users saw).
  if ((totals.discoveredLast24h ?? totals.discoveredToday) === 0) {
    add({
      count: null,
      verb: 'Find new jobs',
      detail: 'nothing new has been found in the last 24 hours',
      text: 'No new jobs found in the last 24h, run Discover (or Find & Prepare) to refresh the board',
      filter: null,
      kind: 'system',
    });
  }
  return actions;
}

/** Allowed sort keys -> comparators (descending by default where sensible). */
/**
 * EVERY SORT ENDS IN `id`.
 *
 * Without a tiebreaker these comparators leave rows with equal keys in
 * whatever order the underlying query happened to return — and on real data
 * ties are the norm, not the exception: 111,108 rows share a few dozen distinct
 * scores. A stable sort over an unstable input is not a stable order, so two
 * requests for consecutive pages could return the same row twice and never show
 * another. It also has to match the ORDER BY that SQLite applies on the paged
 * fast path (SUMMARY_PAGE_ORDERS in src/logging/db.js), or the same view would
 * show different rows depending on which path served it — caught by a
 * differential check between the two paths.
 */
const byId = (a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''));
const thenById = (compare) => (a, b) => compare(a, b) || byId(a, b);

const SORTS = {
  score: thenById((a, b) => (b.score ?? -1) - (a.score ?? -1)),
  posted: thenById((a, b) => String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? ''))),
  company: thenById((a, b) => String(a.company ?? '').localeCompare(String(b.company ?? ''))),
  updated: thenById((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))),
  // WHEN WE FIRST SAW IT, which is not the same question as when it was posted.
  // Without this there was no way to answer "what did the last run actually
  // find?": new rows were interleaved by score across ~100k others, so a run
  // that added thousands of postings looked identical to one that added none.
  // `createdAt` is set on insert and deliberately never updated on
  // re-discovery, so it is a true first-seen timestamp.
  discovered: thenById((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))),
};

/**
 * Filterable, sortable job list for the board.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [filters]
 * @param {string} [filters.q] free-text match on company/title/location
 * @param {string} [filters.fit] strong|medium|weak|no_fit|unscored
 * @param {string} [filters.appStatus] APP_STATUS value
 * @param {string} [filters.source]
 * @param {string} [filters.sponsorship]
 * @param {string} [filters.employmentType] full_time|contract|contract_to_hire|part_time|unknown
 * @param {number|string} [filters.postedWithinHours] only roles posted within
 *   the last N hours. Any positive number is honored (POSTED_WINDOWS lists what
 *   the UI offers, but is NOT a gate — see the note at the filter itself).
 * @param {string} [filters.state] two-letter US state code, or 'REMOTE'
 * @param {string} [filters.city] case-insensitive substring of the location only
 * @param {boolean} [filters.last24h] legacy alias for postedWithinHours=24
 * @param {boolean} [filters.hideClosed] hide archived/rejected/discarded (default true)
 * @param {boolean} [filters.includeClosed] the "tracked" tile's own name for
 *   the same switch, inverted — `includeClosed: true` means `hideClosed: false`.
 *   Accepted as an alias so that tile's filter object actually does what its
 *   own label says (see the REGRESSION note on the `hideClosed` line below).
 * @param {string} [filters.sort=score] score|posted|company|updated
 * @param {number} [filters.limit=200]
 * @param {Date} [filters.now]
 * @returns {object[]} decorated board rows
 */
export function listBoardJobs(db, filters = {}) {
  return boardPage(db, filters).jobs;
}

/**
 * Same filters as listBoardJobs, but returns the page WITH the uncapped match
 * count, so the UI can say "Showing 200 of 1,431" instead of silently
 * truncating (the tab badges count ALL matches, so the board must too).
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [filters] see listBoardJobs
 * @returns {{ jobs: object[], total: number, limit: number }}
 */

/**
 * Every filter key that narrows the board. Listed exhaustively and checked
 * against the request, because the fast path below is only sound when NONE of
 * them is present — a key omitted here would be silently ignored on that path
 * and the user would get an unfiltered board under an active filter chip,
 * which is the exact failure the `postedWithinHours` note warns about.
 */
const BOARD_FILTER_KEYS = Object.freeze([
  'q', 'fit', 'appStatus', 'source', 'sponsorship', 'employmentType', 'ats',
  'resumeStatus', 'sponsorshipGated', 'qualifiedToday', 'submittedThisWeek',
  'undated', 'state', 'city', 'remote', 'last24h', 'postedWithinHours', 'view',
]);

/**
 * The whole table, one page, no predicates — served straight from SQLite.
 *
 * Returns null whenever the full in-memory pipeline is needed, which is any of:
 *   - a filter or section view is active (a predicate could reject a row);
 *   - closed rows are being hidden (that predicate reads a DERIVED field, so
 *     the rows have to be decorated before it can run);
 *   - tab badges were asked for (counted across the whole filtered set);
 *   - the sort is one SQLite cannot reproduce exactly (see SUMMARY_PAGE_ORDERS);
 *   - the db is a stub without the paged read (tests).
 *
 * @returns {{jobs: object[], total: number, limit: number, offset: number,
 *            page: number, pages: number}|null}
 */
function unfilteredWholeTablePage(db, filters, now, { closedPossible, scope = discoveryScope() }) {
  if (!closedPossible) return null; // the hide-closed pass needs decorated rows
  if (filters.withViewCounts === true || filters.withViewCounts === 'true') return null;
  for (const key of BOARD_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== '' && value !== false && value !== 'false') return null;
  }
  if (typeof db.listJobsSummaryPage !== 'function' || typeof db.countJobs !== 'function') return null;

  const sort = filters.sort ?? 'score';
  const { limit, offset } = pageWindow(filters);
  let page;
  try { page = db.listJobsSummaryPage({ orderBy: sort, limit, offset, mode: scope.mode, query: scope.query }); }
  catch { return null; } // unsupported sort (e.g. company) — use the full path
  const total = db.countJobs({ mode: scope.mode, query: scope.query });
  const approvals = approvalsByJob(db);
  return {
    jobs: page.map((job) => boardRow(job, approvals.get(job.id) ?? null, now)),
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** Largest board page served. */
export const MAX_PAGE_LIMIT = 500;

/**
 * `fields=board`: exactly what the board table (app.js `rowFor`, `nameCellFor`,
 * the pager and the selection/undo state) reads, and nothing else.
 *
 * A default row carries ~45 fields, including the explanation prose and both
 * keyword arrays that only the detail rail shows; measured live, a 100-row page
 * was 208,699 bytes. The detail rail fetches /api/jobs/:id for itself, so the
 * table needs none of that. The default response is unchanged.
 */
export const BOARD_FIELDS = Object.freeze([
  'id', 'title', 'company', 'location', 'url', 'remote', 'source', 'score', 'grade', 'fit', 'tier',
  'appStatus', 'statusLabel', 'statusReason', 'attention', 'progress',
  'sponsorship', 'sponsorshipGated', 'sponsorshipSignals',
  'postedAt', 'postedLabel', 'postedLast24h', 'postedConfidence', 'createdAt',
  'resumeStatus', 'resumeDocxPath', 'resumePdfPath', 'atsPlatform', 'employmentCategory', 'employmentLabel',
  'discoveryMode', 'searchQuery', 'userDecision', 'decision', 'decisionReason', 'applied',
  'linkState', 'linkCheckedAt',
  // A compact, explainable fit summary for the row: how many of the posting's
  // asked-for skills the profile evidences, and the first few by name. The
  // full lists stay detail-only, so a 500-row page does not carry them.
  'skillMatch',
]);

/**
 * A row's matched / missing skill terms, minus terms that are part of the
 * role's own title ("Data Engineer" on a Data Engineer posting). Those are
 * title fit, scored separately; counting them as skills inflated "9 of 14
 * skills" with job names.
 */
function titleFreeSkills(row) {
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
  const title = ` ${norm(row.title)} `;
  const keep = (term) => !title.includes(` ${norm(term)} `);
  const missing = (row.missingKeywords ?? []).filter(keep);
  // Listed as both found and missing = not evidenced in the resume.
  const gaps = new Set(missing.map(norm));
  return { matched: (row.matchedKeywords ?? []).filter((t) => keep(t) && !gaps.has(norm(t))), missing };
}

/** How many skills matched / were missing, plus the top matches by name. */
export function skillMatchOf(row) {
  const { matched, missing } = titleFreeSkills(row);
  if (!matched.length && !missing.length) return null;
  return { matched: matched.length, missing: missing.length, top: matched.slice(0, 3) };
}

/** Project one decorated row onto BOARD_FIELDS. */
export function boardProjection(row) {
  const out = {};
  for (const key of BOARD_FIELDS) {
    if (key === 'decision') out.decision = row.userDecision ?? null;
    else if (key === 'applied') out.applied = row.appStatus === APP_STATUS.SUBMITTED;
    else if (key === 'skillMatch') out.skillMatch = skillMatchOf(row);
    else out[key] = row[key] ?? null;
  }
  return out;
}

/** The requested page window, from `limit` plus either `offset` or `page`. */
function pageWindow(filters) {
  // Capped: `?limit=100000` from a query string serialized the whole decorated
  // board into one multi-megabyte response on a single-threaded server.
  const limit = Number(filters.limit) > 0 ? Math.min(Math.floor(Number(filters.limit)), MAX_PAGE_LIMIT) : 200;
  const requestedOffset = Number(filters.offset);
  const requestedPage = Number(filters.page);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? Math.floor(requestedOffset)
    : (Number.isFinite(requestedPage) && requestedPage > 1
      ? (Math.floor(requestedPage) - 1) * limit
      : 0);
  return { limit, offset };
}

export function boardPage(db, filters = {}) {
  const page = boardPageRows(db, filters);
  if (filters.fields !== 'board') return page;
  return { ...page, jobs: page.jobs.map(boardProjection), fields: 'board' };
}

function boardPageRows(db, filters = {}) {
  const now = filters.now ?? new Date();
  // REGRESSION GUARD. The "tracked" stat tile's own declared filter is
  // `{ includeClosed: true }` (app.js HEALTH_FACTS) — a key this function
  // never recognized. It was silently dropped, so clicking "45,609 tracked"
  // opened the same ~1,853 open-only rows as the default board, not the tile's
  // own promised total: the exact "count doesn't match what clicking it opens"
  // class of bug this file's other filters were already built to prevent.
  // `includeClosed: true` takes precedence when present, since it is the more
  // specific ask; an explicit `hideClosed` still works for every existing caller.
  const includeClosedTrue = filters.includeClosed === true || filters.includeClosed === 'true';
  const hideClosed = !includeClosedTrue
    && filters.hideClosed !== false && filters.hideClosed !== 'false';

  // Whether the hide-closed pass at the bottom of this function will actually
  // run. When it will, no closed row can survive into the response, so the
  // cheap base set (which pre-drops provably-discarded rows in SQL) is exactly
  // equivalent to the full one — and ~48x smaller on real data. Kept as ONE
  // expression used in both places so the two can never disagree; if they did,
  // a request would silently lose rows it was supposed to show.
  const undatedRequested = filters.undated === true || filters.undated === 'true';
  const willHideClosed = hideClosed && !filters.appStatus && !filters.view && !undatedRequested;

  /*
   * Can a closed row reach the response at all? If not, the cheap base set (which
   * pre-drops provably-discarded rows in SQL) is exactly equivalent to the full
   * table and ~48x smaller on real data.
   *
   * Three independent ways closed rows are ruled out:
   *   - the hide-closed pass below will run;
   *   - an explicit appStatus filter names a NON-closed status, so only that
   *     status survives;
   *   - a section view is requested whose predicate cannot match a closed row.
   * Anything else (includeClosed, hideClosed:false, `undated`, or an appStatus
   * that IS closed — the "tracked"/"Date unknown"/Rejected paths) genuinely needs
   * the whole table and pays for it.
   */
  const appStatusExcludesClosed = Boolean(filters.appStatus) && !CLOSED_SET.has(filters.appStatus);
  const viewExcludesClosed = Boolean(filters.view) && OPEN_ONLY_VIEWS.has(filters.view);
  const closedPossible = !willHideClosed && !appStatusExcludesClosed && !viewExcludesClosed;

  /*
   * THE UNFILTERED WHOLE-TABLE PAGE, ANSWERED BY SQLITE.
   *
   * Everything below this point reads DECORATED rows, so it needs every row
   * decorated before it can drop any — and on the "all jobs" view there is
   * nothing to drop. Measured on a 111,108-row table: 5.8 s of blocked event
   * loop and ~640 MB resident to return 100 rows, of which 0.8 s was the read
   * and the rest was decorating 111,008 rows that were then thrown away. This
   * server is single-threaded, so for those seconds it answers nothing else —
   * including the request that cancels a run.
   *
   * When no predicate below can reject a row, the page is just ORDER BY +
   * LIMIT, which SQLite does from an index. Only the rows actually returned are
   * decorated. Anything with a filter, a view, or tab badges falls through to
   * the full pipeline unchanged.
   */
  // WHICH SEARCH'S ROWS THIS PAGE IS ABOUT. Defaults to the personalized board,
  // so every existing caller — and every request that says nothing — keeps
  // seeing exactly what "Find New Jobs" produced and nothing a role search did.
  const scope = discoveryScope(filters);

  const fastPage = unfilteredWholeTablePage(db, filters, now, { closedPossible, scope });
  if (fastPage) return fastPage;

  let rows = closedPossible ? allBoardRows(db, now, scope) : openBoardRows(db, now, scope);

  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    rows = rows.filter((r) => [r.company, r.title, r.location]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
  }
  // NOTE: the section-tab view is applied at the END of this pipeline, not
  // here. Every filter is a conjunctive predicate so the surviving set is
  // identical either way, but applying the view last leaves a row set that has
  // every OTHER filter applied — which is exactly what the tab badges have to
  // be counted against once filters and tabs can be combined.
  if (filters.fit) rows = rows.filter((r) => r.fit === filters.fit);
  if (filters.appStatus) rows = rows.filter((r) => r.appStatus === filters.appStatus);
  if (filters.source) rows = rows.filter((r) => r.source === filters.source);
  if (filters.sponsorship) rows = rows.filter((r) => r.sponsorship === filters.sponsorship);
  if (filters.employmentType) rows = rows.filter((r) => (r.employmentCategory ?? 'unknown') === filters.employmentType);
  if (filters.ats) rows = rows.filter((r) => (r.atsPlatform ?? 'unknown') === filters.ats);
  if (filters.resumeStatus) rows = rows.filter((r) => r.resumeStatus === filters.resumeStatus);
  if (filters.sponsorshipGated === true || filters.sponsorshipGated === 'true') {
    rows = rows.filter((r) => r.sponsorshipGated);
  }
  // Mirrors stats.totals.qualifiedToday exactly: strong fit whose POSTING is
  // genuinely fresh (posted within the last 24h) — never an old job that
  // merely entered the database today. The default hideClosed pass below
  // supplies the same closed-set exclusion, so clicking the metric always
  // shows precisely the counted records.
  if (filters.qualifiedToday === true || filters.qualifiedToday === 'true') {
    rows = rows.filter((r) => r.fit === 'strong' && r.postedLast24h);
  }
  if (filters.submittedThisWeek === true || filters.submittedThisWeek === 'true') {
    rows = rows.filter((r) => r.appStatus === APP_STATUS.SUBMITTED && r.appliedAt
      && (now.getTime() - new Date(r.appliedAt).getTime()) < 7 * 86_400_000);
  }
  // Jobs held back only because their posting date was unreadable. Closed rows
  // are intentionally in scope: that is precisely where the freshness gate put
  // them, so the filter must reach past the default hide-closed pass.
  if (filters.undated === true || filters.undated === 'true') {
    rows = rows.filter((r) => r.undatedDrop || r.postedConfidence === 'unconfirmed');
  }
  // Location. `state` matches the resolved two-letter code (so "TX" never
  // matches a Texas-shaped substring of a company name), while `city` is a
  // free-text contains against the location string only — deliberately NOT the
  // company/title, so searching "Phoenix" cannot surface a Phoenix Technologies
  // role in Boston. The broad `q` search above still spans all three fields for
  // people who want that.
  if (filters.state) {
    const want = String(filters.state).trim().toUpperCase();
    rows = want === 'REMOTE'
      ? rows.filter((r) => r.remote)
      : rows.filter((r) => r.state === want);
  }
  if (filters.city) {
    const want = String(filters.city).trim().toLowerCase();
    if (want) rows = rows.filter((r) => String(r.location ?? '').toLowerCase().includes(want));
  }
  if (filters.remote === true || filters.remote === 'true') rows = rows.filter((r) => r.remote);
  if (filters.last24h === true || filters.last24h === 'true') {
    rows = rows.filter((r) => r.postedLast24h);
  }
  // REGRESSION GUARD — SILENT FILTER DROP.
  //
  // This used to apply the window only when the value appeared in the
  // POSTED_WINDOWS allowlist, and do NOTHING otherwise. Anything the running
  // server did not recognise therefore returned the FULL, UNFILTERED board
  // while the UI still showed an active "Posted < 1 week ago" chip — the
  // filter looked applied and simply was not.
  //
  // Observed in production exactly as designed-for-failure: a dashboard server
  // process started before `168` was added to the allowlist kept serving the
  // old list, so selecting "1w" listed month-old postings under a chip that
  // claimed to be showing the last week. A stale process is ordinary (Node
  // does not hot-reload edited source, and this server runs for days), so an
  // allowlist shared between two independently-deployed halves is a standing
  // trap, not a one-off.
  //
  // The allowlist bought nothing: `isWithinLastHours` already validates and
  // rejects non-positive/non-finite input, and there is nothing unsafe about
  // an arbitrary hour count. So honor ANY usable positive window, and make an
  // UNUSABLE one fail closed (match nothing) rather than open (match
  // everything) — a visibly empty board is an honest error, silently showing
  // every row under an active filter chip is not. POSTED_WINDOWS remains the
  // single source of truth for what the UI OFFERS; it is no longer a gate on
  // what the server will HONOR.
  if (filters.postedWithinHours !== undefined && filters.postedWithinHours !== '') {
    const hours = Number(filters.postedWithinHours);
    rows = Number.isFinite(hours) && hours > 0
      ? rows.filter((r) => isWithinLastHours(r.postedAt, hours, now))
      : [];
  }
  // Hide closed jobs by default — but never override an explicit status/view
  // request (e.g. the Blocked/Submitted tabs, or a "rejected" status filter).
  if (willHideClosed) {
    rows = rows.filter((r) => !CLOSED_SET.has(r.appStatus));
    // The Jobs list (not Applications) also leaves out what was already applied
    // to; the "All jobs" tab count (BOARD_VIEWS.all) says the same.
    if (filters.hideApplied === true || filters.hideApplied === 'true') {
      rows = rows.filter((r) => !APPLIED_SET.has(r.appStatus));
    }
  }

  /*
   * Tab badges, counted against everything EXCEPT the tab itself.
   *
   * A tab badge promises "this many rows if you click me". While filters reset
   * the tab that promise was trivially true. Now that a filter narrows WITHIN a
   * tab, the unfiltered count would claim 179 while the board showed 154, and
   * every other tab's badge would be wrong the moment you clicked it.
   *
   * Only computed when asked for, because the caller only needs it when a
   * filter is actually active — otherwise `/api/stats` already has these and
   * this would be up to 8 predicate passes over the whole table for nothing.
   */
  let viewCounts;
  if (filters.withViewCounts === true || filters.withViewCounts === 'true') {
    viewCounts = {};
    for (const [key, predicate] of BOARD_VIEW_ENTRIES) {
      let n = 0;
      for (const row of rows) if (predicate(row)) n += 1;
      viewCounts[key] = n;
    }
  }

  // Applied last — see the note above the other filters.
  // Object.hasOwn: `view=__proto__` used to index the prototype and 500.
  if (filters.view && Object.hasOwn(BOARD_VIEWS, filters.view)) {
    rows = rows.filter(BOARD_VIEWS[filters.view]);
  }

  // `rows` may still be the exact array `allBoardRows` cached (no filter above
  // reassigned it, e.g. the "tracked" tile's `includeClosed`-only request) —
  // sort a copy so this doesn't reorder the cached value out from under every
  // other request sharing it until the next invalidation.
  rows = rows.slice().sort(Object.hasOwn(SORTS, filters.sort ?? '') ? SORTS[filters.sort] : SORTS.score);
  // Shared with the fast path above, so the two can never disagree about what
  // page the caller asked for.
  const { limit, offset } = pageWindow(filters);
  const total = rows.length;
  return {
    jobs: rows.slice(offset, offset + limit),
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pages: Math.max(1, Math.ceil(total / limit)),
    ...(viewCounts ? { viewCounts } : {}),
  };
}

/**
 * Full detail for one job: board row + packet summary (blockers, prefill plan,
 * screening answers, uploads) read from the packet JSON when present.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {object} [deps] { readFileImpl, now }
 * @returns {object|null}
 */
export function jobDetail(db, jobId, deps = {}) {
  const job = db.getJob(jobId);
  if (!job) return null;
  const approval = db.getApprovalByJob?.(jobId) ?? null;
  const row = boardRow(job, approval, deps.now ?? new Date());

  let packet = null;
  if (job.application_packet_path) {
    const readImpl = deps.readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
    try {
      const full = JSON.parse(readImpl(job.application_packet_path));
      packet = {
        id: full.id,
        ats: full.ats ?? null,
        blockers: full.blockers ?? [],
        resumeTailored: Boolean(full.resumeTailored),
        resumeWarning: full.resumeWarning ?? null,
        resumePath: full.resumePath ?? null,
        resumePdfPath: full.resumePdfPath ?? null,
        resumePreviewWarning: full.resumePreviewWarning ?? null,
        resumeValidation: full.resumeValidation ?? null,
        tailoring: full.tailoring ?? null,
        llmRequirements: full.tailoring?.llmRequirements ?? null,
        atsReport: full.atsReport ?? null,
        prefillPlan: full.prefill?.plan ?? [],
        needsUser: full.prefill?.needsUser ?? [],
        screeningAnswered: full.screeningPlan?.answered ?? [],
        uploads: full.uploads ?? null,
        stopBeforeSubmit: full.stopBeforeSubmit !== false,
        submitReady: Boolean(full.submitReady),
        coverLetterGenerated: Boolean(full.coverLetterGenerated),
        coverLetterGrounding: full.coverLetterGrounding ?? null,
        coverLetterDocxPath: full.coverLetterDocxPath ?? null,
        letterMode: letterModeFor(db, jobId),
      };
    } catch (err) {
      packet = { error: `packet unreadable: ${err.message}` };
    }
  }

  // Audit trail: every event the system recorded for this job (newest first).
  let events = [];
  try {
    events = (db.listEvents?.(jobId) ?? [])
      .map((e) => {
        let metadata = e.metadata ?? null;
        if (typeof metadata === 'string') {
          try { metadata = JSON.parse(metadata); } catch { /* keep the original audit text */ }
        }
        return { at: e.created_at, type: e.event_type, message: e.message, metadata };
      })
      .reverse()
      .slice(0, 30);
  } catch { /* events are best-effort */ }

  // Privacy-minimized resumable checkpoint. It contains field identifiers and
  // verification status, never typed answers or absolute upload paths.
  let applicationState = null;
  let applicationStateError = null;
  if (deps.root) {
    const stateKey = {
      id: packet?.id,
      owner: packet?.owner,
      job: { id: job.id, url: job.url },
      ats: { platform: job.ats_platform ?? packet?.ats?.platform },
    };
    const existsImpl = deps.applicationStateExistsImpl ?? existsSync;
    // Checkpoints now live under the owning profile; one written before that
    // change is still at the flat path, and the runner itself falls back to
    // it — so must the page, or a resumable run looks like it never started.
    const profiledPath = applicationStatePath(deps.root, stateKey);
    const legacyPath = legacyApplicationStatePath(deps.root, stateKey);
    const statePath = profiledPath && existsImpl(profiledPath) ? profiledPath : legacyPath;
    if (statePath && existsImpl(statePath)) {
      try {
        const readState = deps.readApplicationStateImpl ?? ((p) => readFileSync(p, 'utf8'));
        applicationState = JSON.parse(readState(statePath));
      } catch (err) {
        applicationStateError = `application state unreadable: ${err.message}`;
      }
    }
  }

  // The free-text half of the decision reason lives on the decision event
  // (events are newest first here), not in a column of its own.
  // Who put an unverified submission here? Your own "I submitted it myself"
  // is logged as a human status change; say so instead of the neutral text.
  // (A new value, not a write into `row`: board rows are cached and shared.)
  let statusReason = row.statusReason;
  if (row.appStatus === APP_STATUS.SUBMIT_UNVERIFIED) {
    const reported = events.find((e) => e.type === 'status_changed' && e.metadata?.to === 'submit_unverified');
    if (reported?.metadata?.actor === 'human') {
      statusReason = `You reported submitting this yourself${reported.at ? ` (${String(reported.at).slice(0, 10)})` : ''}, `
        + `without a confirmation number. ${CONFIRM_HOW}`;
    }
  }

  const decisionEvent = job.user_decision ? events.find((e) => e.type === 'user_decision') : null;
  const decisionReasonNote = decisionEvent?.metadata?.reasonNote ?? null;

  return {
    ...row, statusReason, decisionReasonNote, jdText: job.jd_text ?? null, packet, events, applicationState, applicationStateError,
    // Buried conditions (onsite ramp-up, travel, on-call, W2-only…), each with
    // the sentence it came from. Read-only facts about the posting.
    clauses: extractHiddenClauses(job.jd_text ?? ''),
    // Before a browser opens: does this employer need an account, and which
    // of this job's form questions has nobody answered yet?
    access: applicationAccess(row),
    // What the store already knows about this employer: how its other
    // postings answered the sponsorship question, and whether this title is
    // reposted again and again. Shown only; it changes no score or gate.
    history: (() => { try { return employerHistory(db, job); } catch { return null; } })(),
    // Each skill the posting asks for, with the master resume's own line that
    // proves it (quotes only; an unproven skill has no lines).
    evidence: (() => {
      const root = deps.root ?? deps.config?.root ?? null;
      if (!root) return null;
      const lines = masterResumeLines(root);
      if (!lines.length) return null;
      return evidenceFor([...jsonList(job.matched_keywords), ...jsonList(job.missing_keywords)], lines);
    })(),
    openQuestions: (() => {
      const root = deps.root ?? deps.config?.root ?? null;
      if (!root) return [];
      try { return openQuestionsFor(loadQuestionQueue(root), jobId); } catch { return []; }
    })(),
    // The workspace card for this job (outcome, history, follow-up), or null
    // when it is not an application yet.
    application: (() => {
      try { return applicationSummary(db, jobId, { now: deps.now ?? new Date(), config: deps.config ?? null }); } catch { return null; }
    })(),
  };
}

/**
 * Why a user rejected or archived a job — the one signal about their
 * preferences the product threw away. A closed vocabulary so it can be
 * counted; `other` plus the free-text note covers everything else.
 */
export const DECISION_REASONS = Object.freeze([
  'salary', 'location', 'seniority', 'sponsorship', 'stack', 'company', 'stale', 'other',
]);

/** Longest free-text decision note kept. */
const MAX_REASON_NOTE = 200;

/** Event type recorded for every dashboard decision (and its undo). */
export const DECISION_EVENT = 'user_decision';

/** Append an audit event when the db supports it (test stubs may not). */
function recordEvent(db, event) {
  if (typeof db.insertEvent !== 'function') return;
  db.insertEvent({ id: randomUUID(), created_at: new Date().toISOString(), ...event });
}

/**
 * Apply a user triage decision from the dashboard.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {'shortlisted'|'rejected'|'archived'|'clear'} decision
 * @param {object} [details]
 * @param {string} [details.reason] one of DECISION_REASONS (optional)
 * @param {string} [details.reasonNote] free text, <= 200 chars (optional)
 * @returns {{ id: string, userDecision: string|null, decisionReason: string|null, appStatus: string }}
 */
export function applyDecision(db, jobId, decision, { reason = null, reasonNote = null } = {}) {
  if (!USER_DECISIONS.includes(decision)) {
    throw httpError(400, `invalid decision "${decision}" (use ${USER_DECISIONS.join('/')})`);
  }
  if (reason != null && reason !== '' && !DECISION_REASONS.includes(reason)) {
    throw httpError(400, `invalid reason "${reason}" (use ${DECISION_REASONS.join('/')})`);
  }
  if (reasonNote != null && typeof reasonNote !== 'string') {
    throw httpError(400, 'reasonNote must be text');
  }
  const note = reasonNote ? reasonNote.trim().slice(0, MAX_REASON_NOTE) || null : null;
  const before = db.getJob(jobId);
  if (!before) throw httpError(404, `unknown job id: ${jobId}`);
  const value = decision === 'clear' ? null : decision;
  const why = value ? (reason || null) : null;
  const job = db.setUserDecision(jobId, value, { reason: why });
  recordEvent(db, {
    job_id: jobId,
    event_type: DECISION_EVENT,
    message: value ? `decision: ${value}${why ? ` (${why})` : ''}` : 'decision cleared',
    metadata: {
      decision: value,
      reason: why,
      reasonNote: value ? note : null,
      // What it was BEFORE, so a single decision can be undone exactly.
      previous: { decision: before.user_decision ?? null, reason: before.decision_reason ?? null },
    },
  });
  noteUserMutation();
  const approval = db.getApprovalByJob?.(jobId) ?? null;
  return {
    id: jobId,
    userDecision: job.user_decision ?? null,
    decisionReason: job.decision_reason ?? null,
    appStatus: deriveAppStatus(job, approval),
  };
}

/**
 * Undo the most recent dashboard decision on one job, restoring the decision
 * AND reason it replaced. Batch undo in the UI re-posts each job's previous
 * decision, which cannot bring a reason back; this can, because every
 * decision event records what it overwrote.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @returns {{ id: string, userDecision: string|null, decisionReason: string|null,
 *            appStatus: string, undone: true }}
 * @throws 404 unknown job, 409 when there is no decision to undo
 */
export function undoDecision(db, jobId) {
  if (!db.getJob(jobId)) throw httpError(404, `unknown job id: ${jobId}`);
  const events = (db.listEvents?.(jobId) ?? []).filter((e) => e.event_type === DECISION_EVENT);
  const last = events[events.length - 1];
  let meta = last?.metadata ?? null;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  if (!meta || meta.undo === true || !meta.previous) {
    throw httpError(409, 'there is no decision on this job to undo');
  }
  const previous = meta.previous;
  const job = db.setUserDecision(jobId, previous.decision ?? null, { reason: previous.reason ?? null });
  recordEvent(db, {
    job_id: jobId,
    event_type: DECISION_EVENT,
    message: `decision undone (back to ${previous.decision ?? 'none'})`,
    metadata: { decision: previous.decision ?? null, reason: previous.reason ?? null, undo: true },
  });
  noteUserMutation();
  const approval = db.getApprovalByJob?.(jobId) ?? null;
  return {
    id: jobId,
    userDecision: job.user_decision ?? null,
    decisionReason: job.decision_reason ?? null,
    appStatus: deriveAppStatus(job, approval),
    undone: true,
  };
}

/**
 * Approve a job's prepared packet for assisted filling (human action).
 * @returns {{ id: string, approvalId: string, status: string }}
 */
export function approveJobPacket(db, jobId, { digest = null } = {}) {
  const approval = db.getApprovalByJob?.(jobId);
  if (!approval) throw httpError(409, `no prepared packet to approve for job ${jobId}, run Prepare first`);
  // Approving is a decision about something not yet sent. A job already
  // submitted (or reported submitted) has nothing left to approve, and
  // re-approving it is how a second fill of the same application starts.
  const job = db.getJob?.(jobId);
  if (job && (Number(job.applied) === 1 || ['submitted', 'submit_unverified'].includes(job.status))) {
    throw httpError(409, 'this application was already submitted (or reported submitted), so there is nothing to approve');
  }
  const r = approve(db, approval.id);
  // The approval's audit record, with a digest of what was approved (see
  // src/apply/approvalDigest.js) so a later fill can tell if it changed.
  insertApprovalEvent(db, jobId, APPROVAL_EVENT, 'packet approved', { approvalId: approval.id, ...(digest ? { digest } : {}) });
  noteUserMutation();
  return { id: jobId, approvalId: approval.id, status: r.status };
}

/**
 * Reject a job's prepared packet (human action).
 * @returns {{ id: string, approvalId: string, status: string }}
 */
export function rejectJobPacket(db, jobId) {
  const approval = db.getApprovalByJob?.(jobId);
  if (!approval) throw httpError(409, `no prepared packet to reject for job ${jobId}`);
  const r = reject(db, approval.id);
  insertApprovalEvent(db, jobId, 'packet_rejected', 'packet rejected', { approvalId: approval.id });
  noteUserMutation();
  return { id: jobId, approvalId: approval.id, status: r.status };
}

/**
 * Take back an approval (human action). Allowed until the application is
 * being filled or was submitted; the packet returns to "needs review".
 * @returns {{ id: string, approvalId: string, status: string }}
 */
export function unapproveJobPacket(db, jobId) {
  const approval = db.getApprovalByJob?.(jobId);
  if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) {
    throw httpError(409, 'this packet is not approved, so there is nothing to take back');
  }
  const job = db.getJob?.(jobId);
  if (job && (Number(job.applied) === 1 || ['submitted', 'submit_unverified', 'assist_started'].includes(job.status))) {
    throw httpError(409, job.status === 'assist_started'
      ? 'auto-fill is running for this job; cancel it first'
      : 'this application was already submitted (or reported submitted), so its approval stays');
  }
  db.updateApprovalStatus(approval.id, { approval_status: APPROVAL_STATUS.PENDING, approved_by_user: 0, approved_at: null });
  insertApprovalEvent(db, jobId, 'packet_unapproved', 'approval taken back', { approvalId: approval.id });
  noteUserMutation();
  return { id: jobId, approvalId: approval.id, status: APPROVAL_STATUS.PENDING };
}

/**
 * Take back an approval because what it covered has changed since. The packet
 * returns to "needs review" so the person sees it and approves it again.
 *
 * @param {object} db
 * @param {string} jobId
 * @param {string[]} changes human names of what changed (approvalDigest.digestChanges)
 * @returns {boolean} true when an approval was withdrawn
 */
export function withdrawApproval(db, jobId, changes = []) {
  const approval = db.getApprovalByJob?.(jobId);
  if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) return false;
  db.updateApprovalStatus(approval.id, {
    approval_status: APPROVAL_STATUS.PENDING, approved_by_user: 0, approved_at: null,
  });
  insertApprovalEvent(db, jobId, 'approval_withdrawn', `approval withdrawn: ${changes.join(', ')} changed since you approved`, { changes });
  noteUserMutation();
  return true;
}

/** Best-effort audit event for an approval decision (never fails the action). */
function insertApprovalEvent(db, jobId, type, message, metadata) {
  if (typeof db.insertEvent !== 'function') return;
  try {
    db.insertEvent({ id: randomUUID(), job_id: jobId, event_type: type, message, metadata });
  } catch { /* the decision itself is already stored */ }
}

/** Timestamped note line appended to a job's notes. */
function appendNote(existing, label, at, note) {
  const stamp = at.slice(0, 16).replace('T', ' ');
  const line = `[${label} ${stamp}] ${note}`;
  return existing ? `${existing}\n${line}` : line;
}

/**
 * Record that the HUMAN manually submitted this application. This is the only
 * path to "submitted" — the system never sets it on its own.
 *
 * Optionally captures a submission record: the ATS confirmation number and a
 * free-text note (e.g. which email the confirmation went to). The note is
 * appended to the job's existing notes with a timestamp, never overwriting.
 *
 * NEVER DOWNGRADES. A second click on an already-submitted job — or an
 * unverified "I think I submitted it" on one — used to write `applied = 0,
 * status = 'submit_unverified'` over a confirmed submission: the application
 * silently stopped counting, and the daily cap and every "submitted" tile
 * forgot it. A submitted job now only gains the note (and a confirmation
 * number, if it had none); its status and applied_at never move.
 *
 * The status move itself goes through db.setJobStatus, so it is checked
 * against the lifecycle graph and leaves an audit event.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {object} [details]
 * @param {string} [details.confirmationNumber]
 * @param {boolean} [details.verified] human explicitly saw positive confirmation evidence
 * @param {string} [details.note]
 * @param {Date} [details.now]
 * @returns {{ id: string, appStatus: string, appliedAt: string|null, reportedAt: string,
 *             verified: boolean, confirmationNumber: string|null, alreadySubmitted?: true }}
 */
/**
 * "No, it didn't go through": take an unverified submission back to where it
 * came from, so it can be finished. Only from submit_unverified, only by the
 * person (see lifecycle HUMAN_UNSUBMIT), and never from a confirmed one.
 *
 * @param {object} db
 * @param {string} jobId
 * @returns {{ id: string, from: string, to: string }}
 */
export function retractSubmissionReport(db, jobId) {
  const job = db.getJob(jobId);
  if (!job) throw httpError(404, `unknown job id: ${jobId}`);
  if (Number(job.applied) === 1 || job.status !== 'submit_unverified') {
    throw httpError(409, 'only an unconfirmed submission can be marked as not gone through');
  }
  const events = db.listEvents?.(jobId) ?? [];
  let came = null;
  for (let i = events.length - 1; i >= 0 && !came; i -= 1) {
    const e = events[i];
    if (e.event_type !== 'status_changed') continue;
    let meta = e.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    if (meta?.to === 'submit_unverified') came = meta.from;
  }
  const to = came === 'ready_for_submit' ? 'ready_for_submit' : 'assist_blocked';
  const patch = { submitted_confirmation: null };
  // Back to "needs you" with the reason it now holds, unless the earlier
  // blocker is still on the row (it is, after "I submitted it myself").
  if (to === 'assist_blocked' && jsonList(job.assist_blockers).length === 0) {
    patch.assist_blockers = JSON.stringify(['submission not confirmed: you said it did not go through — finish it in the browser, then retry auto-fill or record it']);
  }
  db.setJobStatus(jobId, to, { reason: 'the user said it did not go through', patch, actor: 'human' });
  noteUserMutation();
  return { id: jobId, from: 'submit_unverified', to };
}

export function markSubmittedByHuman(db, jobId, details = {}) {
  const job = db.getJob(jobId);
  if (!job) throw httpError(404, `unknown job id: ${jobId}`);
  const reportedAt = (details.now ?? new Date()).toISOString();
  const confirmation = String(details.confirmationNumber ?? '').trim().slice(0, 200) || null;
  const verified = details.verified === true || Boolean(confirmation);
  const note = String(details.note ?? '').trim().slice(0, 2000);

  if (Number(job.applied) === 1 || job.status === 'submitted') {
    const patch = { id: jobId };
    if (note) patch.notes = appendNote(job.notes, 'note', reportedAt, note);
    if (confirmation && !job.submitted_confirmation) patch.submitted_confirmation = confirmation;
    if (Object.keys(patch).length > 1) db.upsertJob(patch);
    noteUserMutation();
    return {
      id: jobId,
      appStatus: APP_STATUS.SUBMITTED,
      appliedAt: job.applied_at ?? null,
      reportedAt,
      verified: true,
      confirmationNumber: job.submitted_confirmation ?? patch.submitted_confirmation ?? null,
      alreadySubmitted: true,
    };
  }

  const patch = verified
    ? { applied: 1, applied_at: reportedAt }
    : { applied: 0, applied_at: null };
  if (confirmation) patch.submitted_confirmation = confirmation;
  if (note) {
    const label = verified ? 'submitted' : 'submission reported — verification pending';
    patch.notes = appendNote(job.notes, label, reportedAt, note);
  }
  const to = verified ? 'submitted' : 'submit_unverified';
  if (typeof db.setJobStatus === 'function') {
    db.setJobStatus(jobId, to, { reason: 'marked by the user', patch, actor: 'human' });
  } else {
    db.upsertJob({ id: jobId, ...patch, status: to });
  }
  noteUserMutation();
  return {
    id: jobId,
    appStatus: verified ? APP_STATUS.SUBMITTED : APP_STATUS.SUBMIT_UNVERIFIED,
    appliedAt: verified ? reportedAt : null,
    reportedAt,
    verified,
    confirmationNumber: confirmation,
  };
}

/**
 * Save (or clear) a free-text note on a job — the human's own reminders that
 * travel with the row and the CSV export. Never touches pipeline state.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {string} note
 * @returns {{ id: string, notes: string }}
 */
export function setJobNote(db, jobId, note) {
  if (!db.getJob(jobId)) throw httpError(404, `unknown job id: ${jobId}`);
  const value = String(note ?? '').slice(0, 4000);
  db.upsertJob({ id: jobId, notes: value });
  noteUserMutation();
  return { id: jobId, notes: value };
}

/** Board views that describe application work, and so count every search. */
const APPLICATION_VIEW_KEYS = Object.freeze(['needs_review', 'ready_apply', 'needs_you', 'blocked', 'submitted']);

/**
 * APPLICATIONS ARE A RECORD, so their counts cover every search.
 *
 * The rest of the stats describe the personalized board, and so did these —
 * while the Applications board showed every application, however it was
 * found. A job prepared from a role search was on the board but missing from
 * the "Needs review" badge, the header count and "Approve prepared packets".
 * The Applications list reads the same all-searches scope, so each of these
 * numbers still equals the rows it opens. Index-backed; no extra table scan.
 */
function applyApplicationScope(stats, db, now) {
  if (typeof db.listApplicationJobsSummary !== 'function') return; // test stubs keep the scoped counts
  const rows = applicationRows(db, now);
  for (const key of APPLICATION_VIEW_KEYS) stats.views[key] = rows.filter(BOARD_VIEWS[key]).length;
  const count = (test) => rows.filter((r) => test(r.appStatus)).length;
  stats.totals.pendingReview = count((s) => s === APP_STATUS.NEEDS_REVIEW);
  stats.totals.readyForSubmit = count((s) => s === APP_STATUS.READY_FOR_SUBMIT);
  stats.totals.submitUnverified = count((s) => s === APP_STATUS.SUBMIT_UNVERIFIED);
  stats.totals.blocked = count((s) => VIEW_BLOCKED.has(s));
}

/* ─────────────────────── applications workspace ───────────────────────
 * Every application as one card in a column, with its recorded outcome, any
 * follow-up reminder, and the next step. Outcomes and follow-ups are events
 * (see src/domain/applicationOutcome.js): nothing here writes jobs.status,
 * jobs.applied or a user decision, and nothing here submits or approves.
 */

/** Longest note kept on an outcome or a follow-up. */
const MAX_OUTCOME_NOTE = 500;

/** Furthest ahead a follow-up may be set. */
const MAX_FOLLOWUP_DAYS = 365;

/** Decorated rows for every application, whichever search found it. */
function applicationRows(db, now) {
  if (typeof db.listApplicationJobsSummary !== 'function') return allBoardRows(db, now, EVERY_MODE);
  const approvals = approvalsByJob(db);
  return db.listApplicationJobsSummary().map((job) => boardRow(job, approvals.get(job.id) ?? null, now));
}

/** Outcome and follow-up events per job id, oldest first. */
function workspaceEvents(db, ids) {
  if (typeof db.listEventsForJobs === 'function') return outcomeEventsByJob(db, ids);
  // Test stubs without the indexed read.
  const types = [OUTCOME_EVENT, FOLLOWUP_EVENT];
  return new Map(ids.map((id) => [id, (db.listEvents?.(id) ?? []).filter((e) => types.includes(e.event_type))]));
}

/** The next step on a card, worded to fit one. Never an approval or a submit. */
function workspaceNextAction(row, stage, followUp) {
  switch (row.appStatus) {
    // Approving starts from READING the resume, so the card opens the job.
    case APP_STATUS.NEEDS_REVIEW: return { kind: 'review', label: 'Review resume' };
    case APP_STATUS.APPROVED: return { kind: 'autofill', label: 'Start auto-fill' };
    case APP_STATUS.CANCELLED: return { kind: 'autofill', label: 'Resume auto-fill' };
    case APP_STATUS.READY_FOR_SUBMIT: return { kind: 'submit', label: 'Record submission' };
    case APP_STATUS.SUBMIT_UNVERIFIED: return { kind: 'review', label: 'Confirm it went through' };
    case APP_STATUS.BLOCKED: return { kind: 'review', label: 'See what stopped it' };
    case APP_STATUS.FAILED: return { kind: 'review', label: 'Check the error' };
    default: break;
  }
  if (followUp?.due) return { kind: 'followup', label: 'Follow up' };
  if (stage === 'applied') return { kind: 'outcome', label: 'Record a response' };
  if (stage === 'interviewing') return { kind: 'outcome', label: 'Record the result' };
  if (stage === 'offer') return { kind: 'outcome', label: 'Record your decision' };
  return null;
}

/** Company name as a grouping key ("Acme, Inc." and "acme inc" are one employer). */
const companyKey = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b/g, '').trim();

/** One workspace card, or null when the row is not an application. */
function workspaceItem(row, events, { today, timeZone, history = false }) {
  const submitted = row.appStatus === APP_STATUS.SUBMITTED;
  const outcomes = submitted ? replayOutcomes(events.filter((e) => e.event_type === OUTCOME_EVENT)) : null;
  const current = outcomes?.current ?? null;
  const stage = stageOf(row.appStatus, current?.outcome ?? null);
  if (!stage) return null;
  const follow = replayFollowUps(events.filter((e) => e.event_type === FOLLOWUP_EVENT));
  // A closed application has nothing left to chase; its reminder is hidden,
  // not deleted, so undoing the outcome brings it back.
  const followUp = submitted && follow.open && stage !== 'closed'
    ? { ...follow.open, due: follow.open.dueOn <= today, daysLate: Math.max(0, daysBetween(follow.open.dueOn, today) ?? 0) }
    : null;
  const appliedDay = row.appliedAt ? dayOf(row.appliedAt, timeZone) : null;
  const item = {
    id: row.id, title: row.title, company: row.company ?? null, location: row.location ?? null, url: row.url ?? null,
    score: row.score, grade: row.grade, fit: row.fit, sponsorship: row.sponsorship ?? null,
    sponsorshipGated: row.sponsorshipGated === true, postedAt: row.postedAt ?? null, linkState: row.linkState ?? null,
    atsPlatform: row.atsPlatform ?? null, discoveryMode: row.discoveryMode ?? null,
    source: row.source ?? null, tier: row.tier ?? null,
    appStatus: row.appStatus, statusLabel: row.statusLabel ?? APP_STATUS_LABELS[row.appStatus] ?? row.appStatus,
    statusReason: row.statusReason ? stripBannerChars(row.statusReason) : null,
    appliedAt: row.appliedAt ?? null, appliedOn: appliedDay, updatedAt: row.updatedAt ?? null,
    stage,
    outcome: current,
    reached: outcomes?.reached ?? null,
    allowedOutcomes: submitted ? allowedOutcomes(current?.outcome ?? null) : [],
    canUndoOutcome: Boolean(current),
    followUp,
    awaitingDays: stage === 'applied' && appliedDay ? daysBetween(appliedDay, today) : null,
    sameCompany: 0,
    // Needs an employer account (Workday, Oracle, iCIMS…) or none (Greenhouse…).
    access: applicationAccess(row).kind,
    attentionKind: row.attention?.kind ?? null,
  };
  item.nextAction = workspaceNextAction(row, stage, followUp);
  if (history) {
    item.outcomeHistory = outcomes?.history ?? [];
    item.lastFollowUp = follow.last;
  }
  return item;
}

/** Most pressing first: a due follow-up, then the most recent activity. */
function workspaceOrder(a, b) {
  return Number(Boolean(b.followUp?.due)) - Number(Boolean(a.followUp?.due))
    || String(b.outcome?.at ?? b.appliedAt ?? b.updatedAt ?? '').localeCompare(String(a.outcome?.at ?? a.appliedAt ?? a.updatedAt ?? ''))
    || String(a.id).localeCompare(String(b.id));
}

/**
 * Every application as a workspace card, plus the numbers they add up to.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object|null} [options.config] for the user's timezone ("due today")
 * @returns {{ generatedAt: string, today: string, stages: object[], items: object[], metrics: object }}
 */
export function applicationsWorkspace(db, { now = new Date(), config = null } = {}) {
  const { today, items, events } = workspaceParts(db, now, config);
  const timeZone = candidateTimeZone(config);
  return {
    generatedAt: now.toISOString(), today, stages: WORKSPACE_STAGES, items, metrics: applicationMetrics(items),
    // "Sign in once, retry all": stopped fills grouped by employer portal.
    signInGroups: signInGroups(items.map((i) => ({ ...i, attention: { kind: i.attentionKind } }))),
    conversion: conversionBreakdown(items),
    weekly: weeklySummary({ items, eventsByJob: events, today, dayOf: (iso) => dayOf(iso, timeZone) }),
  };
}

/** The decorated rows and the cards built from them (shared with Today). */
function workspaceParts(db, now, config) {
  const timeZone = candidateTimeZone(config);
  const today = dayOf(now, timeZone);
  const rows = applicationRows(db, now);
  const events = workspaceEvents(db, rows.map((r) => r.id));
  const items = [];
  for (const row of rows) {
    const item = workspaceItem(row, events.get(row.id) ?? [], { today, timeZone });
    if (item) items.push(item);
  }
  // Other applications at the same employer, so a second application to a
  // company is visible as one — each keeps its own outcome and history.
  const perCompany = new Map();
  for (const item of items) {
    const key = companyKey(item.company);
    if (key) perCompany.set(key, (perCompany.get(key) ?? 0) + 1);
  }
  for (const item of items) item.sameCompany = Math.max(0, (perCompany.get(companyKey(item.company)) ?? 1) - 1);
  items.sort(workspaceOrder);
  return { rows, items, today, events };
}

/**
 * One job's workspace card with its full outcome history, or null when the
 * job is not an application. Used by the detail rail and every mutation reply.
 */
export function applicationSummary(db, jobId, { now = new Date(), config = null } = {}) {
  const job = db.getJob(jobId);
  if (!job) return null;
  const timeZone = candidateTimeZone(config);
  const approval = db.getApprovalByJob?.(jobId) ?? null;
  const row = boardRow(job, approval, now);
  const events = workspaceEvents(db, [jobId]).get(jobId) ?? [];
  return workspaceItem(row, events, { today: dayOf(now, timeZone), timeZone, history: true });
}

/** A submitted job, or the 404/409 that explains why it is not one. */
function submittedJobOr409(db, jobId, what) {
  const job = db.getJob(jobId);
  if (!job) throw httpError(404, `unknown job id: ${jobId}`);
  if (Number(job.applied) !== 1) {
    throw httpError(409, `${what} can only be recorded for an application you submitted. `
      + 'Use "I submitted it myself" first if you applied outside JobAgent.');
  }
  return job;
}

/** A trimmed, length-capped optional note, or the 400 for a non-string. */
function noteOr400(note) {
  if (note == null || note === '') return null;
  if (typeof note !== 'string') throw httpError(400, 'note must be text');
  return note.trim().slice(0, MAX_OUTCOME_NOTE) || null;
}

/**
 * Record what the employer (or the user) did with a submitted application:
 * interviewing, offer, hired, rejected by the employer, or withdrawn.
 *
 * Validated against the outcome graph (canRecordOutcome) — a drag on the
 * board is a REQUEST, and this is where it is accepted or refused. It never
 * touches the job's status, submission or decision, and never overwrites an
 * earlier outcome: each one is a new event, and undo appends its reversal.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {object} details
 * @param {string} details.outcome an OUTCOME value
 * @param {string} [details.on] YYYY-MM-DD it happened; defaults to today
 * @param {string} [details.note]
 * @throws 400 bad outcome/date/note, 404 unknown job, 409 not submitted or not an allowed move
 */
export function recordOutcome(db, jobId, { outcome, on = null, note = null, now = new Date(), config = null } = {}) {
  if (!OUTCOME_VALUES.includes(outcome)) {
    throw httpError(400, `invalid outcome "${outcome}" (use ${OUTCOME_VALUES.join('/')})`);
  }
  submittedJobOr409(db, jobId, 'An outcome');
  const today = dayOf(now, candidateTimeZone(config));
  const day = on == null || on === '' ? today : on;
  if (!isIsoDay(day)) throw httpError(400, 'date must be a calendar day written YYYY-MM-DD');
  if (day > today) throw httpError(400, 'an outcome cannot be dated in the future');
  const text = noteOr400(note);
  const events = workspaceEvents(db, [jobId]).get(jobId) ?? [];
  const from = replayOutcomes(events.filter((e) => e.event_type === OUTCOME_EVENT)).current?.outcome ?? null;
  if (!canRecordOutcome(from, outcome)) {
    const fromLabel = OUTCOME_LABELS[from ?? OUTCOME.APPLIED];
    throw httpError(409, from === outcome
      ? `This application is already marked "${fromLabel}".`
      : `An application marked "${fromLabel}" cannot move to "${OUTCOME_LABELS[outcome]}"`
        + `${from && TERMINAL_OUTCOMES.has(from) ? '. Undo the last outcome to correct it.' : '.'}`);
  }
  recordEvent(db, {
    job_id: jobId,
    event_type: OUTCOME_EVENT,
    message: `outcome: ${outcome}`,
    metadata: { outcome, on: day, note: text, previous: from },
  });
  noteUserMutation();
  return applicationSummary(db, jobId, { now, config });
}

/**
 * Reverse the most recent recorded outcome on one job (appends an undo event;
 * the original stays in the audit log).
 * @throws 404 unknown job, 409 nothing to undo
 */
export function undoOutcome(db, jobId, { now = new Date(), config = null } = {}) {
  if (!db.getJob(jobId)) throw httpError(404, `unknown job id: ${jobId}`);
  const events = workspaceEvents(db, [jobId]).get(jobId) ?? [];
  const { current, history } = replayOutcomes(events.filter((e) => e.event_type === OUTCOME_EVENT));
  if (!current) throw httpError(409, 'there is no recorded outcome on this application to undo');
  const back = history.length > 1 ? history[history.length - 2].outcome : OUTCOME.APPLIED;
  recordEvent(db, {
    job_id: jobId,
    event_type: OUTCOME_EVENT,
    message: `outcome undone (back to ${back})`,
    metadata: { undo: true, undid: current.outcome },
  });
  noteUserMutation();
  return applicationSummary(db, jobId, { now, config });
}

/** What a follow-up request may do. */
export const FOLLOWUP_ACTIONS = Object.freeze(['set', 'done', 'dismissed']);

/**
 * Set, complete or dismiss the follow-up reminder on a submitted application.
 * Reminders are read when a page asks for them — no timer, no notification,
 * no background process.
 *
 * @param {object} details
 * @param {'set'|'done'|'dismissed'} details.action
 * @param {string} [details.dueOn] YYYY-MM-DD (required for `set`)
 * @param {string} [details.note]
 * @throws 400 bad action/date/note, 404 unknown job, 409 not submitted or nothing open
 */
export function updateFollowUp(db, jobId, { action, dueOn = null, note = null, now = new Date(), config = null } = {}) {
  if (!FOLLOWUP_ACTIONS.includes(action)) {
    throw httpError(400, `invalid follow-up action "${action}" (use ${FOLLOWUP_ACTIONS.join('/')})`);
  }
  submittedJobOr409(db, jobId, 'A follow-up');
  const text = noteOr400(note);
  const today = dayOf(now, candidateTimeZone(config));
  const metadata = { action };
  if (action === 'set') {
    if (!isIsoDay(dueOn)) throw httpError(400, 'dueOn must be a calendar day written YYYY-MM-DD');
    if ((daysBetween(today, dueOn) ?? 0) > MAX_FOLLOWUP_DAYS) {
      throw httpError(400, `a follow-up can be set at most ${MAX_FOLLOWUP_DAYS} days ahead`);
    }
    Object.assign(metadata, { dueOn, note: text });
  } else {
    const events = workspaceEvents(db, [jobId]).get(jobId) ?? [];
    if (!replayFollowUps(events.filter((e) => e.event_type === FOLLOWUP_EVENT)).open) {
      throw httpError(409, 'there is no open follow-up on this application');
    }
  }
  recordEvent(db, {
    job_id: jobId,
    event_type: FOLLOWUP_EVENT,
    message: action === 'set' ? `follow-up set for ${dueOn}` : `follow-up ${action}`,
    metadata,
  });
  noteUserMutation();
  return applicationSummary(db, jobId, { now, config });
}

/**
 * Due follow-ups as Today candidates. Read on request from the application
 * rows (index-backed, well under a millisecond on the live store).
 */
function dueFollowUpCandidates(db, now, config) {
  let parts;
  try { parts = workspaceParts(db, now, config); } catch { return []; }
  const rows = new Map(parts.rows.map((row) => [row.id, row]));
  return parts.items.filter((item) => item.followUp?.due && rows.has(item.id)).map((item) => ({
    row: rows.get(item.id),
    action: { rank: 2.5, kind: 'followup', label: 'Follow up', followUp: item.followUp, appliedOn: item.appliedOn, today: parts.today },
  }));
}

/** Why a follow-up is on Today, in one line. */
function followUpReason(action) {
  const { followUp, appliedOn, today } = action;
  const since = appliedOn ? daysBetween(appliedOn, today) : null;
  const parts = [];
  if (since != null) parts.push(`Applied ${since === 0 ? 'today' : `${since} day${since === 1 ? '' : 's'} ago`}`);
  parts.push(followUp.daysLate ? `reminder was due ${followUp.daysLate} day${followUp.daysLate === 1 ? '' : 's'} ago` : 'reminder due today');
  const line = `${parts.join(' · ')}.`;
  return followUp.note ? `${line} ${followUp.note}`.slice(0, TODAY_REASON_MAX) : line;
}

/** A lightweight board row for section lists (omits heavy keyword arrays). */
function sectionRow(row) {
  return {
    id: row.id, company: row.company, title: row.title, location: row.location,
    url: row.url, source: row.source, score: row.score, grade: row.grade,
    fit: row.fit, sponsorship: row.sponsorship, appStatus: row.appStatus,
    postedLabel: row.postedLabel, postedLast24h: row.postedLast24h,
    postedConfidence: row.postedConfidence, atsPlatform: row.atsPlatform,
    resumeStatus: row.resumeStatus, progress: row.progress, remote: row.remote,
    atsScore: row.atsScore, atsBand: row.atsBand,
    compensation: row.compensation, sponsorshipGated: row.sponsorshipGated,
    employmentCategory: row.employmentCategory, employmentLabel: row.employmentLabel,
    appliedAt: row.appliedAt,
  };
}

/** Extract the human-meaningful reason a blocked job stopped. */
function blockerReason(row) {
  const first = (row.assistBlockers ?? [])[0];
  if (!first) return 'Unknown, open it to see why';
  const b = String(first).toLowerCase();
  // First: a missing browser is a setup problem, not a login/navigation wall.
  if (ENVIRONMENT_FAILURE_RE.test(b)) return browserRecovered() ? SETUP_BROWSER_RECOVERED_LABEL : SETUP_BROWSER_LABEL;
  if (b.includes('captcha')) return 'CAPTCHA / bot wall';
  if (b.includes('login') || b.includes('sign in') || b.includes('account')) return 'Login / account required';
  if (b.includes('mfa') || b.includes('verification')) return 'MFA / verification';
  if (b.includes('screening') || b.includes('needs user') || b.includes('required field')) return 'Question needs your answer';
  if (b.includes('navigation') || b.includes('could not start') || b.includes('no application url')) return 'Page / navigation problem';
  if (b.includes('resume') || b.includes('upload')) return 'Resume upload problem';
  return String(first).slice(0, 80);
}

/**
 * Curated, action-oriented sections for the redesigned command center. Each
 * section is a small, sorted list of lightweight rows the UI renders as a card.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.limit=8] max rows per list section
 * @returns {{
 *   todaysPriorities: object[], bestMatches: object[], needsReview: object[],
 *   readyForSubmit: object[], recentlySubmitted: object[],
 *   blockedByReason: Array<{reason:string,count:number,jobs:object[]}>,
 *   counts: object
 * }}
 */
export function dashboardSections(db, { now = new Date(), limit = 8 } = {}) {
  // Every section below selects specific NON-closed statuses (or filters closed
  // rows out explicitly, as sponsorshipVerification and bestMatches do), so no
  // section can ever contain a closed row — and this can read the cheap
  // open-only base set rather than decorating the whole discard pile. Guarded by
  // the sections differential in dashboardData tests.
  const rows = openBoardRows(db, now);
  const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1);
  const is = (r, ...statuses) => statuses.includes(r.appStatus);

  const readyForSubmit = rows.filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT, APP_STATUS.APPROVED)).sort(byScore);
  const needsReview = rows.filter((r) => is(r, APP_STATUS.NEEDS_REVIEW)).sort(byScore);
  const blocked = rows.filter((r) => is(r, APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED)).sort(byScore);
  const submitUnverified = rows.filter((r) => is(r, APP_STATUS.SUBMIT_UNVERIFIED)).sort(byScore);
  const submitted = rows.filter((r) => is(r, APP_STATUS.SUBMITTED))
    .sort((a, b) => String(b.appliedAt ?? '').localeCompare(String(a.appliedAt ?? '')));

  // Today's queue follows the user's actual workflow. A strong match only
  // earns the "new" slot when the posting itself is confirmed within 24h;
  // discovering an old posting today never relabels it as new.
  const readyForUserSubmission = rows
    .filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT)).sort(byScore);
  const strongNew = rows
    .filter((r) => r.postedLast24h && r.postedConfidence === 'confirmed'
      && r.fit === 'strong' && is(r, APP_STATUS.SCORED, APP_STATUS.DISCOVERED))
    .sort(byScore);
  const sponsorshipVerification = rows
    .filter((r) => r.sponsorshipGated && !CLOSED_SET.has(r.appStatus)).sort(byScore);

  const priorityAll = [];
  const seenPriority = new Set();
  const addPriority = (items, kind) => {
    for (const row of items) {
      if (seenPriority.has(row.id)) continue;
      seenPriority.add(row.id);
      priorityAll.push({ ...sectionRow(row), priorityKind: kind });
    }
  };
  addPriority(readyForUserSubmission, 'ready_for_submission');
  addPriority(submitUnverified, 'submission_unverified');
  // Failed fills and environment failures are not today's work: a failure
  // needs the RCA panel, and a missing browser is ONE setup notice (see
  // todayQueue) — listing each as a per-job priority buried the real queue.
  addPriority(blocked.filter((r) => r.appStatus !== APP_STATUS.FAILED && !isEnvironmentFailure(r)), 'blocked');
  addPriority(needsReview, 'prepared_review');
  addPriority(strongNew, 'strong_new');
  addPriority(sponsorshipVerification, 'verify_sponsorship');
  const todaysPriorities = priorityAll.slice(0, limit);

  // Best matches: strong, recommended, still actionable (not closed/submitted).
  const closed = [APP_STATUS.REJECTED, APP_STATUS.ARCHIVED, APP_STATUS.DISCARDED, APP_STATUS.SUBMITTED];
  const bestMatches = rows
    .filter((r) => r.fit === 'strong' && r.grade?.recommend && !closed.includes(r.appStatus))
    .sort(byScore).slice(0, limit).map(sectionRow);

  // Blocked, grouped by reason so you can fix similar walls in one pass.
  const reasonMap = new Map();
  for (const r of blocked) {
    const reason = blockerReason(r);
    if (!reasonMap.has(reason)) reasonMap.set(reason, []);
    reasonMap.get(reason).push(sectionRow(r));
  }
  const blockedByReason = [...reasonMap.entries()]
    .map(([reason, jobs]) => ({ reason, count: jobs.length, jobs: jobs.slice(0, limit) }))
    .sort((a, b) => b.count - a.count);

  return {
    todaysPriorities,
    strongNew: strongNew.slice(0, limit).map(sectionRow),
    sponsorshipVerification: sponsorshipVerification.slice(0, limit).map(sectionRow),
    bestMatches,
    needsReview: needsReview.slice(0, limit).map(sectionRow),
    readyForSubmit: readyForSubmit.slice(0, limit).map(sectionRow),
    recentlySubmitted: submitted.slice(0, limit).map(sectionRow),
    blockedByReason,
    counts: {
      todaysPriorities: priorityAll.length,
      strongNew: strongNew.length,
      sponsorshipVerification: sponsorshipVerification.length,
      bestMatches: rows.filter((r) => r.fit === 'strong' && r.grade?.recommend && !closed.includes(r.appStatus)).length,
      needsReview: needsReview.length,
      readyForSubmit: readyForSubmit.length,
      recentlySubmitted: submitted.length,
      blocked: blocked.length,
    },
  };
}

/* ───────────────────────────── today queue ───────────────────────────── */

/** Most items the Today queue returns. */
export const TODAY_LIMIT = 10;

/**
 * Unsubmitted work on a posting older than this sinks to an "Aging" group at
 * the bottom of Today (BUG-09). Shortlisted and prepared rows are exempt from
 * automatic retirement, so without it a job shortlisted 78 days ago sat at #2,
 * above roles posted this week. A filled form waiting for Submit, or an
 * unconfirmed submission, is never demoted: those are minutes from done.
 */
export const TODAY_AGING_DAYS = 21;
const AGING_EXEMPT = new Set([APP_STATUS.SUBMIT_UNVERIFIED, APP_STATUS.READY_FOR_SUBMIT]);

/** Longest `reason` string in a Today item. */
const TODAY_REASON_MAX = 240;

/** A blocker that is a question only the human can answer. */
const QUESTION_BLOCKER_RE = /screening|needs user|required field|question|unanswered/i;

/**
 * What the human does next for one row, and how urgent it is (lower = sooner).
 * Returns null for rows that are not today's work.
 */
function todayAction(row) {
  switch (row.appStatus) {
    case APP_STATUS.SUBMIT_UNVERIFIED:
      return { rank: 0, kind: 'review', label: 'Confirm whether this application went through' };
    case APP_STATUS.READY_FOR_SUBMIT:
      return { rank: 1, kind: 'submit', label: 'Review the filled form and click Submit' };
    case APP_STATUS.BLOCKED: {
      const blockers = (row.assistBlockers ?? []).join(' ');
      // A form that refused a step (unticked terms, a bad date) is not a
      // question for the profile: the button opens the job at the reason.
      if (row.attention?.kind === 'form_check') return { rank: 2, kind: 'review', label: 'See what stopped it' };
      return QUESTION_BLOCKER_RE.test(blockers) || ['needs_help', 'question'].includes(row.attention?.kind)
        ? { rank: 2, kind: 'answer', label: 'Answer the question that stopped auto-fill' }
        : { rank: 2, kind: 'review', label: row.attention?.summary ?? 'Finish the step auto-fill could not' };
    }
    case APP_STATUS.NEEDS_REVIEW:
      return { rank: 3, kind: 'approve', label: 'Read the tailored resume and approve it' };
    case APP_STATUS.APPROVED:
      return { rank: 4, kind: 'autofill', label: 'Start auto-fill' };
    case APP_STATUS.CANCELLED:
      return { rank: 5, kind: 'autofill', label: 'Resume auto-fill' };
    case APP_STATUS.FAILED:
      return { rank: 6, kind: 'review', label: 'Check the recorded error, then retry auto-fill' };
    case APP_STATUS.SHORTLISTED:
      return { rank: 7, kind: 'prepare', label: 'Prepare the tailored resume and application' };
    case APP_STATUS.SCORED:
    case APP_STATUS.DISCOVERED:
      if (row.fit === 'strong' && row.grade?.recommend && row.postedLast24h && row.postedConfidence === 'confirmed') {
        return { rank: 8, kind: 'prepare', label: 'New strong fit — prepare an application' };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Top-up for a quiet day: the best open fits nobody has decided on yet.
 *
 * Measured on the live store (2026-09-23): 8 strong and 62 medium fits open,
 * yet the queue was EMPTY — the only "fresh work" rule wants a strong fit
 * posted in the last 24 h with a confirmed date. A landing page that says
 * "nothing to do" beside 70 undecided good matches sends people back to the
 * 6,000-row board, which is the behaviour the queue exists to replace.
 */
function todayTopUp(row) {
  if (row.userDecision) return null;
  if (row.appStatus !== APP_STATUS.SCORED && row.appStatus !== APP_STATUS.DISCOVERED) return null;
  if (row.fit === 'strong') {
    return row.sponsorshipGated
      ? { rank: 9, kind: 'review', label: 'Strong fit — check sponsorship, then decide' }
      : { rank: 9, kind: 'prepare', label: 'Strong fit — prepare an application' };
  }
  if (row.fit === 'medium') return { rank: 10, kind: 'review', label: 'Possible fit — review and decide' };
  return null;
}

/** What is waiting, for a status whose own reason would just repeat its label. */
const TODAY_CONTEXT = Object.freeze({
  [APP_STATUS.NEEDS_REVIEW]: 'Its tailored resume and cover letter are ready. Read them, then approve.',
  [APP_STATUS.SHORTLISTED]: 'You shortlisted this. Its tailored resume and cover letter are not prepared yet.',
  [APP_STATUS.APPROVED]: 'Approved. Auto-fill opens the application and stops before Submit.',
  [APP_STATUS.READY_FOR_SUBMIT]: 'The form is filled in the open browser. Review it and click Submit yourself.',
  [APP_STATUS.CANCELLED]: 'Auto-fill was paused. Resume it from where it stopped.',
});

/** Why this row is on the list, in one line. */
function todayReason(row, action) {
  if (action.rank === 8) return `Strong fit posted ${row.postedLabel ?? 'in the last 24 hours'}`;
  if (action.closed) return 'Its ATS no longer lists this job, so it cannot be applied to.';
  if (action.recovered) {
    return 'The last attempt failed only because the browser was not installed. It is now; if the packet was '
      + 'built for another profile it will be refused — prepare it again first.';
  }
  if (action.rank >= 9) {
    // The card's chips already show grade, score, sponsorship and age; the
    // reason line says what the chips cannot — which of your skills it asks for.
    const { matched, missing } = titleFreeSkills(row);
    if (matched.length) {
      return `Asks for ${matched.slice(0, 4).join(', ')}${matched.length > 4 ? ` and ${matched.length - 4} more of your skills` : ''}`
        + (missing.length ? ` · ${missing.length} asked-for skill${missing.length === 1 ? '' : 's'} not in your resume.` : '.');
    }
    const parts = [row.grade?.label, row.score != null ? `score ${Math.round(row.score)}` : null,
      row.sponsorship ? `sponsorship ${String(row.sponsorship).toLowerCase()}` : null,
      row.postedLabel ? `posted ${row.postedLabel}` : null].filter(Boolean);
    return parts.join(' · ') || 'Undecided match';
  }
  const label = row.statusLabel ?? APP_STATUS_LABELS[row.appStatus] ?? row.appStatus;
  let text = row.statusReason ? stripBannerChars(row.statusReason) : '';
  // The card already shows the status as a chip; a reason that only repeats
  // it ("Review resume" under a "Review resume" chip) says nothing. Say what
  // is actually waiting instead.
  if (!text || text.trim().toLowerCase() === String(label).trim().toLowerCase()) {
    text = TODAY_CONTEXT[row.appStatus] ?? '';
  }
  return text.length > TODAY_REASON_MAX ? `${text.slice(0, TODAY_REASON_MAX - 1)}…` : text;
}

/**
 * Problems with the SETUP that stop work on every job, reported once each.
 *
 * @param {object[]} rows decorated open rows
 * @param {object|null} config loadConfig() bundle (for placeholder detection)
 * @returns {Array<{code: string, severity: 'error'|'warn', message: string, fix: string}>}
 */
export function systemNotices(rows = [], config = null, { browserAvailable = null } = {}) {
  const notices = [];
  const envFailed = rows.filter((r) => VIEW_BLOCKED.has(r.appStatus) && isEnvironmentFailure(r));
  // `browserAvailable` is a LIVE check from the server (true/false); null means
  // unknown, and only then do old failure rows stand in for it. Rows are
  // history: on 2026-09-23 four rows still said "Executable doesn't exist"
  // eight days after Chromium was installed, and the notice kept telling the
  // user to install a browser they already had.
  const browserMissing = browserAvailable === false || (browserAvailable == null && envFailed.length > 0);
  if (browserAvailable === true && envFailed.length) {
    notices.push({
      code: 'browser_recovered',
      severity: 'warn',
      message: `The browser is installed now — ${envFailed.length} earlier auto-fill attempt(s) failed only because `
        + 'it was missing. Those jobs are listed below to retry.',
      fix: 'Retry auto-fill on each (re-prepare first if the packet is refused as another candidate\'s)',
    });
  }
  if (browserMissing) {
    notices.push({
      code: 'browser_unavailable',
      severity: 'error',
      message: 'Auto-fill can’t start: the Playwright browser is not installed',
      fix: 'npx playwright install chromium',
    });
  }
  if (config) {
    let found = null;
    try { found = findPlaceholders(config); } catch { found = null; }
    if (found && !found.ok) {
      const labels = [...new Set(found.placeholders.map((p) => p.label))];
      const shown = labels.slice(0, 5).join(', ') + (labels.length > 5 ? `, and ${labels.length - 5} more` : '');
      notices.push({
        code: 'profile_placeholders',
        severity: 'error',
        message: labels.length === 1
          ? `Replace 1 template value before applying: ${shown}.`
          : `Replace ${labels.length} template values before applying: ${shown}.`,
        fix: 'Applications stay on hold until these are real. Each line below says where to fix it: the '
          + 'Application profile, your saved search profile, or the cover-letter settings.',
        // Per field: what it says now and WHERE the fix sticks. The old notice
        // said only "Settings → Application profile", which cannot edit work
        // authorization or the cover letter, so following it changed nothing
        // and Prepare kept refusing with no visible reason.
        items: placeholderFixes(found.placeholders, { profileId: config.profile?.id ?? null }),
      });
    }
  }
  return notices;
}

/** Candidate fields the Application profile dialog edits (src/config/profileStore.js PROFILE_FIELDS). */
const APPLICATION_PROFILE_PATH = /^(identity\.(fullName|preferredName|links\.linkedin)|contact\.(email|phone)|location\.(city|state|zip))$/;

/**
 * Where each template value is actually fixed.
 *
 * `findPlaceholders` reports candidate fields as living in config/candidate.json,
 * but that file is regenerated from the active search profile on every
 * activation: an edit made there is overwritten. So each field is pointed at the
 * place that keeps it, a screen wherever one exists: the Application profile
 * fields, the Saved answer it is filled from (src/config/answerFallbacks.js), or
 * the master resume. Only a fact with no screen at all names a file.
 *
 * @param {Array<{path: string, label: string, value: string, file: string}>} placeholders
 * @param {{profileId?: string|null}} [options]
 * @returns {Array<{label: string, value: string, where: string, how: string}>}
 */
export function placeholderFixes(placeholders = [], { profileId = null } = {}) {
  const id = profileId || '<profile-id>';
  const profileFile = `config/profiles/${id}.json`;
  const activate = `\`npm run profiles activate ${id}\``;
  return placeholders.map(({ path = '', label, value, file }) => {
    let where;
    let how;
    if (file === 'config/candidate.json' && APPLICATION_PROFILE_PATH.test(path)) {
      where = 'Application profile';
      how = 'Open the account menu, choose Application profile, and fill in this field.';
    } else if (file === 'config/candidate.json' && path.startsWith('workAuthorization.')) {
      // Filled from this answer at load time (src/config/answerFallbacks.js).
      where = 'Application profile → Saved answers';
      how = 'Answer "work_authorization" with your real status. This value is filled from it.';
    } else if (file === 'config/candidate.json') {
      // Work history and education: what the resume already states.
      where = 'Master resume';
      how = `Use "Fill from my resume" in this notice, or edit the background section of ${profileFile} and run ${activate}.`;
    } else if (file === 'config/screening_answers.json') {
      where = 'Application profile → Saved answers';
      how = 'Open the account menu, choose Application profile, and replace this answer.';
    } else if (path === 'yearsOfExperience') {
      where = 'Application profile → Saved answers';
      how = 'Answer "years_experience", for example 8 years. This value is filled from it.';
    } else if (path === 'template.sponsorshipNote') {
      // Built from the stated status when sponsorship is required.
      where = 'Application profile → Saved answers';
      how = 'Answer "work_authorization" with your real status. The sentence is written from it.';
    } else {
      where = file;
      how = `Set ${path} in ${file} to your real value.`;
    }
    return { label, value: String(value ?? ''), where, how };
  });
}

/**
 * The Today queue: at most ten things the human should do next, most urgent
 * first (then by score), plus setup notices that block everything.
 *
 * Environmental failures are deliberately NOT items: when the browser is not
 * installed, every auto-fill row fails identically, and listing them one by
 * one filled the queue with the same non-actionable row. They collapse into a
 * single `browser_unavailable` notice instead.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object} [options.config]
 * @param {number} [options.limit=10]
 * @returns {{ generatedAt: string, items: object[], systemNotices: object[] }}
 */
/**
 * A plain-language warning for work on a posting older than the retention
 * window. Untouched rows that old are retired (rescoreStale); what remains is
 * work the user already invested in — a shortlist, a packet — which is kept,
 * but must not be presented as though it were current. Today once led with a
 * 67-day-old posting and said only "Its tailored resume and cover letter are
 * ready", with no hint that the role might long be filled.
 *
 * @returns {string|null}
 */
function staleCaveat(row, now, config) {
  const retention = Number(config?.exclusions?.staleness?.skipOlderThanDays) || 45;
  const age = ageInDays(row.postedAt, now);
  if (age === null || age <= retention) return null;
  return row.linkState === 'open'
    ? `Posted ${age} days ago; the employer still lists it.`
    : `Posted ${age} days ago and not confirmed open — use Check link before spending more time on it.`;
}

/**
 * Join a reason and a caveat without truncating the caveat away.
 */
function withCaveat(reason, caveat) {
  if (!caveat) return reason;
  const room = Math.max(0, TODAY_REASON_MAX - caveat.length - 1);
  const head = reason && reason.length > room ? `${reason.slice(0, Math.max(0, room - 1))}…` : reason;
  return head ? `${head} ${caveat}` : caveat;
}

export function todayQueue(db, {
  now = new Date(), config = null, limit = TODAY_LIMIT, browserAvailable = null,
} = {}) {
  const rows = openBoardRows(db, now);
  const candidates = [];
  const topUp = [];
  for (const row of rows) {
    // A posting its employer closed is never "worth your time" — checked FIRST,
    // or a closed job whose last fill also failed on a missing browser was
    // offered as "Retry auto-fill" (2026-09-23: Instacart and Backblaze).
    // Rows nobody acted on are already retired by the posting check; one you
    // shortlisted or prepared stays, and the only useful next step is to
    // archive it.
    if (row.linkState === 'closed') {
      // Only work the user put in earns an Archive chore; an untouched closed
      // row simply leaves the list (the posting check retires it).
      if ([APP_STATUS.SHORTLISTED, APP_STATUS.NEEDS_REVIEW, APP_STATUS.APPROVED, APP_STATUS.FAILED,
        APP_STATUS.BLOCKED, APP_STATUS.CANCELLED].includes(row.appStatus)) {
        candidates.push({ row, action: { rank: 9, kind: 'archive', label: 'Archive — the posting is closed', closed: true } });
      }
      continue;
    }
    if (isEnvironmentFailure(row)) {
      // Still non-actionable while the browser is missing (or unknown); once a
      // live check says it is installed, the job is ordinary retry work.
      if (browserAvailable === true) {
        candidates.push({
          row,
          action: { rank: 6, kind: 'autofill', label: 'Retry auto-fill', recovered: true },
        });
      }
      continue;
    }
    const action = todayAction(row);
    if (action) {
      const age = ageInDays(row.postedAt, now);
      if (age !== null && age > TODAY_AGING_DAYS && !AGING_EXEMPT.has(row.appStatus)) {
        // Below every fresh action, above housekeeping; same order within.
        candidates.push({ row, action: { ...action, rank: 8.5 + action.rank / 100, aging: age } });
      } else candidates.push({ row, action });
    }
    else {
      const extra = todayTopUp(row);
      if (extra) topUp.push({ row, action: extra });
    }
  }
  // Follow-ups the user set that have come due. A submitted row has no other
  // Today action, so a reminder never doubles up with one.
  candidates.push(...dueFollowUpCandidates(db, now, config));
  if (candidates.length < TODAY_LIMIT) {
    topUp.sort((a, b) => a.action.rank - b.action.rank || (b.row.score ?? -1) - (a.row.score ?? -1));
    candidates.push(...topUp.slice(0, TODAY_LIMIT - candidates.length));
  }
  candidates.sort((a, b) => a.action.rank - b.action.rank
    || (b.row.score ?? -1) - (a.row.score ?? -1)
    || String(a.row.id).localeCompare(String(b.row.id)));
  const take = Math.max(1, Math.min(TODAY_LIMIT, Number(limit) || TODAY_LIMIT));
  const items = candidates.slice(0, take).map(({ row, action }) => ({
    id: row.id,
    title: row.title,
    company: row.company ?? null,
    location: row.location ?? null,
    score: row.score,
    grade: row.grade,
    tier: row.tier,
    appStatus: row.appStatus,
    statusLabel: row.statusLabel ?? APP_STATUS_LABELS[row.appStatus] ?? row.appStatus,
    // Posting age stops mattering once you have applied, so a follow-up gets no stale caveat.
    reason: action.kind === 'followup' ? followUpReason(action)
      : action.closed ? todayReason(row, action) : withCaveat(todayReason(row, action), staleCaveat(row, now, config)),
    nextAction: { kind: action.kind, label: action.label },
    followUp: action.followUp ?? null,
    // Days since posting when the item was demoted for its age, else null.
    aging: action.aging ?? null,
    // Display-only signals, so a card can SAY whether a posting is aging,
    // held for a sponsorship check, unread, or closed instead of implying it.
    fit: row.fit ?? null,
    postedAt: row.postedAt ?? null,
    sponsorshipGated: row.sponsorshipGated === true,
    linkState: row.linkState ?? null,
  }));
  return {
    generatedAt: now.toISOString(), items, systemNotices: systemNotices(rows, config, { browserAvailable }),
    signInGroups: signInGroups(rows),
    // Patterns in what the person turns down, as proposals they can take or leave.
    proposals: (() => {
      try {
        const decided = db.db?.prepare?.(`SELECT id, company, user_decision, decision_reason, decided_at, status
          FROM jobs WHERE user_decision IN ('rejected', 'archived')`).all() ?? [];
        if (!decided.length) return [];
        const open = rows.filter((r) => !r.userDecision)
          .map((r) => ({ id: r.id, company: r.company, user_decision: null, status: r.appStatus }));
        return preferenceProposals([...decided, ...open], { now });
      } catch { return []; }
    })(),
  };
}

/** Columns for the rich CSV/spreadsheet export, in order. */
export const EXPORT_COLUMNS = Object.freeze([
  ['company', 'Company'], ['title', 'Role'], ['location', 'Location'],
  ['remote', 'Remote'], ['source', 'Source'], ['score', 'Score'],
  ['grade', 'Grade'], ['fit', 'Fit'], ['tier', 'Tier'],
  ['sponsorship', 'Sponsorship'], ['postedLabel', 'Posted'],
  ['postedConfidence', 'Posted confidence'], ['appStatus', 'Status'],
  ['stage', 'Pipeline stage'], ['resumeStatus', 'Resume'],
  ['atsPlatform', 'ATS'], ['matched', 'Matched skills'], ['missing', 'Missing skills'],
  ['blockers', 'Blockers'], ['notes', 'Notes'], ['url', 'URL'],
  ['appliedAt', 'Submitted at'], ['createdAt', 'Discovered at'], ['updatedAt', 'Last updated'],
  ['foundVia', 'Found via'],
  ['outcome', 'Outcome'], ['outcomeDate', 'Outcome date'], ['outcomeHistory', 'Outcome history'],
  ['followUpDue', 'Follow-up due'],
]);

/**
 * Build flat export records (one per job) with every detail the user asked to
 * export: score, grade, sponsorship confidence, resume status, form-fill /
 * blocker status, submission status, and notes.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options] { now, includeClosed }
 * @returns {object[]}
 */
export function buildExportRows(db, { now = new Date(), includeClosed = true } = {}) {
  // An export is a RECORD. Scoping it to the personalized board silently left a
  // job the user had applied to out of their own spreadsheet because they found
  // it through a role search; `foundVia` below keeps the two distinguishable.
  let rows = allBoardRows(db, now, EVERY_MODE);
  if (!includeClosed) {
    const closed = [APP_STATUS.ARCHIVED, APP_STATUS.DISCARDED];
    rows = rows.filter((r) => !closed.includes(r.appStatus));
  }
  // Same shared-cached-array hazard as boardPage's sort — copy before sorting.
  rows = rows.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const outcomeEvents = outcomeEventsByJob(db, rows.filter((r) => r.appStatus === APP_STATUS.SUBMITTED).map((r) => r.id));
  return rows.map((r) => ({
    company: r.company ?? '',
    title: r.title ?? '',
    location: r.location ?? '',
    remote: r.remote ? 'yes' : 'no',
    source: r.source ?? '',
    score: r.score ?? '',
    grade: r.grade?.letter ?? '',
    fit: r.fit ?? '',
    tier: r.tier ?? '',
    sponsorship: r.sponsorship ?? '',
    postedLabel: r.postedLabel ?? '',
    postedConfidence: r.postedConfidence ?? '',
    appStatus: r.appStatus ?? '',
    stage: r.progress?.stage ?? '',
    resumeStatus: r.resumeStatus ?? '',
    atsPlatform: r.atsPlatform ?? '',
    matched: (r.matchedKeywords ?? []).join('; '),
    missing: (r.missingKeywords ?? []).join('; '),
    blockers: (r.assistBlockers ?? []).join('; '),
    notes: r.notes ?? '',
    url: r.url ?? '',
    appliedAt: r.appliedAt ?? '',
    createdAt: r.createdAt ?? '',
    updatedAt: r.updatedAt ?? '',
    foundVia: r.discoveryMode === 'role_search'
      ? `Role search: ${r.searchQuery ?? 'unnamed'}`
      : 'My profile',
    ...(r.appStatus === APP_STATUS.SUBMITTED ? outcomeExport(outcomeEvents.get(r.id) ?? []) : NO_OUTCOME_EXPORT),
  }));
}


/**
 * Serialize export rows to a CSV string with a human-friendly header row.
 * @param {object[]} rows from buildExportRows()
 * @returns {string}
 */
export function exportRowsToCsv(rows = []) {
  const header = EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((r) => EXPORT_COLUMNS.map(([key]) => csvCell(r[key])).join(',')).join('\r\n');
  return body ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

/**
 * Rows with a generated document on record, every discovery mode. The SQL
 * narrows to those rows (db.listDocumentJobs); stubs without it fall back to
 * the whole table, and the filter below is kept either way so both paths
 * treat an empty-string path exactly alike.
 */
function documentRows(db) {
  const rows = typeof db.listDocumentJobs === 'function' ? db.listDocumentJobs() : listSummaryRows(db, EVERY_MODE);
  return rows.filter((j) => j.resume_docx_path || j.resume_path || j.resume_pdf_path
    || j.cover_letter_path || j.application_packet_path);
}

/* ───────────────────────────── reports ───────────────────────────── */

/** Compact row for report lists (what a reviewer needs, nothing more). */
function reportRow(r) {
  return {
    id: r.id, company: r.company, title: r.title, url: r.url, source: r.source,
    score: r.score, grade: r.grade, sponsorship: r.sponsorship,
    appStatus: r.appStatus, postedLabel: r.postedLabel,
    appliedAt: r.appliedAt, confirmation: r.submittedConfirmation,
    blockers: r.assistBlockers ?? [], notes: r.notes ?? '',
  };
}

/**
 * Build the view-first reports bundle for the Reports drawer: read it on
 * screen FIRST, then export. All sections derive from the same board rows so
 * the numbers always reconcile with the table and tiles.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object} [options.config] loadConfig() bundle — supplies the
 *   candidate timezone so "today" means the user's day, not the UTC day
 * @returns {object} { generatedAt, dailySummary, applicationLog, preparedPackets,
 *                     blockedJobs, skippedJobs, sponsorshipSummary, sourcePerformance }
 */
export function buildReports(db, { now = new Date(), config = null } = {}) {
  // Cached by the same data key as the board (plus the zone, like stats).
  // Measured live: 3.3 s per open of the Reports drawer, cold AND warm — it
  // decorated and filtered all 122,977 rows, discard pile included, every time.
  return cachedSwr(db, `reports:${candidateTimeZone(config) ?? 'utc'}`, now,
    () => computeReports(db, now, config));
}

function computeReports(db, now, config) {
  const stats = dashboardStats(db, { now, config });
  // Every status a report lists (submitted, rejected/archived, skipped,
  // blocked, ready, prepared, approved) survives the open-rows prefilter,
  // which only drops PROVABLY discarded rows — and no report section lists a
  // discarded row. Same rows as the old whole-table read, ~2% of the work.
  const rows = openBoardRows(db, now);

  const byStatus = (status) => rows.filter((r) => r.appStatus === status).map(reportRow);

  // Application log: every job the human acted on (or that stopped), newest first.
  const LOG_STATUSES = new Set([
    APP_STATUS.SUBMITTED, APP_STATUS.SUBMIT_UNVERIFIED, APP_STATUS.SKIPPED,
    APP_STATUS.BLOCKED, APP_STATUS.REJECTED, APP_STATUS.ARCHIVED,
    APP_STATUS.READY_FOR_SUBMIT,
  ]);
  const applicationLog = rows
    .filter((r) => LOG_STATUSES.has(r.appStatus))
    .sort((a, b) => String(b.appliedAt ?? b.updatedAt ?? '')
      .localeCompare(String(a.appliedAt ?? a.updatedAt ?? '')))
    .map(reportRow);

  const sponsorshipSummary = Object.entries(stats.bySponsorship)
    .map(([confidence, v]) => ({ confidence, jobs: v.count, strongFit: v.strong }))
    .sort((a, b) => b.jobs - a.jobs);

  const sourcePerformance = Object.entries(stats.bySource)
    .map(([source, v]) => ({
      source, found: v.found, strong: v.strong, prepared: v.prepared, submitted: v.submitted,
      // Conversion: how much of what a source finds is actually worth acting on.
      strongRate: v.found ? Math.round((v.strong / v.found) * 100) : 0,
    }))
    .sort((a, b) => b.found - a.found);

  return {
    generatedAt: now.toISOString(),
    dailySummary: { totals: stats.totals, daily: stats.daily },
    applicationLog,
    preparedPackets: byStatus(APP_STATUS.NEEDS_REVIEW)
      .concat(byStatus(APP_STATUS.APPROVED)),
    blockedJobs: byStatus(APP_STATUS.BLOCKED),
    skippedJobs: byStatus(APP_STATUS.SKIPPED),
    sponsorshipSummary,
    sourcePerformance,
  };
}

/**
 * Documents view: the master resume plus every tailored resume / cover letter
 * the agent generated, newest first. This is the resume "version history" —
 * one tailored version per prepared job, each traceable to its job and packet.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options] { root, now, statImpl }
 * @returns {{ master: object|null, tailored: object[] }}
 */
export function buildDocuments(db, {
  root = null, now = new Date(), statImpl = null, readFileImpl = null,
} = {}) {
  const stat = statImpl ?? ((p) => {
    try {
      const s = statSync(p);
      return { exists: true, bytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch { return { exists: false, bytes: 0, modifiedAt: null }; }
  });

  let master = null;
  if (root) {
    const masterPath = masterResumeFile(root);
    master = { path: masterPath, ...stat(masterPath) };
  }

  const approvals = approvalsByJob(db);
  const readPacket = readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  const fileInfo = (path) => (path ? { path, ...stat(path) } : null);
  // Documents on disk belong to whoever made them, not to a search mode: a
  // packet prepared from a role-search job is still the user's document and
  // must be findable here.
  const rows = documentRows(db)
    .map((j) => {
      let packet = null;
      let packetError = null;
      if (j.application_packet_path) {
        try { packet = JSON.parse(readPacket(j.application_packet_path)); }
        catch (err) { packetError = `packet unreadable: ${err.message}`; }
      }
      const resumeDocx = j.resume_docx_path ?? j.resume_path ?? null;
      const tailoring = packet?.tailoring ?? null;
      const changes = Array.isArray(tailoring?.changes) ? tailoring.changes : [];
      const gaps = Array.isArray(tailoring?.gaps) ? tailoring.gaps : [];
      return {
        jobId: j.id,
        company: j.company,
        title: j.title,
        preparedAt: preparedAtOf(j),
        tailored: packet ? Boolean(packet.resumeTailored) : Boolean(resumeDocx),
        resumeDocx,
        resumePdf: j.resume_pdf_path ?? null,
        coverLetter: j.cover_letter_path ?? null,
        packet: j.application_packet_path ?? null,
        folder: j.output_folder_path ?? null,
        files: {
          resumeDocx: fileInfo(resumeDocx),
          resumePdf: fileInfo(j.resume_pdf_path),
          coverLetter: fileInfo(j.cover_letter_path),
          packet: fileInfo(j.application_packet_path),
        },
        atsScore: j.ats_score == null || j.ats_score === '' ? null : Number(j.ats_score),
        atsBand: j.ats_band ?? null,
        appStatus: deriveAppStatus(j, approvals.get(j.id) ?? null),
        resumeWarning: packet?.resumeWarning ?? null,
        tailoring: tailoring ? {
          changes,
          gaps,
          summaryLine: tailoring.summaryLine ?? null,
          changeCount: changes.length,
          gapCount: gaps.length,
          pageCount: tailoring.pageCount ?? null,
          estimatedPages: tailoring.estimatedPages ?? null,
        } : null,
        provenance: packet ? {
          packetId: packet.id ?? null,
          packetCreatedAt: packet.createdAt ?? null,
          stopBeforeSubmit: packet.stopBeforeSubmit !== false,
          source: 'application packet',
        } : null,
        packetError,
      };
    })
    .sort((a, b) => String(b.preparedAt ?? '').localeCompare(String(a.preparedAt ?? '')));

  return { generatedAt: now.toISOString(), master, tailored: rows };
}

/** Where the master resume lives, and where replaced copies are kept. */
/** The ORIGINAL workspace's master resume and history; other workspaces resolve through workspacePaths(). */
export const MASTER_RESUME_RELATIVE = join('resumes', 'base', 'MASTER_RESUME.docx');
export const MASTER_HISTORY_RELATIVE = join('resumes', 'base', 'history');

/**
 * Everything the master-resume screen needs: the file's metadata, its readable
 * text (so the user can VERIFY the document tailoring reads, not just its
 * filename), previous versions kept when it was replaced, and how many already
 * tailored resumes predate the current master and are therefore stale.
 *
 * Never throws: a missing/unreadable master is a normal first-run state and the
 * screen has to explain it rather than 500.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {string|null} [options.root] workspace root (null -> unavailable)
 * @param {Date} [options.now]
 * @param {Function} [options.readFileImpl] (path) => Buffer
 * @param {Function} [options.statImpl] (path) => { exists, bytes, modifiedAt }
 * @param {Function} [options.listDirImpl] (path) => string[]
 * @param {number} [options.previewParagraphs] cap on returned paragraphs
 * @returns {object}
 */
export function buildMasterResume(db, {
  root = null, now = new Date(), readFileImpl = null, statImpl = null,
  listDirImpl = null, previewParagraphs = 400,
} = {}) {
  const stat = statImpl ?? ((p) => {
    try {
      const s = statSync(p);
      return { exists: s.isFile(), bytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch { return { exists: false, bytes: 0, modifiedAt: null }; }
  });
  if (!root) {
    return {
      generatedAt: now.toISOString(),
      available: false,
      reason: 'no workspace root is configured, so the master resume cannot be located',
      exists: false, path: null, relativePath: MASTER_RESUME_RELATIVE,
      bytes: 0, modifiedAt: null, wordCount: null, paragraphCount: null,
      paragraphs: [], truncated: false, textError: null, backups: [], stalePackets: 0,
    };
  }

  // The ACTIVE person's resume: each workspace keeps its own.
  const paths = workspacePaths(root);
  const path = paths.resume;
  const info = stat(path);
  let paragraphs = [];
  let wordCount = null;
  let truncated = false;
  let textError = null;
  if (info.exists) {
    try {
      const read = readFileImpl ?? ((p) => readFileSync(p));
      const extracted = extractDocxText(read(path));
      wordCount = extracted.wordCount;
      truncated = extracted.paragraphs.length > previewParagraphs;
      paragraphs = extracted.paragraphs.slice(0, previewParagraphs);
    } catch (err) {
      // A present-but-unreadable master is exactly the case worth surfacing:
      // tailoring will fall back to it verbatim and the user needs to know.
      textError = err.message;
    }
  }

  const listDir = listDirImpl ?? ((p) => {
    try { return readdirSync(p); } catch { return []; }
  });
  const historyDir = paths.history;
  const backups = listDir(historyDir)
    .filter((name) => /^MASTER_RESUME\..+\.docx$/i.test(name))
    .map((name) => ({ name, ...stat(join(historyDir, name)) }))
    .filter((b) => b.exists)
    .sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')));

  // Tailored resumes generated BEFORE the current master no longer reflect it.
  const stalePackets = info.modifiedAt
    ? documentRows(db).filter((j) => {
      const preparedAt = preparedAtOf(j);
      return (j.resume_docx_path || j.resume_path) && preparedAt
        && preparedAt < info.modifiedAt;
    }).length
    : 0;

  return {
    generatedAt: now.toISOString(),
    available: true,
    reason: null,
    path,
    relativePath: relative(root, path),
    exists: info.exists,
    bytes: info.bytes,
    modifiedAt: info.modifiedAt,
    wordCount,
    paragraphCount: paragraphs.length,
    paragraphs,
    truncated,
    textError,
    backups,
    stalePackets,
  };
}
