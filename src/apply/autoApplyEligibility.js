/**
 * Deterministic, side-effect-free assisted-fill / Auto-submit precheck.
 *
 * Ordinary Auto-apply only fills for human review: uncertain sponsorship or an
 * unanswered question is a warning, not a reason to prevent the browser from
 * opening. The same preview becomes deliberately strict only when final
 * Auto-submit is explicitly authorized for this run.
 */

import { APPROVAL_STATUS } from './approvalQueue.js';
import { isSponsorshipGated } from '../scoring/explainScore.js';

/**
 * ATS contracts exercised by local, no-submit browser fixtures, and therefore
 * the only ones final Auto-submit may click Submit on.
 *
 * `generic` used to be on this list. It is not a contract: it is the label
 * for "we could not tell which ATS this is", so an unrecognised careers page —
 * whose submit button, confirmation page and required-field conventions have
 * never been exercised — qualified for an unattended final submission.
 * Unknown platforms still get assisted fill (see ASSISTED_FILL_ATS); they
 * just never get submitted for you.
 */
export const FIXTURE_VERIFIED_AUTO_APPLY_ATS = Object.freeze([
  'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters',
]);

/** Platforms assisted fill is offered on (a superset: fill never submits). */
export const ASSISTED_FILL_ATS = Object.freeze([...FIXTURE_VERIFIED_AUTO_APPLY_ATS, 'generic']);

const VERIFIED_ATS = new Set(FIXTURE_VERIFIED_AUTO_APPLY_ATS);
const ASSIST_ATS = new Set(ASSISTED_FILL_ATS);
const CLOSED_DECISIONS = new Set(['rejected', 'archived']);
const DUPLICATE_STATUSES = new Set(['submitted', 'submit_unverified']);

function clean(value) {
  return String(value ?? '').trim();
}

function httpUrl(value) {
  try { return /^https?:$/.test(new URL(clean(value)).protocol); }
  catch { return false; }
}

function inferredAts(job = {}, packet = null) {
  const explicit = clean(packet?.ats?.platform ?? job.ats_platform).toLowerCase();
  if (explicit) return explicit;
  const source = clean(job.source).toLowerCase();
  return ASSIST_ATS.has(source) ? source : 'unknown';
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

/**
 * @param {object} args
 * @param {object|null} args.job database job row
 * @param {object|null} [args.approval] latest approval row
 * @param {object|null} [args.packet] parsed application packet
 * @param {boolean} [args.autoSubmitAuthorized=false] explicit authorization for this run
 * @returns {object} privacy-safe eligibility preview
 */
export function evaluateAutoApplyEligibility({
  job, approval = null, packet = null, autoSubmitAuthorized = false, liveVerifiedAts = [],
} = {}) {
  if (!job) {
    return {
      jobId: null, eligible: false, autoSubmitAuthorized,
      ats: 'unknown', reasons: ['Job no longer exists in the local database.'],
      warnings: [], checks: [], nextAction: 'Refresh the workbench.',
    };
  }

  const reasons = [];
  const warnings = [];
  const checks = [];
  const add = (id, passed, label, detail, strictOnly = false) => {
    checks.push({ id, passed, label, detail });
    if (!passed) {
      if (strictOnly && !autoSubmitAuthorized) warnings.push(detail);
      else reasons.push(detail);
    }
  };

  const applied = Number(job.applied) === 1 || DUPLICATE_STATUSES.has(job.status);
  add('duplicate', !applied, 'No prior submission', applied
    ? 'Already submitted or awaiting submission verification; reopening could create a duplicate.'
    : 'No completed or unverified submission is recorded.');

  const decisionOpen = !CLOSED_DECISIONS.has(job.user_decision);
  add('decision', decisionOpen, 'Job remains actionable', decisionOpen
    ? 'The job is not rejected or archived.'
    : `The job is ${job.user_decision}; clear that decision before Auto-Apply.`);

  add('url', httpUrl(job.url), 'Application URL is valid', httpUrl(job.url)
    ? 'The saved URL uses HTTP(S).'
    : 'A valid HTTP(S) application URL is required.');

  // The gate flag is DERIVED (tier Queue at an Apply-level score), not a stored
  // column. Reading `job.sponsorshipGated` off a snake_case DB row always
  // yielded undefined, so this guard silently never fired — it only looked
  // effective because the sponsorship STRING check happened to cover the same
  // rows. Derive it properly so the structural check is real, and accept a
  // caller-supplied flag for already-decorated board rows.
  const gated = job.sponsorshipGated === true || isSponsorshipGated(job);
  const sponsorship = clean(job.sponsorship) || 'Unconfirmed';
  const sponsorshipSafe = !gated && !/^unconfirmed$/i.test(sponsorship)
    && !/no sponsorship|not sponsor|unlikely|verify/i.test(sponsorship);
  add('sponsorship', sponsorshipSafe, 'Sponsorship precheck passes', sponsorshipSafe
    ? `Stored sponsorship assessment: ${sponsorship}.`
    : gated
      ? `Fit qualifies for Apply but the sponsorship gate parked it in Queue (${sponsorship}); `
        + 'verify the employer sponsors before any final submission.'
      : `Sponsorship is ${sponsorship}; verify compatibility before final submission.`, true);

  const ats = inferredAts(job, packet);
  add('ats', VERIFIED_ATS.has(ats), 'ATS has a fixture-tested contract', VERIFIED_ATS.has(ats)
    ? `${ats} is covered by a local no-submit fixture.`
    : `ATS is ${ats}; final Auto-submit requires a supported contract, while assisted fill may need manual completion.`, true);

  // Fixtures prove the filler on saved pages; only a supervised live run
  // proves the vendor's real page and confirmation still match (P1-11).
  const liveVerified = new Set([...(liveVerifiedAts ?? [])].map((x) => clean(x).toLowerCase())).has(ats);
  add('ats_live', liveVerified, 'ATS verified on a live site', liveVerified
    ? `${ats} has a recorded supervised live run (config/verified_live_ats.json).`
    : `${ats} has no recorded supervised live run yet (config/verified_live_ats.json), so final Auto-submit is refused; `
      + 'assisted fill still works and you submit yourself.', true);

  add('packet', Boolean(packet), 'Application packet exists', packet
    ? 'A prepared packet is available for review.'
    : 'Prepare the application first so documents, answers, and ATS can be reviewed.');

  if (packet) {
    const packetBlockers = unique(packet.blockers ?? []);
    add('packet_blockers', packetBlockers.length === 0, 'Packet has no blockers', packetBlockers.length
      ? `Packet blockers: ${packetBlockers.join('; ')}`
      : 'No packet blockers are recorded.', true);

    const needsUser = unique([
      ...(packet.prefill?.needsUser ?? []).map((x) => x?.label ?? x?.field ?? x),
      ...(packet.screeningPlan?.needsUser ?? []).map((x) => x?.label ?? x?.field ?? x),
    ]);
    add('answers', needsUser.length === 0, 'Required saved answers are complete', needsUser.length
      ? `Questions still need your answer: ${needsUser.join('; ')}`
      : 'No unresolved packet questions are recorded.', true);

    const uploadBlockers = unique(packet.uploads?.blockers ?? []);
    const resumePath = clean(packet.resumePath ?? job.resume_docx_path ?? job.resume_path);
    add('resume', Boolean(resumePath) && !packet.resumeWarning, 'Approved resume is available', !resumePath
      ? 'The packet does not contain a resume document.'
      : packet.resumeWarning
        ? `Resume is not approved for Auto-Apply: ${clean(packet.resumeWarning)}`
        : 'The packet references a resume document with no recorded warning.');
    add('uploads', uploadBlockers.length === 0, 'Upload plan has no blockers', uploadBlockers.length
      ? `Upload blockers: ${uploadBlockers.join('; ')}`
      : 'No upload-plan blockers are recorded.', true);
  }

  if (approval?.approval_status === APPROVAL_STATUS.REJECTED) {
    reasons.push('The prepared packet was rejected; prepare and review a new packet first.');
  } else if (approval && approval.approval_status !== APPROVAL_STATUS.APPROVED) {
    warnings.push('Confirming Auto-Apply will also approve this reviewed packet for this run.');
  }

  if (!autoSubmitAuthorized) {
    warnings.push('Assisted fill will stop before Submit; final submission is not authorized.');
  }
  warnings.push('Browser prechecks still stop for login, CAPTCHA/MFA, changed fields, upload failure, or missing confirmation evidence.');

  const eligible = reasons.length === 0;
  return {
    jobId: job.id,
    company: job.company ?? null,
    title: job.title ?? null,
    eligible,
    autoSubmitAuthorized,
    ats,
    reasons: unique(reasons),
    warnings: unique(warnings),
    checks,
    nextAction: eligible
      ? (autoSubmitAuthorized ? 'Eligible for this explicitly authorized Auto-submit run.' : 'Eligible for assisted fill; review the browser form and submit it yourself.')
      : reasons[0],
  };
}

/** Evaluate and summarize a batch without performing any mutation. */
export function evaluateAutoApplyBatch({ items = [], autoSubmitAuthorized = false, liveVerifiedAts = [] } = {}) {
  const results = items.map((item) => evaluateAutoApplyEligibility({
    ...item, autoSubmitAuthorized, liveVerifiedAts,
  }));
  return {
    autoSubmitAuthorized,
    total: results.length,
    eligible: results.filter((x) => x.eligible).length,
    ineligible: results.filter((x) => !x.eligible).length,
    items: results,
  };
}

/** Parse a stored timestamp; null when absent or unparseable. */
function timeOf(value) {
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * Was this job's packet reviewed and approved BEFORE the auto-submit run
 * started, and is it still the same packet?
 *
 * Auto-submit is authorized for the packets a human looked at. A packet
 * prepared (or re-prepared, e.g. after an ownership mismatch) or approved
 * while the run was already going is one nobody reviewed — the batch used to
 * prepare it, approve it itself, and submit it in the same breath.
 *
 * @param {object} args
 * @param {object|null} args.job live DB row
 * @param {object|null} args.approval live approval row
 * @param {string|number|Date} args.batchStartedAt when the run was authorized
 * @param {string|null} [args.snapshotPacketPath] packet path when the run started
 * @returns {string|null} why the job must not be auto-submitted, or null
 */
export function autoSubmitReviewProblem({ job, approval, batchStartedAt, snapshotPacketPath } = {}) {
  const started = timeOf(batchStartedAt instanceof Date ? batchStartedAt.toISOString() : batchStartedAt);
  if (!approval) return 'no reviewed packet exists';
  if (approval.approval_status !== APPROVAL_STATUS.APPROVED || !approval.approved_by_user) {
    return 'its packet was not approved before this auto-submit run started';
  }
  if (snapshotPacketPath !== undefined && snapshotPacketPath !== null
    && approval.packet_path !== snapshotPacketPath) {
    return 'its packet was replaced after this auto-submit run started';
  }
  if (started !== null) {
    const approvedAt = timeOf(approval.approved_at);
    if (approvedAt !== null && approvedAt > started) return 'it was approved after this auto-submit run started';
    const preparedAt = timeOf(job?.prepared_at);
    if (preparedAt !== null && preparedAt > started) return 'it was (re)prepared after this auto-submit run started';
  }
  return null;
}
