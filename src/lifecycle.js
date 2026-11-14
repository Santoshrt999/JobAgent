/**
 * Job lifecycle status vocabulary.
 *
 * Every discovered job moves through a well-defined set of states. These labels
 * are written into the output artifacts (found/scored/queued_jobs.json) and the
 * jobs table so a human can see exactly what happened to each job and where it
 * currently sits in the pipeline.
 *
 * Flow (happy path):
 *   found -> scored -> queued -> prepared -> assist_started -> ready_for_submit
 *         -> submitted
 *
 * Off-ramps:
 *   found -> hard_discarded          (exclusion rule matched)
 *   found -> unknown_date_review     (no posting date; held for human review)
 *   scored -> near_miss              (scored below the queue threshold)
 *   assist_started -> assist_blocked (captcha/login/mfa/unknown question/etc.)
 *   assist_started -> submit_unverified (opt-in auto-submit clicked Submit but
 *                                     no confirmation page was detected — the
 *                                     human must verify before it counts)
 *   any -> failed                    (unexpected error)
 */

export const LIFECYCLE = Object.freeze({
  FOUND: 'found',
  HARD_DISCARDED: 'hard_discarded',
  // Written to jobs.status by the pipeline for excluded / below-threshold rows.
  // It was NOT in this vocabulary even though it is by far the most common
  // value in the store (97,230 of 102,099 rows), which is how the vocabulary
  // came to disagree with the column it is supposed to describe.
  DISCARDED: 'discarded',
  // The source returned a title and no description, so the row has NOT been
  // judged. Also written to jobs.status and also missing from every vocabulary
  // — and because deriveAppStatus had no case for it, 4,732 unread rows were
  // reported to the user as "Scored". That is the defect this file now guards.
  NEEDS_DESCRIPTION: 'needs_description',
  UNKNOWN_DATE_REVIEW: 'unknown_date_review',
  SCORED: 'scored',
  NEAR_MISS: 'near_miss',
  QUEUED: 'queued',
  PREPARED: 'prepared',
  ASSIST_STARTED: 'assist_started',
  ASSIST_BLOCKED: 'assist_blocked',
  READY_FOR_SUBMIT: 'ready_for_submit',
  SUBMIT_UNVERIFIED: 'submit_unverified',
  SUBMITTED: 'submitted',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

/** All known lifecycle values (handy for validation/tests). */
export const LIFECYCLE_VALUES = Object.freeze(Object.values(LIFECYCLE));

/**
 * Which states may legally follow which.
 *
 * Transitions were implicit everywhere: no function owned "which states may
 * follow this one", so a new status could be introduced by one writer and
 * silently mishandled by three readers — which is exactly what happened with
 * `needs_description`. This map is the explicit contract.
 *
 * `null` predecessors are entry points (a row first appearing in the store).
 * FAILED is reachable from anywhere: an unexpected error is not a state the
 * pipeline chooses.
 */
export const TRANSITIONS = Object.freeze({
  [LIFECYCLE.FOUND]: [
    LIFECYCLE.SCORED, LIFECYCLE.NEEDS_DESCRIPTION, LIFECYCLE.HARD_DISCARDED,
    LIFECYCLE.DISCARDED, LIFECYCLE.UNKNOWN_DATE_REVIEW,
  ],
  // An enriched row rejoins the normal flow; it can also be discarded once read.
  [LIFECYCLE.NEEDS_DESCRIPTION]: [
    LIFECYCLE.SCORED, LIFECYCLE.NEAR_MISS, LIFECYCLE.QUEUED,
    LIFECYCLE.DISCARDED, LIFECYCLE.HARD_DISCARDED,
  ],
  [LIFECYCLE.UNKNOWN_DATE_REVIEW]: [
    LIFECYCLE.SCORED, LIFECYCLE.QUEUED, LIFECYCLE.DISCARDED, LIFECYCLE.HARD_DISCARDED,
  ],
  [LIFECYCLE.SCORED]: [LIFECYCLE.QUEUED, LIFECYCLE.NEAR_MISS, LIFECYCLE.DISCARDED],
  [LIFECYCLE.NEAR_MISS]: [LIFECYCLE.QUEUED, LIFECYCLE.DISCARDED],
  [LIFECYCLE.QUEUED]: [LIFECYCLE.PREPARED, LIFECYCLE.SKIPPED, LIFECYCLE.DISCARDED],
  // QUEUED / DISCARDED from a packet state: the packet was superseded (built
  // for another profile, file gone) or its posting closed — see
  // apply/packetHygiene.js and db.supersedePacket.
  [LIFECYCLE.PREPARED]: [
    LIFECYCLE.ASSIST_STARTED, LIFECYCLE.SUBMITTED, LIFECYCLE.SKIPPED, LIFECYCLE.QUEUED, LIFECYCLE.DISCARDED,
  ],
  [LIFECYCLE.ASSIST_STARTED]: [
    LIFECYCLE.READY_FOR_SUBMIT, LIFECYCLE.ASSIST_BLOCKED,
    LIFECYCLE.SUBMIT_UNVERIFIED, LIFECYCLE.SUBMITTED, LIFECYCLE.CANCELLED,
  ],
  // Re-entry is deliberate: a resumed run performs a fresh precheck.
  // SUBMIT_UNVERIFIED: the human finished a blocked form in the window we left
  // open and the hand-off watch saw a confirmation page — still unconfirmed.
  [LIFECYCLE.ASSIST_BLOCKED]: [
    LIFECYCLE.ASSIST_STARTED, LIFECYCLE.SKIPPED, LIFECYCLE.SUBMITTED, LIFECYCLE.SUBMIT_UNVERIFIED,
    LIFECYCLE.QUEUED, LIFECYCLE.DISCARDED,
  ],
  [LIFECYCLE.CANCELLED]: [LIFECYCLE.ASSIST_STARTED, LIFECYCLE.SKIPPED, LIFECYCLE.QUEUED, LIFECYCLE.DISCARDED],
  [LIFECYCLE.READY_FOR_SUBMIT]: [LIFECYCLE.SUBMITTED, LIFECYCLE.SUBMIT_UNVERIFIED, LIFECYCLE.SKIPPED],
  // Only the human resolves an unverified submit, in either direction.
  [LIFECYCLE.SUBMIT_UNVERIFIED]: [LIFECYCLE.SUBMITTED, LIFECYCLE.SKIPPED],
  [LIFECYCLE.FAILED]: [LIFECYCLE.ASSIST_STARTED, LIFECYCLE.SKIPPED, LIFECYCLE.QUEUED, LIFECYCLE.DISCARDED],
  [LIFECYCLE.SKIPPED]: [LIFECYCLE.QUEUED, LIFECYCLE.ASSIST_STARTED],
  [LIFECYCLE.DISCARDED]: [LIFECYCLE.SCORED, LIFECYCLE.QUEUED],
  [LIFECYCLE.HARD_DISCARDED]: [],
  // Terminal. Nothing follows a confirmed submission.
  [LIFECYCLE.SUBMITTED]: [],
});

/** States reachable from any other (an unexpected error is not a choice). */
const ALWAYS_REACHABLE = Object.freeze([LIFECYCLE.FAILED]);

/**
 * States a HUMAN may move a job to from any non-terminal state.
 *
 * "I submitted it myself" is a report of something that happened outside the
 * agent — the user applied on the employer's site straight from a scored or
 * shortlisted row, without any packet. The pipeline graph above has no edge
 * from `scored` to `submitted` because the AGENT must never take it; a person
 * may. Nothing moves a job out of `submitted`, human or not.
 */
const HUMAN_REACHABLE = Object.freeze([LIFECYCLE.SUBMITTED, LIFECYCLE.SUBMIT_UNVERIFIED]);

/**
 * Outcomes the browser-assist run reports, reachable from any state except a
 * terminal one. A run can start from a prepared, approved, blocked, cancelled
 * or failed job, and what it finds on the live form decides where it ends;
 * listing every pair in TRANSITIONS would only restate this rule. Recording
 * them through setJobStatus is what gives each one an audit event.
 */
const ASSIST_REACHABLE = Object.freeze([
  LIFECYCLE.ASSIST_STARTED, LIFECYCLE.READY_FOR_SUBMIT, LIFECYCLE.ASSIST_BLOCKED,
  LIFECYCLE.SUBMIT_UNVERIFIED, LIFECYCLE.CANCELLED, LIFECYCLE.SUBMITTED,
]);
const ASSIST_NEVER_FROM = Object.freeze([LIFECYCLE.SUBMITTED, LIFECYCLE.HARD_DISCARDED]);

/** Where a human may send an unverified submission they say did not land. */
const HUMAN_UNSUBMIT = Object.freeze([LIFECYCLE.ASSIST_BLOCKED, LIFECYCLE.READY_FOR_SUBMIT]);

/**
 * May `from` legally become `to`?
 *
 * @param {string|null} from current jobs.status (null for a brand-new row)
 * @param {string} to proposed next status
 * @param {object} [options]
 * @param {'system'|'human'|'assist'} [options.actor='system'] who is making the move
 * @returns {boolean}
 */
export function canTransition(from, to, { actor = 'system' } = {}) {
  if (!LIFECYCLE_VALUES.includes(to)) return false;
  if (from == null || from === '') return true; // entry point
  if (from === to) return true;                 // idempotent re-write
  if (ALWAYS_REACHABLE.includes(to)) return true;
  if (actor === 'human' && HUMAN_REACHABLE.includes(to) && from !== LIFECYCLE.SUBMITTED) return true;
  if (actor === 'assist' && ASSIST_REACHABLE.includes(to) && !ASSIST_NEVER_FROM.includes(from)) return true;
  // "No, it didn't go through": only the person can take an unverified
  // submission back to finishing it — never the pipeline (a retry from an
  // unconfirmed submit is how a double application happens).
  if (actor === 'human' && from === LIFECYCLE.SUBMIT_UNVERIFIED && HUMAN_UNSUBMIT.includes(to)) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Throw unless the transition is legal. Use at a write site that owns a
 * lifecycle move, so an illegal one fails where it is made rather than
 * surfacing later as a misreported row.
 *
 * @param {string|null} from
 * @param {string} to
 * @param {string} [reason] human-readable cause, included in the error
 * @param {object} [options] passed to canTransition ({ actor })
 */
export function assertTransition(from, to, reason = '', options = {}) {
  if (canTransition(from, to, options)) return;
  const known = LIFECYCLE_VALUES.includes(to) ? '' : ' (not a known lifecycle status)';
  throw new Error(
    `illegal lifecycle transition: "${from}" -> "${to}"${known}`
    + `${reason ? ` [${reason}]` : ''}. Legal from "${from}": `
    + `${(TRANSITIONS[from] ?? []).join(', ') || '(terminal)'}.`,
  );
}

/**
 * DB statuses that represent human or assist investment. Re-discovery and
 * re-scoring must never overwrite these (e.g. a prepared+approved job being
 * re-discovered after it aged past the freshness window must NOT flip to
 * "discarded" — that silently buries an application in flight).
 */
export const PROTECTED_STATUSES = Object.freeze([
  LIFECYCLE.PREPARED, LIFECYCLE.ASSIST_STARTED, LIFECYCLE.ASSIST_BLOCKED,
  LIFECYCLE.READY_FOR_SUBMIT, LIFECYCLE.SUBMIT_UNVERIFIED, LIFECYCLE.SUBMITTED,
  LIFECYCLE.SKIPPED,
  LIFECYCLE.CANCELLED,
]);

/**
 * Should discovery/scoring keep its hands off this job row's status?
 * True when the human decided something, a packet exists, it was applied to,
 * or an assist outcome was recorded.
 *
 * @param {object|null} row jobs-table row (or null when the job is new)
 * @returns {boolean}
 */
export function isProtectedJobRow(row) {
  if (!row) return false;
  return Number(row.applied) === 1
    || Boolean(row.application_packet_path)
    || Boolean(row.user_decision)
    || PROTECTED_STATUSES.includes(row.status);
}

import { TIERS } from './scoring/explainScore.js';

/**
 * Tiers that are "queued" — strong enough to warrant action (packet build /
 * assisted apply). Near miss is intentionally excluded unless config opts in.
 */
export const QUEUED_TIERS = Object.freeze([TIERS.PRIORITY, TIERS.APPLY, TIERS.QUEUE]);

/**
 * Is this tier strong enough to be queued for action?
 * @param {string} tier explainScore tier
 * @param {object} [scoring] config/scoring.json (reads scoring.queue.includeNearMiss)
 * @returns {boolean}
 */
export function isQueuedTier(tier, scoring = {}) {
  if (QUEUED_TIERS.includes(tier)) return true;
  if (tier === TIERS.NEAR_MISS && scoring?.queue?.includeNearMiss === true) return true;
  return false;
}

/**
 * Derive the lifecycle status for a scored (non-excluded) job from its tier.
 * @param {string} tier
 * @param {object} [scoring]
 * @returns {string} a LIFECYCLE value
 */
export function lifecycleForTier(tier, scoring = {}) {
  if (tier === TIERS.DISCARD) return LIFECYCLE.SCORED; // scored but below near-miss
  if (isQueuedTier(tier, scoring)) return LIFECYCLE.QUEUED;
  if (tier === TIERS.NEAR_MISS) return LIFECYCLE.NEAR_MISS;
  return LIFECYCLE.SCORED;
}
