/**
 * What happened to an application AFTER it was submitted, and the follow-up
 * reminders the user sets to chase it.
 *
 * WHY A SEPARATE VOCABULARY. APP_STATUS (appStatus.js) answers "where is the
 * AUTOMATION with this job": prepared, approved, filled, submitted. Nothing
 * after `submitted` is the system's doing — an interview, an offer, a
 * rejection — and folding those into `jobs.status` would let a pipeline write
 * erase a hiring outcome, or let an outcome claim a submission nobody made.
 * Outcomes are therefore recorded only as append-only `application_events`,
 * layered on top of a SUBMITTED row. They never touch `jobs.status`,
 * `jobs.applied` or `jobs.user_decision`, and no schema change is needed.
 *
 * Every function here is pure: events in, a summary out.
 */

/** Event type for an outcome the user recorded (and for its undo). */
export const OUTCOME_EVENT = 'application_outcome';

/** Event type for a follow-up reminder being set, done or dismissed. */
export const FOLLOWUP_EVENT = 'application_followup';

/** The recruiting outcomes a submitted application can have. */
export const OUTCOME = Object.freeze({
  APPLIED: 'applied',             // submitted, nothing heard yet
  INTERVIEWING: 'interviewing',   // any interview, screen or assessment
  OFFER: 'offer',                 // an offer is on the table
  HIRED: 'hired',                 // offer accepted
  REJECTED: 'rejected',           // the EMPLOYER said no (not the user's triage "Rejected")
  WITHDRAWN: 'withdrawn',         // the user pulled out
});

/** Words for each outcome. "Rejected by employer" so it never reads as the user's own Reject. */
export const OUTCOME_LABELS = Object.freeze({
  [OUTCOME.APPLIED]: 'Awaiting response',
  [OUTCOME.INTERVIEWING]: 'Interviewing',
  [OUTCOME.OFFER]: 'Offer received',
  [OUTCOME.HIRED]: 'Hired',
  [OUTCOME.REJECTED]: 'Rejected by employer',
  [OUTCOME.WITHDRAWN]: 'Withdrawn',
});

/** How far along the hiring process an outcome is. Exits have no position. */
const PROGRESS = Object.freeze({
  [OUTCOME.APPLIED]: 0, [OUTCOME.INTERVIEWING]: 1, [OUTCOME.OFFER]: 2, [OUTCOME.HIRED]: 3,
});

/** Outcomes that end an application. Correcting one is an undo, not a move. */
export const TERMINAL_OUTCOMES = new Set([OUTCOME.HIRED, OUTCOME.REJECTED, OUTCOME.WITHDRAWN]);

/** Every outcome value, for validation. */
export const OUTCOME_VALUES = Object.freeze(Object.values(OUTCOME));

/**
 * Whether an application at `from` may move to `to`.
 *
 * Forward only (an interview can follow an application, never precede it),
 * skipping allowed (some roles hire without a separate interview), and the two
 * exits are open from anywhere that is not already final. A mistake is fixed
 * with undo, which restores exactly what the move replaced — so there is no
 * free-for-all edge that could quietly rewrite history.
 *
 * @param {string|null} from current outcome; null means `applied`
 * @param {string} to
 * @returns {boolean}
 */
export function canRecordOutcome(from, to) {
  const current = from ?? OUTCOME.APPLIED;
  if (!OUTCOME_VALUES.includes(to) || current === to) return false;
  if (TERMINAL_OUTCOMES.has(current)) return false;
  if (to === OUTCOME.REJECTED || to === OUTCOME.WITHDRAWN) return true;
  return PROGRESS[to] > PROGRESS[current];
}

/** The outcomes an application at `from` can move to, in process order. */
export function allowedOutcomes(from) {
  return OUTCOME_VALUES.filter((to) => canRecordOutcome(from, to));
}

/** True for a real calendar day written as YYYY-MM-DD. */
export function isIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** Whole days from day `a` to day `b` (both YYYY-MM-DD); negative when b is earlier. */
export function daysBetween(a, b) {
  if (!isIsoDay(a) || !isIsoDay(b)) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Parse an event's metadata, which the db hands back as JSON text. */
function metaOf(event) {
  const raw = event?.metadata ?? null;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Replay one job's outcome events into its current outcome and history.
 *
 * Each recorded outcome is pushed; each undo pops the one it reverses. What
 * is left is the effective chain, so a mis-click that was undone never counts
 * as an interview in the numbers.
 *
 * @param {object[]} events this job's OUTCOME_EVENT rows, oldest first
 * @returns {{ current: {outcome: string, label: string, on: string|null, at: string|null, note: string|null}|null,
 *             history: object[], reached: string }}
 */
export function replayOutcomes(events = []) {
  const chain = [];
  for (const event of events) {
    if (event?.event_type && event.event_type !== OUTCOME_EVENT) continue;
    const meta = metaOf(event);
    if (!meta) continue;
    if (meta.undo === true) { chain.pop(); continue; }
    if (!OUTCOME_VALUES.includes(meta.outcome)) continue;
    chain.push({
      outcome: meta.outcome,
      label: OUTCOME_LABELS[meta.outcome],
      on: isIsoDay(meta.on) ? meta.on : null,
      at: event.created_at ?? null,
      note: typeof meta.note === 'string' && meta.note ? meta.note : null,
    });
  }
  let reached = OUTCOME.APPLIED;
  for (const step of chain) {
    if ((PROGRESS[step.outcome] ?? -1) > PROGRESS[reached]) reached = step.outcome;
  }
  return { current: chain.length ? chain[chain.length - 1] : null, history: chain, reached };
}

/**
 * Replay one job's follow-up events into the reminder that is still open.
 *
 * @param {object[]} events this job's FOLLOWUP_EVENT rows, oldest first
 * @returns {{ open: {dueOn: string, note: string|null, setAt: string|null}|null,
 *             last: {action: string, at: string|null}|null }}
 */
export function replayFollowUps(events = []) {
  let open = null;
  let last = null;
  for (const event of events) {
    if (event?.event_type && event.event_type !== FOLLOWUP_EVENT) continue;
    const meta = metaOf(event);
    if (!meta) continue;
    if (meta.action === 'set' && isIsoDay(meta.dueOn)) {
      open = { dueOn: meta.dueOn, note: typeof meta.note === 'string' && meta.note ? meta.note : null, setAt: event.created_at ?? null };
    } else if (meta.action === 'done' || meta.action === 'dismissed') {
      open = null;
    } else {
      continue;
    }
    last = { action: meta.action, at: event.created_at ?? null };
  }
  return { open, last };
}

/**
 * The workspace's columns, in the order an application moves through them.
 * The first three are the automation's stages (driven by the existing
 * approval and fill flow); the last four are recruiting outcomes the user
 * records once the application is submitted.
 */
export const WORKSPACE_STAGES = Object.freeze([
  { key: 'review', label: 'To review', hint: 'Tailored resume ready for you to read and approve', phase: 'prepare' },
  { key: 'ready', label: 'Ready to apply', hint: 'Approved, or filled and waiting for your Submit', phase: 'prepare' },
  { key: 'attention', label: 'Needs you', hint: 'Stopped, failed, or a submission to confirm', phase: 'prepare' },
  { key: 'applied', label: 'Applied', hint: 'Submitted and waiting to hear back', phase: 'outcome' },
  { key: 'interviewing', label: 'Interviewing', hint: 'Screens, interviews and assessments', phase: 'outcome' },
  { key: 'offer', label: 'Offer', hint: 'An offer to decide on', phase: 'outcome' },
  { key: 'closed', label: 'Closed', hint: 'Hired, rejected by the employer, or withdrawn', phase: 'outcome' },
]);

/** Outcome-phase column -> the outcome a move into it records. */
export const STAGE_OUTCOME = Object.freeze({
  applied: OUTCOME.APPLIED, interviewing: OUTCOME.INTERVIEWING, offer: OUTCOME.OFFER,
});

/**
 * Which column a job sits in, or null when it is not an application yet.
 * @param {string} appStatus an APP_STATUS value
 * @param {string|null} outcome current recorded outcome
 */
export function stageOf(appStatus, outcome = null) {
  switch (appStatus) {
    case 'needs_review': return 'review';
    case 'approved': case 'ready_for_submit': return 'ready';
    case 'blocked': case 'failed': case 'cancelled': case 'submit_unverified': return 'attention';
    case 'submitted':
      if (outcome === OUTCOME.INTERVIEWING) return 'interviewing';
      if (outcome === OUTCOME.OFFER) return 'offer';
      if (outcome && TERMINAL_OUTCOMES.has(outcome)) return 'closed';
      return 'applied';
    default: return null;
  }
}

/** Days without a response after which an application is flagged as waiting. */
export const AWAITING_RESPONSE_DAYS = 14;

/**
 * Concise, factual numbers from what was RECORDED — no projections.
 *
 * Interviews and offers count applications that ever REACHED that stage, so
 * one that interviewed and was then rejected still counts as an interview.
 * Rates carry their numerator and denominator, so "50%" from 1 of 2 is never
 * shown without the counts that qualify it.
 *
 * @param {Array<{stage: string, appStatus: string, reached?: string, followUp?: {due: boolean}|null,
 *                awaitingDays?: number|null, outcome?: {outcome: string}|null}>} items
 */
export function applicationMetrics(items = []) {
  const byStage = Object.fromEntries(WORKSPACE_STAGES.map((s) => [s.key, 0]));
  let submitted = 0; let interviews = 0; let offers = 0; let hired = 0;
  let rejected = 0; let withdrawn = 0; let followUpsDue = 0; let awaiting = 0;
  for (const item of items) {
    if (item.stage in byStage) byStage[item.stage] += 1;
    if (item.followUp?.due) followUpsDue += 1;
    if (item.appStatus !== 'submitted') continue;
    submitted += 1;
    const reached = PROGRESS[item.reached] ?? 0;
    if (reached >= PROGRESS[OUTCOME.INTERVIEWING]) interviews += 1;
    if (reached >= PROGRESS[OUTCOME.OFFER]) offers += 1;
    const current = item.outcome?.outcome;
    if (current === OUTCOME.HIRED) hired += 1;
    if (current === OUTCOME.REJECTED) rejected += 1;
    if (current === OUTCOME.WITHDRAWN) withdrawn += 1;
    if (item.stage === 'applied' && (item.awaitingDays ?? 0) >= AWAITING_RESPONSE_DAYS) awaiting += 1;
  }
  const rate = (n, of) => ({ n, of, pct: of ? Math.round((n / of) * 100) : null });
  return {
    submitted, interviews, offers, hired, rejected, withdrawn, followUpsDue, awaiting, byStage,
    rates: { interview: rate(interviews, submitted), offer: rate(offers, interviews) },
  };
}

/** Fewer submitted applications than this in a cell: no rate is shown. */
export const MIN_CONVERSION_CELL = 5;

/** "70-79" for a score of 74; null when unscored. */
export function scoreBand(score) {
  const n = Number(score);
  if (score == null || !Number.isFinite(n)) return null;
  const low = Math.max(0, Math.min(90, Math.floor(n / 10) * 10));
  return low === 90 ? '90-100' : `${low}-${low + 9}`;
}

/**
 * How soon after posting an application went in (audit Backlog #16): the
 * question "does applying early pay off for ME?" can only be answered from
 * the person's own recorded outcomes. Null when either date is missing.
 */
export function applySpeedBand(postedAt, appliedAt) {
  const p = Date.parse(postedAt ?? '');
  const a = Date.parse(appliedAt ?? '');
  if (!Number.isFinite(p) || !Number.isFinite(a) || a < p) return null;
  const days = (a - p) / 86_400_000;
  if (days < 1) return 'within a day';
  if (days <= 3) return '1-3 days';
  if (days <= 7) return '4-7 days';
  return 'over a week';
}

/**
 * Which kinds of applications lead to interviews (P2-9): for each source,
 * ATS, score band and tier, how many submitted applications reached an
 * interview. A cell with fewer than MIN_CONVERSION_CELL applications shows
 * its counts but no rate ("too few to tell"), so a 1-of-2 never reads as 50%.
 * Recorded facts only; nothing is projected.
 */
export function conversionBreakdown(items = [], { minCell = MIN_CONVERSION_CELL } = {}) {
  const dims = {
    source: (i) => i.source, ats: (i) => i.atsPlatform, scoreBand: (i) => scoreBand(i.score), tier: (i) => i.tier,
    applySpeed: (i) => applySpeedBand(i.postedAt, i.appliedAt),
  };
  const out = {};
  for (const [dim, keyOf] of Object.entries(dims)) {
    const cells = new Map();
    for (const item of items) {
      if (item.appStatus !== 'submitted') continue;
      const key = keyOf(item) || 'unknown';
      const cell = cells.get(key) ?? { key, submitted: 0, interviews: 0, offers: 0 };
      cell.submitted += 1;
      const reached = PROGRESS[item.reached] ?? 0;
      if (reached >= PROGRESS[OUTCOME.INTERVIEWING]) cell.interviews += 1;
      if (reached >= PROGRESS[OUTCOME.OFFER]) cell.offers += 1;
      cells.set(key, cell);
    }
    out[dim] = [...cells.values()]
      .map((c) => ({ ...c, tooFew: c.submitted < minCell, interviewRate: c.submitted >= minCell ? Math.round((c.interviews / c.submitted) * 100) : null }))
      .sort((a, b) => b.submitted - a.submitted || a.key.localeCompare(b.key));
  }
  return { minCell, ...out };
}

/** Empty export cells, for a job that was never submitted. */
export const NO_OUTCOME_EXPORT = Object.freeze({ outcome: '', outcomeDate: '', outcomeHistory: '', followUpDue: '' });

/**
 * Spreadsheet cells for one SUBMITTED application's recorded outcome, shared
 * by the tracker CSV and the jobs export so the two never word it apart.
 * The history lists every outcome still in effect, oldest first; an undone
 * one is not history, it was a mistake.
 *
 * @param {object[]} events this job's OUTCOME_EVENT and FOLLOWUP_EVENT rows, oldest first
 * @returns {{outcome: string, outcomeDate: string, outcomeHistory: string, followUpDue: string}}
 */
export function outcomeExport(events = []) {
  const { current, history } = replayOutcomes(events.filter((e) => e.event_type === OUTCOME_EVENT));
  const { open } = replayFollowUps(events.filter((e) => e.event_type === FOLLOWUP_EVENT));
  return {
    outcome: current?.label ?? OUTCOME_LABELS[OUTCOME.APPLIED],
    outcomeDate: current?.on ?? '',
    outcomeHistory: history.map((h) => (h.on ? `${h.label} ${h.on}` : h.label)).join('; '),
    // A closed application has nothing left to chase (as on the board).
    followUpDue: current && TERMINAL_OUTCOMES.has(current.outcome) ? '' : open?.dueOn ?? '',
  };
}

/** Events for the given jobs grouped by job id, from any db exposing listEventsForJobs. */
export function outcomeEventsByJob(db, jobIds = []) {
  const out = new Map();
  if (!jobIds.length || typeof db?.listEventsForJobs !== 'function') return out;
  for (const event of db.listEventsForJobs(jobIds, [OUTCOME_EVENT, FOLLOWUP_EVENT])) {
    if (!out.has(event.job_id)) out.set(event.job_id, []);
    out.get(event.job_id).push(event);
  }
  return out;
}

/** The calendar day `n` days after `day` (YYYY-MM-DD; negative goes back). */
export function shiftDay(day, n) {
  if (!isIsoDay(day)) return null;
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/**
 * The week in one glance: what was submitted, what came back, what was chased
 * — over the user's last seven calendar days — and what is due in the next
 * seven. Counts only what was recorded; an undone outcome does not count.
 *
 * @param {object} args
 * @param {Array<{id: string, appStatus: string, appliedOn?: string|null, followUp?: object|null, stage: string}>} args.items
 * @param {Map<string, object[]>} args.eventsByJob outcome + follow-up events, oldest first
 * @param {string} args.today YYYY-MM-DD in the user's timezone
 * @param {(iso: string) => string} [args.dayOf] instant -> the user's calendar day
 */
export function weeklySummary({ items = [], eventsByJob = new Map(), today, dayOf = (iso) => String(iso ?? '').slice(0, 10) }) {
  const from = shiftDay(today, -6);
  const until = shiftDay(today, 7);
  const inWeek = (day) => Boolean(day) && day >= from && day <= today;
  const responses = { interviewing: 0, offer: 0, hired: 0, rejected: 0, withdrawn: 0 };
  let submitted = 0; let followUpsDone = 0; let followUpsDueSoon = 0; let followUpsOverdue = 0;
  for (const item of items) {
    if (item.appStatus !== 'submitted') continue;
    if (inWeek(item.appliedOn)) submitted += 1;
    const events = eventsByJob.get(item.id) ?? [];
    for (const step of replayOutcomes(events.filter((e) => e.event_type === OUTCOME_EVENT)).history) {
      if (inWeek(step.on) && step.outcome in responses) responses[step.outcome] += 1;
    }
    for (const e of events) {
      if (e.event_type !== FOLLOWUP_EVENT) continue;
      const meta = metaOf(e);
      if (meta?.action === 'done' && inWeek(dayOf(e.created_at))) followUpsDone += 1;
    }
    if (item.followUp) {
      if (item.followUp.due) followUpsOverdue += 1;
      else if (item.followUp.dueOn <= until) followUpsDueSoon += 1;
    }
  }
  const responsesTotal = Object.values(responses).reduce((a, b) => a + b, 0);
  return { from, to: today, submitted, responses, responsesTotal, followUpsDone, followUpsDueSoon, followUpsOverdue };
}
