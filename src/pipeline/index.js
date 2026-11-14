/**
 * Pipeline orchestrator.
 *
 * Ties the stages together: search -> exclude -> classify sponsorship -> score ->
 * explain/tier -> persist -> (PREPARE) build packet + enqueue for human approval
 * -> report. It is mode-aware and side-effect-light:
 *
 *   - DRY_RUN:     search, score, persist, and report only. No packets, no AI,
 *                  no browser. Safe to run with zero secrets.
 *   - PREPARE:     additionally builds application packets (resume reference +
 *                  cover letter + prefill plan) and enqueues them for review.
 *                  STILL never submits.
 *   - LIVE_ASSIST: same preparation; submission remains gated behind explicit
 *                  human approval + live-submit runtime (handled downstream).
 *
 * All external effects (search fetch, resume tailoring) are injectable so the
 * pipeline is fully testable offline.
 */

import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { writeFileAtomic } from '../utils/fsSafe.js';

import { runSearch } from '../search/index.js';
import { urlKeyFor } from '../search/deduplicator.js';
import { classifyDiscovery } from '../search/discoveryFilter.js';
import { applyFreshnessFilter, UNDATED_REASON } from '../search/freshnessFilter.js';
import { sourceKind } from '../search/sources.js';
import { createSourceTimings } from '../search/sourceTimings.js';
import { createDetailCache } from '../search/detailBudget.js';
import { applyExclusions, candidateNeedsSponsorship } from '../scoring/exclusionFilter.js';
import { profileVocabularyFor, classifyTitleFit } from '../scoring/profileFit.js';
import { postedPay } from '../scoring/searchConstraints.js';
import { postedOnAgrees, locationFromExternalPath } from '../search/adapters/workday.js';
import { classifySponsorship } from '../scoring/sponsorshipClassifier.js';
import { classifyEmployment } from '../scoring/employmentClassifier.js';
import { scoreJob, freshnessModelFor } from '../scoring/scorer.js';
import { explainScore, TIERS } from '../scoring/explainScore.js';
import { scoringFingerprint } from '../scoring/fingerprint.js';
import { compareJobsForQueue } from '../scoring/jobRanking.js';
import { generateCoverLetter } from '../apply/coverLetter.js';
import { buildApplicationPacket, writePacket, packetOwner } from '../apply/applicationPacket.js';
import { enqueueForApproval } from '../apply/approvalQueue.js';
import { generateReport } from '../reports/reportGenerator.js';
import { EVENT_TYPES } from '../logging/jobLogger.js';
import { dateStamp, formatPostedRelative } from '../utils/dates.js';
import { buildJobPaths } from '../utils/outputPaths.js';
import { keywordsForJob, tailorResumeForJob, writeLetterDocx } from '../resume/tailorRunner.js';
import { composeGroundedLetter, letterSettings } from '../apply/groundedLetter.js';
import { recordVersion } from '../apply/documentVersions.js';
import { letterModeFor } from '../apply/letterMode.js';
import { acceptedRewritesFor } from '../resume/rewrites.js';
import { keptBulletsFor } from '../resume/keepBullets.js';
import { readMasterLetterText } from '../apply/masterLetter.js';
import { LIFECYCLE, lifecycleForTier, isQueuedTier, isProtectedJobRow } from '../lifecycle.js';
import { emptyCounters, writeAllArtifacts } from '../outputs.js';
import { findPlaceholders } from '../config/placeholders.js';
import { resumeProfileMismatch } from '../profile/resumeIdentity.js';
import { masterResumeFile } from '../profile/workspace.js';

/**
 * Tiers that warrant AUTO-building an application packet in PREPARE/LIVE_ASSIST.
 * Deliberately excludes Queue: Queue is "worth a human look", not "worth a
 * tailored resume" — auto-preparing it was measured producing 153 medium-fit
 * packets vs 8 strong-fit ones, burying the real candidates. Queue jobs can
 * still be prepared explicitly via the dashboard's "Prepare selected".
 */
const PREPARE_TIERS = new Set([TIERS.PRIORITY, TIERS.APPLY]);

/**
 * Stand-in used when no logger is supplied. Mirrors the surface of
 * `JobLogger` that this module actually calls — `event`, `error`, `endRun` —
 * and does nothing with any of it.
 */
const NO_OP_LOGGER = Object.freeze({
  event() {},
  error() {},
  startRun() {},
  endRun() { return {}; },
});

/**
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {import('../logging/jobLogger.js').JobLogger} args.logger
 * @param {string} args.mode DRY_RUN | PREPARE | LIVE_ASSIST
 * @param {object} [args.deps]
 * @param {Function} [args.deps.searchFn] override runSearch (testing)
 * @param {Function} [args.deps.tailorFn] resume tailoring hook -> returns path
 * @param {Date} [args.deps.now]
 * @returns {Promise<object>} run summary with counters + scored jobs
 */
export async function runPipeline({ config, db, logger: suppliedLogger, mode, deps = {} } = {}) {
  // AN ABSENT LOGGER MUST NOT KILL THE RUN.
  //
  // This function made ten unguarded `logger.event(...)` calls while every
  // other caller in the repo (src/cli/commands.js, src/cli/applyOneByOne.js)
  // treats the logger as optional with `?.`. `startDashboard({ logger })`
  // accepts whatever it is handed and threads it straight through to here, so
  // a caller that passes null — which the dashboard tests all do — turned the
  // very first line of discovery into "Cannot read properties of null (reading
  // 'event')". The run then reported as a failure with an RCA category of
  // "unknown", which says nothing about what actually went wrong.
  //
  // A no-op logger degrades the run to "no event log" instead, which is the
  // honest outcome: event logging is diagnostics, never a precondition for
  // finding jobs.
  const logger = suppliedLogger ?? NO_OP_LOGGER;
  const now = deps.now ?? new Date();
  const searchFn = deps.searchFn ?? runSearch;
  /**
   * Keep rows that score below the near-miss floor VISIBLE instead of
   * discarding them.
   *
   * Set only by an ad-hoc query search (`runQuerySearch`). The fit score is
   * computed from `scoring.keywords`, which is one profile's stack vocabulary,
   * so a role outside that stack scores near zero however good a match it is:
   * a genuine "Senior Product Manager, Payments" scored 20 against a data
   * engineering vocabulary and was discarded. Discarding the exact rows a user
   * just asked for, because a keyword list they did not choose says they are
   * irrelevant, is the wrong behaviour — so a query search records the score as
   * information and leaves the row on the board for the human to judge.
   *
   * Normal runs are unaffected: the threshold is what stops 97,000 unrelated
   * rows reaching the board.
   */
  const keepBelowThreshold = deps.keepBelowThreshold === true;
  /**
   * WHICH SEARCH THIS RUN IS — 'profile' or 'role_search'.
   *
   * Stamped onto every row this run persists, so the personalized board and an
   * ad-hoc role search can never be read as the same pile. This is the whole
   * reason `keepBelowThreshold` above is now safe: it keeps a row the user
   * explicitly asked for, and the stamp keeps that row out of the board that
   * answers "what should I apply to?".
   */
  const runMode = deps.discoveryMode === 'role_search'
    ? { discovery_mode: 'role_search', search_query: deps.searchQuery ?? null }
    : { discovery_mode: 'profile', search_query: null };
  /**
   * Fingerprint of the configuration judging this run, computed ONCE.
   *
   * Stored beside every score written here and required to match before the
   * incremental skip may reuse one. See src/scoring/fingerprint.js.
   */
  const configFingerprint = scoringFingerprint(config);

  logger.event(EVENT_TYPES.SEARCH_START, { message: 'Starting search' });
  // Preload the set of already-APPLIED job ids ONCE (cheap) rather than issuing
  // a per-job SELECT during dedup — a discovery run examines thousands of jobs.
  const excludeApplied = config?.runtime?.excludeAlreadyApplied !== false;
  const appliedIds = excludeApplied ? db.getAppliedJobIds() : null;
  // Provider-specific ids can change across sources/runs. Refresh the same id,
  // but do not create another actionable row for a URL already owned by a
  // different live/protected record.
  //
  // ONLY URLs owned by EXACTLY ONE active row are usable as an identity signal.
  //
  // REGRESSION GUARD. This was a plain Map built from every active row, so the
  // last writer won and a URL shared by many rows still "belonged" to one of
  // them — which silently suppressed all the others on every subsequent run.
  // Not hypothetical: in this database 25 URL keys are shared by more than one
  // active row, and `deloitteus.avature.net/careers/InviteToApply?jobId=353918`
  // is a single URL serving 26 DISTINCT jobs. A URL that maps to many jobs has
  // proven itself not to be a per-posting identifier — it is a careers-page or
  // apply-shim link — so using it to decide "already seen" throws away real
  // postings. Ambiguous URLs are therefore dropped from the map entirely and
  // reported, rather than being trusted and losing jobs without a trace.
  const urlOwnerCounts = new Map();
  for (const row of db.getActiveJobUrls?.() ?? []) {
    const key = urlKeyFor(row);
    if (!key) continue;
    if (!urlOwnerCounts.has(key)) urlOwnerCounts.set(key, []);
    urlOwnerCounts.get(key).push(row.id);
  }
  const activeUrlOwners = new Map();
  const ambiguousUrlKeys = [];
  for (const [key, ids] of urlOwnerCounts) {
    if (ids.length === 1) activeUrlOwners.set(key, ids[0]);
    else ambiguousUrlKeys.push({ key, owners: ids.length });
  }
  if (ambiguousUrlKeys.length) {
    logger.event(EVENT_TYPES.SEARCH_START, {
      message: `${ambiguousUrlKeys.length} URL(s) are shared by multiple active jobs and will not be `
        + 'used to suppress re-discovery (they are not per-posting links)',
      meta: { ambiguousUrlKeys: ambiguousUrlKeys.slice(0, 20) },
    });
  }
  // How many jobs each suppression rule actually removed — without this the
  // caller cannot tell "found nothing new" from "silently dropped everything".
  const suppressed = { applied: 0, urlOwned: 0 };
  // Snapshot of what the database knew BEFORE this run, so `jobs_new` below is
  // a genuine before/after comparison rather than a guess. Ids only — the rows
  // themselves are large and only membership is needed.
  //
  // EVERY mode. `listJobIds()` defaults to the profile scope, so a posting a
  // role search had already stored counted as "new" again on the next profile
  // run (and vice versa) — the row existed; only its owner differed.
  const knownIdsBefore = new Set(
    typeof db.listJobIds === 'function'
      ? db.listJobIds({ mode: 'all' })
      : (db.listJobs?.({}) ?? []).map((r) => r.id),
  );
  // Descriptions bought by an earlier run, reusable by ANY adapter with a
  // detail budget — not just Workday. `workdayDetailCache` stays as an alias so
  // the Workday adapter's existing parameter name keeps resolving.
  //
  // The cache returns the stored LOCATION too (and a by-URL lookup for sources
  // whose id only exists after a detail read) — see src/search/detailBudget.js.
  const detailCache = deps.detailCache !== undefined ? deps.detailCache : createDetailCache(db);
  const sourceTimings = deps.sourceTimings ?? createSourceTimings({ root: config.root });
  const { jobs, duplicates, errors, perSource = [], cancelled: searchCancelled = false } = await searchFn({
    jobboards: config.jobboards,
    candidate: config.candidate,
    scoring: config.scoring,
    // Dedupe keeps the copy that passes the US-only gate (M2).
    exclusions: config.exclusions,
    // Discovery signals are computed lazily below, only for jobs that are
    // recorded — not for the ~92% the freshness gate drops.
    annotateDiscovery: false,
    ctx: {
      ...(deps.searchCtx ?? {}),
      root: config.root,
      shouldCancel: deps.shouldCancel,
      // Aborts in-flight and gate-queued network work on cancel. `shouldCancel`
      // is only checked BETWEEN operations, so without this a request already on
      // the wire ran to completion or to its timeout — a ~30s "Stopping…".
      abortSignal: deps.abortSignal,
      detailCache,
      workdayDetailCache: detailCache,
      // Lets the orchestrator claim the slowest sources first and leaves a
      // per-source timing record behind for diagnosis. Injectable so tests
      // never touch the filesystem.
      sourceTimings,
    },
    hooks: deps.searchHooks ?? {},
    // Only skip jobs we have already APPLIED to. Merely-seen or prepared jobs
    // are re-discovered so DRY_RUN -> PREPARE -> LIVE_ASSIST can build on them.
    // Honors runtime.excludeAlreadyApplied (default true).
    existsInDb: (job) => {
      if (appliedIds?.has(job.id)) { suppressed.applied += 1; return true; }
      const owner = activeUrlOwners.get(urlKeyFor(job));
      if (owner && owner !== job.id) { suppressed.urlOwned += 1; return true; }
      return false;
    },
  });
  logger.event(EVENT_TYPES.SEARCH_END, {
    message: `Search complete: ${jobs.length} jobs, ${duplicates.length} dupes, ${errors.length} errors`,
    meta: { found: jobs.length, duplicates: duplicates.length, errors: errors.length },
  });

  // What the database already knows about each returned posting, read ONCE
  // through a narrow projection (no jd_text). Used to reconcile relative dates
  // and blank locations, to decide retention, and to skip unchanged stale rows.
  const readStored = createStoredRowReader(db);
  const storedById = new Map();
  const storedOf = (id) => {
    if (!storedById.has(id)) storedById.set(id, readStored(id));
    return storedById.get(id);
  };
  const stats = { retained: 0, staleSkippedUnchanged: 0, expired: 0, validThroughExpired: 0, rescored: 0, touched: 0 };
  for (const job of jobs) reconcileWithStored(job, storedOf(job.id), now);

  /*
   * THE FRESHNESS MODEL (F8). Four controls used to overlap; they now mean:
   *
   *   discovery window  runtime.jobFreshnessMode (env JOB_FRESHNESS_MODE,
   *                     code default LAST_7_DAYS) — gates NEW rows only: a
   *                     posting not already on the board is admitted only if it
   *                     was posted inside the window.
   *   retention window  exclusions.staleness.skipOlderThanDays (45) — a row
   *                     ALREADY scored / needs_description is kept and re-judged
   *                     on every rediscovery until it is older than this, when
   *                     the exclusion stage retires it as stale_posting.
   *   freshness points  graded against the discovery window (1.0 at day 0,
   *                     0.5 at its edge, falling to 0 at the retention limit) —
   *                     see freshnessFactor in src/scoring/scorer.js.
   *   maxAgeDays        per-source fetch-side optimisation only (Oracle, iCIMS,
   *                     Rippling, atsSearch skip requisitions older than this
   *                     before paying for details); it never decides retention.
   *
   * The window used to gate EVERY rediscovered job, so a Queue-tier row turned
   * 4 days old was re-discarded as "stale: > 3d window" (92 Queue-tier rows
   * lost) while exclusions.staleness said it had 45 days to live.
   */
  const retained = [];
  const unretained = [];
  for (const job of jobs) {
    const s = storedOf(job.id);
    if (s && RETAINED_STATUSES.has(s.status) && !isProtectedJobRow(s)) retained.push(job);
    else unretained.push(job);
  }
  stats.retained = retained.length;
  const freshness = applyFreshnessFilter(unretained, config.runtime ?? {}, { now });
  const freshJobs = [...retained, ...freshness.kept];
  const freshnessModel = freshnessModelFor(config);

  // Every write below is batched into chunked transactions (P5).
  const writer = createWriter(db);
  if (freshness.dropped.length || freshness.review.length) {
    logger.event(EVENT_TYPES.FRESHNESS_FILTERED, {
      message: `Freshness ${freshness.mode}: kept ${freshJobs.length}, dropped ${freshness.dropped.length}`
        + (freshness.review.length ? `, ${freshness.review.length} held for unknown-date review` : '')
        + (freshness.fallbackUsed ? ' (3-day fallback applied)' : ''),
      meta: {
        mode: freshness.mode,
        windowDays: freshness.windowDays,
        effectiveWindowDays: freshness.effectiveWindowDays,
        fallbackUsed: freshness.fallbackUsed,
        counts: freshness.counts,
      },
    });
  }

  // Built once per run — the vocabulary is pure and derived from the profile.
  const profileVocab = profileVocabularyFor(config.candidate);
  const counters = { ...emptyCounters(), jobs_found: jobs.length };
  // What was ACTUALLY new this run. `jobs_found` is every posting every source
  // returned, which on a mature corpus is dominated by rows we already had, so
  // it cannot answer "did the run find anything?". `knownIdsBefore` is captured
  // before any write below, so this stays a true before/after comparison.
  counters.jobs_new = jobs.reduce((n, j) => n + (knownIdsBefore.has(j.id) ? 0 : 1), 0);
  counters.jobs_duplicate = duplicates.length;
  counters.jobs_suppressed_applied = suppressed.applied;
  counters.jobs_suppressed_url_owned = suppressed.urlOwned;
  if (searchCancelled) counters.jobs_cancelled += 1;
  let loopCancelled = false;
  const scoredJobs = [];
  // Full-visibility audit trail of every discovered job and what happened to it.
  const discovered = [];
  // Rows fed to the report: includes hard-discarded jobs (which never reach
  // scoredJobs) so the report can show found / discarded / weak / scored / queued.
  const reportRows = [];
  // Rows for data/scored_jobs.json (everything that survived hard exclusions).
  const scored = [];
  // Rows for data/queued_jobs.json (only queued-tier jobs worth acting on).
  const queued = [];
  // Undated jobs held in a SEPARATE review bucket (never mixed into fresh
  // results). Surfaced in data/unknown_date_review.json for manual triage.
  const reviewRows = [];

  // Record freshness-dropped jobs in the audit trail + report so they remain
  // visible (as discarded) rather than silently vanishing.
  //
  // "stale" is a claim about AGE. A posting with no parseable date is not old —
  // its date is unknown, which is a different problem with a different fix
  // (verify the link). Blanket-prefixing every drop with "stale:" mislabeled
  // thousands of undated rows as expired, and hid them from the "needs date
  // check" review the UI offers. Undated drops therefore keep their own honest
  // reason and are tagged so the dashboard can count them.
  //
  // PERFORMANCE (P5). This is ~92% of everything a run returns, so it is kept
  // cheap: no discovery classification (the row is not in found_jobs.json and
  // the report only counts it), no rewrite of a row already stored as the
  // same kind of discard with the same posting, and no jd_text in the write —
  // a stale discard's description is never read again, and writing ~8 KB per
  // row for 60k rows per run was the bulk of the write volume. The text is
  // released from memory as soon as the row's employment category is known.
  const markers = config.exclusions?.employmentTypes;
  for (const { job, reason } of freshness.dropped) {
    counters.jobs_discarded += 1;
    counters.jobs_discarded_stale += 1;
    const undated = reason === UNDATED_REASON;
    if (undated) counters.jobs_unknown_date_review += 1;
    const discardReason = undated ? reason : `stale: ${reason}`;
    const s = storedOf(job.id);
    if (s && s.status === 'discarded' && sameDiscardKind(s.discard_reason, discardReason) && postingUnchanged(s, job)) {
      stats.staleSkippedUnchanged += 1;
    } else {
      const employmentCategory = classifyEmployment(job, markers).category;
      writer.write(() => persistJob(db, job, {
        status: 'discarded', discard_reason: discardReason, employment_category: employmentCategory,
      }, markers, runMode, { omitJd: true }));
    }
    job.jdText = undefined;
    reportRows.push(reportRow(job, UNCLASSIFIED, { status: 'discarded', discard_reason: discardReason }));
  }

  // Record undated jobs in the SEPARATE review bucket. They are NOT scored,
  // prepared, or counted as fresh — only surfaced for a human to inspect.
  for (const job of freshness.review) {
    counters.jobs_unknown_date_review += 1;
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    writer.write(() => persistJob(db, job, { status: 'unknown_date_review', discard_reason: 'unknown posting date' }, markers, runMode));
    const dRow = discoveredRow(job, discovery, {
      keptForScoring: false, discardReason: 'unknown posting date',
      lifecycle: LIFECYCLE.UNKNOWN_DATE_REVIEW,
    });
    discovered.push(dRow);
    reviewRows.push(dRow);
    reportRows.push(reportRow(job, discovery, {
      status: 'unknown_date_review', discard_reason: 'unknown posting date',
    }));
  }

  for (const job of freshJobs) {
    if (deps.shouldCancel?.()) {
      counters.jobs_cancelled += 1;
      loopCancelled = true;
      break;
    }
    // Find New Jobs is incremental: an unchanged record that already has a
    // score does not need deterministic scoring work repeated. Re-score is the
    // explicit command for applying changed scoring configuration to all rows.
    const existing = db.getJob?.(job.id) ?? null;
    // UNCHANGED MEANS THE JOB *AND* THE JUDGE.
    //
    // This compared the posting only, so every stored score survived a change
    // of candidate, target roles, scoring weights or exclusions untouched — a
    // nursing profile kept showing an engineering job at 94/100 and rescored
    // nothing. The fingerprint is what the configuration was when the score was
    // written; a row scored under a different one is no longer current and has
    // to be judged again. See src/scoring/fingerprint.js.
    if (mode === 'DRY_RUN'
      && existing?.score != null
      && existing?.scoring_fingerprint === configFingerprint
      && materiallyUnchanged(existing, job)) {
      counters.jobs_skipped_unchanged += 1;
      // Still LISTED: bump updated_at so the expiry pass (M3), which reads
      // "not seen for N successful runs" from updated_at, never retires a row
      // merely because nothing about it changed.
      if (RETAINED_STATUSES.has(existing.status)) {
        stats.touched += 1;
        writer.write(() => touchJob(db, job.id));
      }
      continue;
    }
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });

    // 1. Hard exclusions — and the posting's own end date (M3). A JSON-LD
    // `validThrough` in the past is the employer saying the posting is closed.
    const exclusion = validThroughExpired(job, now)
      ?? applyExclusions(job, config.exclusions, { now, candidate: config.candidate });
    if (exclusion.excluded) {
      counters.jobs_discarded += 1;
      counters.jobs_discarded_excluded += 1;
      if (exclusion.category === 'expired') stats.validThroughExpired += 1;
      writer.write(() => persistJob(db, job, { status: 'discarded', discard_reason: exclusion.reason }, markers, runMode, { omitJd: true }));
      logger.event(EVENT_TYPES.EXCLUSION_MATCHED, {
        jobId: job.id, message: exclusion.reason, meta: { category: exclusion.category },
      });
      discovered.push(discoveredRow(job, discovery, {
        keptForScoring: false, discardReason: exclusion.reason, lifecycle: LIFECYCLE.HARD_DISCARDED,
      }));
      reportRows.push(reportRow(job, discovery, { status: 'discarded', discard_reason: exclusion.reason }));
      continue;
    }

    // 2. Sponsorship + 3. Score + 4. Tier.
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const score = scoreJob(job, {
      scoring: config.scoring, sponsorship, candidate: config.candidate, now, freshnessModel,
    });
    // A posting whose TITLE gave no signal reached scoring only because the
    // gate now defers instead of rejecting. That recovers real roles, but such
    // a posting must clear a higher bar than one whose title already matched —
    // otherwise the recall gain arrives as several hundred extra speculative
    // near-misses on the board.
    const titleVerdict = profileVocab ? classifyTitleFit(job.title, profileVocab).verdict : null;
    const { tier, explanation, sponsorshipGated } = explainScore(score, config.scoring, { titleVerdict, candidate: config.candidate });
    counters.jobs_scored += 1;
    const queuedTier = isQueuedTier(tier, config.scoring);
    let lifecycle = lifecycleForTier(tier, config.scoring);

    const enriched = { ...job, score: score.total, tier, sponsorship: sponsorship.status, explanation, lifecycle };
    scoredJobs.push(enriched);
    const row = reportRow(job, discovery, {
      score: score.total, tier, sponsorship: sponsorship.status,
      missing_keywords: score.missingKeywords,
      status: tier === TIERS.DISCARD && !keepBelowThreshold ? 'discarded' : 'scored',
    });
    reportRows.push(row);

    const unread = isUnjudgeable(job, tier, titleVerdict);
    // ONE write per job. The unread case below used to write the scored verdict
    // and then immediately overwrite it; the final fields are decided first.
    const verdict = {
      score: score.total, tier, sponsorship: sponsorship.status,
      // The evidence behind the sponsorship verdict, so the badge is auditable
      // rather than an unexplained assertion.
      sponsorship_signals: sponsorship.signals ?? [],
      matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
      explanation,
      // Which configuration produced this verdict — read back by the
      // incremental skip above so a stale score can never pass as current.
      scoring_fingerprint: configFingerprint,
      status: tier === TIERS.DISCARD && !keepBelowThreshold ? 'discarded' : 'scored',
      // Always written, as rescoreStale does. Left unset, a row that was once
      // unread and has now been read and judged kept "not judged: the
      // description was never fetched" — a false claim on 604 stored rows — and
      // a fresh low-score discard carried no reason at all.
      discard_reason: tier === TIERS.DISCARD && !keepBelowThreshold ? 'below near-miss threshold' : null,
      ...payFields(job),
      ...(unread ? {
        status: 'needs_description',
        discard_reason: job.rawMetadata?.summaryOnly === true
          ? 'not judged: the description was never fetched (summary only)'
          : 'not judged: the posting has no description to judge fit by',
        tier: null,
      } : {}),
    };
    writer.write(() => persistJob(db, job, verdict, markers, runMode));
    logger.event(EVENT_TYPES.SCORE_EXPLAINED, {
      jobId: job.id, message: `${score.total}/100 -> ${tier}`,
      meta: { score: score.total, tier, sponsorship: sponsorship.status, sponsorshipGated, posted: formatPostedRelative(job.postedAt, now) },
    });

    // A posting whose description was never fetched cannot be judged on fit.
    //
    // The arithmetic makes this unavoidable rather than unlucky: with no
    // description there are no stack/domain/keyword hits available, so the
    // reachable maximum is ~44/100 against a 50 floor — EVERY summary-only row
    // is a guaranteed Discard no matter how perfect the role. Measured on this
    // corpus, 31,409 rows were scored on under 200 characters and exactly 2
    // ever reached the board, among them "Microsoft Fabric Data Engineer" and
    // "Senior BI Engineer - PowerBI and Microsoft Fabric". Reporting those as
    // "below score threshold" states a fit conclusion the system never earned.
    // They are recorded as unread instead, so `npm run enrich` can fetch the
    // descriptions and score them for real.
    if (unread) {
      counters.jobs_unread += 1;
      discovered.push(discoveredRow(job, discovery, {
        keptForScoring: false,
        discardReason: 'description not fetched',
        lifecycle: LIFECYCLE.HARD_DISCARDED,
      }));
      continue;
    }

    if (tier === TIERS.DISCARD && !keepBelowThreshold) {
      counters.jobs_discarded += 1;
      counters.jobs_discarded_low_score += 1;
      const dRow = discoveredRow(job, discovery, {
        keptForScoring: true, score: score.total, tier, sponsorship: sponsorship.status,
        matchedKeywords: score.matchedKeywords, missingKeywords: score.missingKeywords,
        discardReason: 'below near-miss threshold', lifecycle: LIFECYCLE.SCORED,
      });
      discovered.push(dRow);
      scored.push(dRow);
      continue;
    }
    if (queuedTier) {
      counters.jobs_queued += 1;
    }

    // 5. PREPARE / LIVE_ASSIST: build a packet for strong, sponsorship-cleared roles.
    let packetPath = null;
    // An optional prepareFilter lets watch mode tailor ONLY brand-new jobs each
    // cycle (skip re-tailoring already-prepared ones). Defaults to preparing all
    // eligible tiers, so normal runs are unchanged.
    const shouldPrepare = typeof deps.prepareFilter === 'function' ? deps.prepareFilter(job) : true;
    if (mode !== 'DRY_RUN' && PREPARE_TIERS.has(tier) && shouldPrepare) {
      // The queued verdict must land BEFORE the packet's 'prepared' write, or
      // the next flush would overwrite 'prepared' with 'scored'.
      writer.flush();
      // Packet preparation does per-job file I/O, cover-letter composition and
      // a Python subprocess. One job's failure there (a locked file, a path the
      // OS rejects) is that job's problem: it stays scored and visible, and the
      // remaining jobs, artifacts and report still happen.
      try {
        packetPath = await preparePacket({ config, db, logger, job, score, tier, deps, counters });
      } catch (err) {
        packetPath = null;
        errors.push({ source: 'prepare', jobId: job.id, error: err?.message ?? String(err) });
        logger.event(EVENT_TYPES.ERROR, {
          jobId: job.id, message: `packet preparation failed: ${err?.message ?? err}`,
        });
      }
      if (packetPath) {
        lifecycle = LIFECYCLE.PREPARED;
        enriched.application_packet_path = packetPath;
        enriched.status = 'prepared';
        enriched.lifecycle = lifecycle;
        row.application_packet_path = packetPath;
        row.status = 'prepared';
      }
    }

    const dRow = discoveredRow(job, discovery, {
      keptForScoring: true, score: score.total, tier, sponsorship: sponsorship.status,
      matchedKeywords: score.matchedKeywords, missingKeywords: score.missingKeywords,
      packetPath, lifecycle,
    });
    discovered.push(dRow);
    scored.push(dRow);
    if (queuedTier) queued.push(dRow);
  }

  // A duplicate collapsed into another record this run is still LISTED; its own
  // stored row (from a run where it was the survivor) must not age into
  // expiry for it. Only active rows need the touch.
  for (const { job } of duplicates) {
    if (!job?.id || !knownIdsBefore.has(job.id)) continue;
    const s = storedOf(job.id);
    if (s && RETAINED_STATUSES.has(s.status)) {
      stats.touched += 1;
      writer.write(() => touchJob(db, job.id));
    }
  }
  writer.flush();

  // M3 — retire rows their source stopped listing. Profile runs only: a role
  // search runs different queries, so its silence proves nothing about a
  // profile row. Skipped entirely on a cancelled run.
  if (!searchCancelled && !loopCancelled && runMode.discovery_mode === 'profile') {
    stats.expired = expireUnlisted({ db, perSource, sourceTimings, writer });
    writer.flush();
  }

  // F10 — re-judge active rows scored under a different configuration, from
  // their stored text (no network).
  if (!searchCancelled && !loopCancelled && deps.rescoreStale !== false) {
    stats.rescored = rescoreStale({ db, config, now, fingerprint: configFingerprint }).rescored;
  }

  // Order every actionable list freshest-first (last-24h > sponsorship > score >
  // direct ATS) so queues, artifacts, and console summaries surface the newest,
  // most-feasible roles at the top.
  const rankByFreshness = compareJobsForQueue(now, {
    ignoreSponsorship: candidateNeedsSponsorship(config.candidate) === false,
  });
  scoredJobs.sort(rankByFreshness);
  scored.sort(rankByFreshness);
  queued.sort(rankByFreshness);

  // Persist the full-visibility artifacts (found / scored / queued / review).
  const artifacts = writeAllArtifacts(
    config.root,
    { discovered, scored, queued, review: reviewRows, duplicates, errors, counters },
    deps,
  );

  // Report (built from reportRows so hard-discarded jobs are represented too).
  const stamp = deps.stamp ?? dateStamp(now);
  const report = generateReport({
    jobs: reportRows,
    outDir: join(config.root, 'reports'),
    stamp,
  });

  logger.endRun(counters);
  return {
    counters, scoredJobs, discovered, scored, queued, review: reviewRows,
    report, errors, artifacts, perSource, cancelled: searchCancelled,
    // Diagnostics that have no run_log column: retained-past-window rows,
    // unchanged stale rows not rewritten, expiries, re-scores, touches.
    stats,
  };
}

/** Compact entry for the data/found_jobs.json audit trail. */
function discoveredRow(job, discovery, extra = {}) {
  return {
    id: job.id,
    source: job.source,
    sourceKind: job.rawMetadata?.sourceKind ?? sourceKind(job.source),
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    postedAt: job.postedAt ?? null,
    discoveryMatch: discovery?.match ?? 'unknown',
    discoverySignals: discovery?.signals ?? [],
    discoveryReasons: discovery?.reasons ?? [],
    keptForScoring: extra.keptForScoring ?? false,
    lifecycle: extra.lifecycle ?? LIFECYCLE.FOUND,
    score: extra.score ?? null,
    tier: extra.tier ?? null,
    sponsorship: extra.sponsorship ?? null,
    matchedKeywords: extra.matchedKeywords ?? [],
    missingKeywords: extra.missingKeywords ?? [],
    packetPath: extra.packetPath ?? null,
    discardReason: extra.discardReason ?? null,
  };
}

/** Row shape consumed by the report summarizer (mirrors jobs-table columns). */
function reportRow(job, discovery, extra = {}) {
  return {
    id: job.id,
    source: job.source,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    posted_at: job.postedAt ?? null,
    discoveryMatch: discovery?.match ?? 'unknown',
    score: extra.score ?? null,
    tier: extra.tier ?? null,
    sponsorship: extra.sponsorship ?? null,
    discard_reason: extra.discard_reason ?? null,
    missing_keywords: extra.missing_keywords ?? [],
    status: extra.status ?? null,
    application_packet_path: extra.application_packet_path ?? null,
  };
}

/**
 * Build, persist, and enqueue an application packet for one job.
 * Exported so "Prepare selected" (dashboard) can prepare specific jobs the
 * human chose, not only the tiers the pipeline auto-selects.
 */
export async function preparePacket({ config, db, logger, job, score, tier, deps, counters }) {
  // Last line of defence before template text becomes a document addressed to a
  // real employer. A packet carries the candidate's name, contact details and
  // screening answers into a cover letter and a form-prefill payload, so a
  // profile that is still the shipped example must never reach this far. The
  // CLI and dashboard both gate on quickPreflight, but preparePacket is the one
  // chokepoint every path goes through — including "Prepare selected".
  const templated = findPlaceholders(config);
  if (!templated.ok) {
    const detail = templated.placeholders.map((t) => `${t.label} ("${t.value}")`).join(', ');
    logger?.warn?.({ job: job.id, placeholders: templated.placeholders.length },
      'refusing to prepare a packet from placeholder profile values');
    throw new Error(
      'Refusing to prepare an application packet: the candidate profile still holds '
      + `template text — ${detail}. Replace these with your real values in `
      + 'config/candidate.json and config/screening_answers.json, then run `npm run doctor`.',
    );
  }

  // SECOND CHOKEPOINT: whose career history is about to be tailored?
  //
  // The resume/profile identity check ran in `quickPreflight`, which only the
  // CLI and the dashboard's startup gate call. Packet preparation did not run
  // it, so the check could report a mismatch while "Prepare selected" and
  // auto-apply happily produced a tailored resume and a cover letter that put
  // the active profile's name and target role onto a different person's
  // career history — the exact document this repo most needs never to write.
  //
  // Preparation is where a profile becomes a document, so the check belongs
  // here as well as at startup. Skippable only by an explicit caller override,
  // which exists for tests that build packets from synthetic configs with no
  // resume on disk.
  if (deps.skipResumeIdentityCheck !== true) {
    const identityProblems = resumeProfileMismatch(
      config, masterResumeFile(config.root),
    );
    if (identityProblems.length) {
      logger?.warn?.({ job: job.id }, 'refusing to prepare a packet from a mismatched master resume');
      throw new Error(`Refusing to prepare an application packet: ${identityProblems[0]}`);
    }
  }

  const now = deps.now ?? new Date();
  // Professional, recruiter-friendly output location for every artifact:
  //   applications/output/{Company}/{Title}_{Date}_{JobID hash}/...
  const outPaths = buildJobPaths({
    root: config.root,
    company: job.company,
    title: job.title,
    dateOrId: dateStamp(now),
    // Without the job id this folder was {Company}/{Title}_{Date}, which two
    // different requisitions can share — and the second one prepared silently
    // overwrote the first one's resume, cover letter and packet, leaving the
    // first job's approval pointing at documents for a different job.
    jobId: job.id,
    candidateName: config.candidate?.identity?.fullName,
  });

  // Resume tailoring: an injected tailor wins (testing); otherwise run the real
  // Node->Python tailor. On any failure we fall back to the master resume and
  // record a warning so the packet is never silently broken. The master resume
  // is opened READ-ONLY by the tailor and is never overwritten.
  const master = masterResumeFile(config.root);
  let resumePath = master;
  let resumePdfPath = null;
  let resumePreviewWarning = null;
  let resumeTailored = false;
  // Assigned on every path below: from the tailor result, or by the catch.
  let resumeWarning;
  let resumeValidation = null;
  let resumeAtsReport = null;
  let resumeTailoring = null;
  const tailorFn = typeof deps.tailorFn === 'function' ? deps.tailorFn : tailorResumeForJob;
  try {
    // exportPdf — also emit a PDF alongside the .docx when enabled (most ATS
    // prefer PDF). Best-effort: requires Word/docx2pdf, falls back silently.
    // outputDir/outputFilename route the tailored docx straight into the
    // professional job folder with a clean, candidate-named filename.
    // The per-job "Most relevant to this role" focus line is OFF by default
    // (it read awkwardly near the header); opt back in with
    // config.runtime.resumeFocusLine === true.
    const tailored = await tailorFn({
      job, score, config,
      options: {
        addSummaryLine: config?.runtime?.resumeFocusLine === true,
        exportPdf: config?.runtime?.resumeExportPdf !== false,
        outputDir: outPaths.folder,
        outputFilename: `${outPaths.resumeBase}.docx`,
        // Rewrites the person accepted for this job (P1-2); verified against
        // the master resume, so the tailor can apply exactly these.
        acceptedRewrites: db ? acceptedRewritesFor(db, job.id) : [],
        // Bullets the person pinned for this job: never omitted to fit.
        keepBullets: db ? keptBulletsFor(db, job.id) : [],
        // config.runtime.resumeMaxPages: unset = 2, 0 = never omit to fit.
        maxPages: config?.runtime?.resumeMaxPages,
      },
      deps,
    });
    if (tailored?.output_path) resumePath = tailored.output_path;
    resumePdfPath = tailored?.pdf_path ?? null;
    resumePreviewWarning = tailored?.pdfWarning ?? null;
    resumeTailored = Boolean(tailored?.tailored);
    resumeWarning = tailored?.warning ?? null;
    resumeValidation = tailored?.validation ?? null;
    resumeAtsReport = tailored?.atsReport ?? null;
    resumeTailoring = tailored?.tailored
      ? {
          changes: tailored.changes ?? [],
          gaps: tailored.gaps ?? [],
          summaryLine: tailored.summaryLine ?? null,
          qualifications: tailored.qualifications ?? {},
          selectedContent: tailored.selectedContent ?? {},
          rewritePolicy: tailored.rewritePolicy ?? null,
          invariants: tailored.invariants ?? null,
          limitations: tailored.limitations ?? [],
          // Length is a review fact: the measured page count when a PDF was
          // rendered, the tailor's estimate otherwise.
          pageCount: tailored.pageCount ?? null,
          estimatedPages: tailored.invariants?.estimated_pages ?? null,
          // Audit for the optional grounded JD-requirement expansion.
          llmRequirements: tailored.llmRequirements ?? null,
        }
      : null;
    // A resume that fails hard validation (empty/unreadable/no sections/no
    // contact) must not be silently submitted — surface it as a warning so the
    // packet carries a blocker and the submit gate withholds.
    if (resumeValidation && resumeValidation.ok === false) {
      const why = (resumeValidation.issues ?? []).join('; ') || 'failed format validation';
      resumeWarning = resumeWarning ? `${resumeWarning}; ${why}` : `resume invalid: ${why}`;
    }
    if (resumeTailored) {
      logger.event(EVENT_TYPES.RESUME_GENERATED, {
        jobId: job.id, message: `tailored resume (${tailored.emphasized ?? 0} emphasized)`,
        meta: {
          output_path: resumePath, pdf_path: resumePdfPath, pdf_warning: resumePreviewWarning,
          validation: resumeValidation,
          atsScore: resumeAtsReport?.match_score ?? null, atsBand: resumeAtsReport?.band ?? null,
        },
      });
    } else if (resumeWarning) {
      logger.event(EVENT_TYPES.RESUME_GENERATED, {
        jobId: job.id, message: resumeWarning, level: 'warn',
        meta: { usedFallback: true },
      });
    }
  } catch (err) {
    resumeWarning = `resume tailoring failed: ${err.message}`;
    logger.error(resumeWarning, {}, job.id);
  }

  // Cover letter, only when warranted. The template is the default; with
  // COVER_LETTER_MODE=grounded the body is written paragraph by paragraph from
  // the resume and each paragraph is verified against it (P1-3). Either way it
  // goes through the same greeting, closing, humanizer and checks.
  let grounded = null;
  const env = deps.env ?? process.env;
  const templateChosen = db ? letterModeFor(db, job.id) === 'template' : false;
  if (letterSettings(env, { root: config.root }).enabled && !templateChosen) {
    try {
      grounded = await (deps.composeGroundedLetterFn ?? composeGroundedLetter)({
        job, config, requirements: keywordsForJob(score), env, deps,
      });
    } catch (err) {
      grounded = { ok: false, reason: `grounded letter failed: ${err.message}` };
    }
  }
  const cover = generateCoverLetter(job, score, {
    coverLetter: config.coverLetter,
    candidate: config.candidate,
    humanizerPatterns: config.humanizerPatterns,
    // The person's master cover letter, when they have written one: it is the
    // source of the letter's voice and claims (letterTailor.js).
    masterLetter: deps.masterLetterText ?? (config.root ? readMasterLetterText(config.root) : ''),
    ...(grounded?.ok ? { compose: () => grounded.body } : {}),
  });
  if (cover.generated) {
    cover.grounding = grounded?.ok
      ? { mode: 'grounded', task: grounded.provenance?.task ?? null, model: grounded.provenance?.model ?? null,
        paragraphs: grounded.paragraphs, dropped: grounded.dropped ?? [] }
      : { mode: cover.source === 'master' ? 'master' : 'template', fallbackReason: templateChosen ? 'you chose your template for this job' : (grounded ? grounded.reason : (cover.master && !cover.master.used ? cover.master.reason : null)), dropped: grounded?.dropped ?? [], master: cover.master ?? null };
    cover.grounding.quality = cover.quality ?? null;
  }
  let coverLetterPath = null;
  if (cover.generated) {
    coverLetterPath = writeCoverLetter(outPaths.folder, `${outPaths.coverLetterBase}.txt`, cover, deps);
    // The same text as a .docx for portals and recruiters that want a document.
    // Best-effort: the .txt above stays the file uploads use.
    const docxFn = deps.writeLetterDocxFn ?? (deps.writeFileImpl ? null : writeLetterDocx);
    if (docxFn) {
      try {
        cover.docxPath = await docxFn({
          text: cover.text, path: join(outPaths.folder, `${outPaths.coverLetterBase}.docx`), root: config.root, deps,
        });
      } catch (err) {
        logger.warn?.(`cover letter .docx not written: ${err.message}`);
      }
    }
    logger.event(EVENT_TYPES.COVER_LETTER_GENERATED, {
      jobId: job.id, message: `cover letter (${cover.wordCount} words, ${cover.grounding.mode})`,
    });
  }

  // Version history of this application's documents (P2-2). Real runs only:
  // a test that stubs file writes has no documents on disk to copy.
  const versionFn = deps.recordVersionFn ?? (deps.writeFileImpl ? null : recordVersion);
  if (versionFn) {
    try {
      versionFn(outPaths.folder, {
        cause: 'generated',
        files: {
          resume: resumeTailored ? resumePath : null, resumePdf: resumePdfPath,
          letter: coverLetterPath, letterDocx: cover.docxPath ?? null,
        },
        task: cover.grounding?.task ?? null,
      });
    } catch (err) {
      logger.warn?.(`document version not recorded: ${err.message}`);
    }
  }

  const packet = buildApplicationPacket({
    job, score, tier,
    candidate: config.candidate,
    screeningAnswers: config.screeningAnswers,
    resumePath, coverLetter: cover, coverLetterPath,
    resumeTailored, resumeWarning, resumePdfPath, resumePreviewWarning, resumeValidation,
    tailoring: resumeTailoring,
    // Stamp the candidate and search profile this packet was built for, so no
    // later path can fill it onto a different person's application. The resume
    // fingerprint rides along as provenance: it answers "which version of the
    // master resume were these documents tailored from?" for a packet a human
    // is reviewing days after it was built.
    owner: packetOwner({ ...config, resumeFingerprint: masterResumeFingerprint(config.root) }),
    atsReport: resumeAtsReport,
    formFields: job.formFields ?? [],
    html: job.html ?? '',
  });
  const packetPath = writePacket(packet, outPaths.folder, outPaths.packetName);
  persistJob(db, job, {
    status: 'prepared', resume_path: resumePath, cover_letter_path: coverLetterPath,
    resume_docx_path: resumeTailored ? resumePath : null,
    resume_pdf_path: resumePdfPath,
    application_packet_path: packetPath, output_folder_path: outPaths.folder,
    // The true "prepared on" timestamp — daily stats must not infer it from
    // updated_at, which any later note/decision/re-score would bump.
    prepared_at: new Date().toISOString(),
    ats_platform: packet.ats.platform,
    ats_score: resumeAtsReport?.match_score ?? null,
    ats_band: resumeAtsReport?.band ?? null,
  }, config.exclusions?.employmentTypes);

  enqueueForApproval(db, { packet, packetPath });
  counters.jobs_prepared += 1;
  logger.event(EVENT_TYPES.APPROVAL_REQUIRED, {
    jobId: job.id, message: `Packet prepared for ${job.company} - awaiting human approval`,
    meta: { packetPath, blockers: packet.blockers },
  });
  return packetPath;
}


/**
 * Content hash of the master resume, recorded on every packet as provenance.
 *
 * Hashes the FILE rather than its extracted text: this is a "which version was
 * this tailored from?" marker, it must be cheap enough to compute per packet,
 * and it must never be the thing that fails a preparation — an unreadable
 * resume is reported by its own checks, so this returns null instead.
 *
 * @param {string} root project root
 * @returns {string|null}
 */
function masterResumeFingerprint(root) {
  try {
    const master = masterResumeFile(root);
    if (!existsSync(master)) return null;
    return createHash('sha1').update(readFileSync(master)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function writeCoverLetter(dir, fileName, cover, deps) {
  const writeImpl = deps.writeFileImpl ?? defaultWrite;
  const path = join(dir, fileName);
  writeImpl(dir, path, cover.text);
  return path;
}

function defaultWrite(dir, path, text) {
  mkdirSync(dir, { recursive: true });
  // Atomic: readers must never observe a torn cover letter / artifact.
  writeFileAtomic(path, text, 'utf8');
}
/** Statuses owned by discovery/scoring — the only ones the guard applies to. */
/**
 * A description that says nothing: empty, or a pointer elsewhere ("See our
 * website for details", "N/A"). With no skills to find, the reachable score is
 * about 50, so a perfect role read as a weak one (audit 2026-11-11: an ICU
 * nurse post with an empty description scored 50, Near miss, 40 points below
 * the same post with its text). A SHORT but real description is still judged.
 */
const PLACEHOLDER_DESCRIPTION = /^(?:n\/?a|tbd|tba|none|-+|\.+)$|\b(?:see|visit|view|refer\s+to)\b[^.]{0,40}\b(?:website|site|link|posting|careers?\s+page|url)\b/i;

/**
 * Should this verdict be recorded as "not judged yet" instead? Only a low
 * verdict (Near miss or Discard) on a posting never read in full, or whose
 * description is empty or a placeholder, and never one whose TITLE already
 * rules it out.
 */
export function isUnjudgeable(job, tier, titleVerdict) {
  if (titleVerdict === 'reject') return false;
  if (tier !== TIERS.DISCARD && tier !== TIERS.NEAR_MISS) return false;
  if (job?.rawMetadata?.summaryOnly === true) return true;
  const text = String(job?.jdText ?? '').trim();
  return text === '' || (text.length < 80 && PLACEHOLDER_DESCRIPTION.test(text));
}

const DISCOVERY_STATUSES = new Set(['discarded', 'scored', 'unknown_date_review', 'needs_description']);

/**
 * Statuses of a row that is ON THE BOARD (or waiting to be read) and therefore
 * retained past the discovery window until the retention window retires it.
 * `queued` is a lifecycle, not a stored status: a Queue-tier row is 'scored'.
 */
const RETAINED_STATUSES = new Set(['scored', 'needs_description']);

/** Placeholder discovery result for rows recorded without classification. */
const UNCLASSIFIED = Object.freeze({ match: 'unknown', signals: [], reasons: ['not classified: dropped before scoring'] });

/** Consecutive successful source runs a row may be missing from before it expires. */
export const EXPIRE_AFTER_MISSED_RUNS = 3;

/** Rows per write transaction. */
const WRITE_CHUNK = 500;

/** Verdict columns a role search may never write onto a profile-owned row (F9). */
const VERDICT_COLUMNS = [
  'score', 'tier', 'sponsorship', 'sponsorship_signals', 'matched_keywords', 'missing_keywords',
  'explanation', 'scoring_fingerprint', 'status', 'discard_reason',
];

/**
 * Batch writes into chunked transactions (P5).
 *
 * Every upsert used to be its own implicit transaction — a journal sync per
 * row, ~65k per run. `db.transaction(fn)` is feature-detected; without it
 * writes run immediately, exactly as before. Writes are queued as thunks and
 * committed every WRITE_CHUNK rows; `flush()` must be called before any await
 * that could observe the rows (packet preparation) and at the end of a run.
 *
 * @param {object} db
 * @param {number} [chunk]
 * @returns {{write: (fn: () => void) => void, flush: () => void}}
 */
export function createWriter(db, chunk = WRITE_CHUNK) {
  const transactional = typeof db?.transaction === 'function';
  let queue = [];
  const flush = () => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    db.transaction(() => { for (const fn of batch) fn(); });
  };
  return {
    write(fn) {
      if (!transactional) { fn(); return; }
      queue.push(fn);
      if (queue.length >= chunk) flush();
    },
    flush,
  };
}

/**
 * A narrow reader for what discovery needs to know about a stored row — never
 * jd_text. Uses the raw connection when exposed (`db.db.prepare`), else
 * `getJob`, so it works against every Database shape the tests use.
 *
 * @param {object} db
 * @returns {(id: string) => object|null}
 */
function createStoredRowReader(db) {
  const raw = db?.db && typeof db.db.prepare === 'function' ? db.db : null;
  if (raw) {
    let stmt = null;
    return (id) => {
      try {
        stmt ??= raw.prepare(`SELECT id, status, discard_reason, posted_at, title, company, location, url,
            applied, application_packet_path, user_decision, discovery_mode, updated_at
          FROM jobs WHERE id = ?`);
        return stmt.get(id) ?? null;
      } catch {
        return null;
      }
    };
  }
  return (id) => db?.getJob?.(id) ?? null;
}

/**
 * Bring a freshly discovered job into agreement with what is already stored,
 * where the listing carries LESS information than the store (in place):
 *
 *  - a relative Workday date that still agrees with the stored one keeps the
 *    stored date (P8), so an unchanged requisition is not rewritten;
 *  - a blank location takes the stored one (S8a), so a listing that collapsed
 *    "2 Locations" to '' neither erases the place nor escapes the US gate.
 */
function reconcileWithStored(job, stored, now) {
  if (!stored || !job) return;
  if (job.rawMetadata?.postedAtApprox && stored.posted_at
    && postedOnAgrees(job.rawMetadata.postedOnLabel, stored.posted_at, now)) {
    job.postedAt = stored.posted_at;
  }
  if (!String(job.location ?? '').trim() && String(stored.location ?? '').trim()) {
    job.location = String(stored.location).trim();
    job.rawMetadata = { ...(job.rawMetadata ?? {}), locationFromStore: true };
  }
}

/** Two discard reasons of the same kind ("stale: …" vs "stale: …"). */
function sameDiscardKind(a, b) {
  const kind = (r) => String(r ?? '').split(':')[0].trim();
  return Boolean(a) && kind(a) === kind(b);
}

/** Identity fields of a posting, stored vs incoming (no jd_text needed). */
function postingUnchanged(row, job) {
  return String(row.company ?? '') === String(job.company ?? '')
    && String(row.title ?? '') === String(job.title ?? '')
    && String(row.url ?? '') === String(job.url ?? '')
    && String(row.posted_at ?? '') === String(job.postedAt ?? '');
}

/** Material fields whose change warrants re-scoring an already-seen posting. */
function materiallyUnchanged(row, job) {
  return String(row.company ?? '') === String(job.company ?? '')
    && String(row.title ?? '') === String(job.title ?? '')
    // A blank incoming location never overwrites the stored one, so it cannot
    // be a material change either.
    && (!String(job.location ?? '').trim() || String(row.location ?? '') === String(job.location ?? ''))
    && String(row.url ?? '') === String(job.url ?? '')
    && String(row.jd_text ?? '') === String(job.jdText ?? '')
    && String(row.posted_at ?? '') === String(job.postedAt ?? '')
    && String(row.employment_type ?? '') === String(job.employmentType ?? '');
}

/** Refresh only `updated_at` — "still listed" — without touching any value. */
function touchJob(db, id) {
  db.upsertJob({ id });
}

/**
 * An exclusion-shaped verdict when the posting's own `validThrough` has passed.
 * @returns {object|null}
 */
function validThroughExpired(job, now) {
  const raw = job?.rawMetadata?.validThrough;
  if (!raw) return null;
  const at = Date.parse(String(raw));
  if (!Number.isFinite(at) || at >= now.getTime()) return null;
  const reason = `expired: validThrough ${String(raw).slice(0, 10)} has passed`;
  return { excluded: true, category: 'expired', reason, matched: [reason], flags: [] };
}

/**
 * compensation_text for a posting that has no compensation field but states
 * pay in its description (M4), so the board shows what the score used.
 */
function payFields(job) {
  if (job.rawMetadata?.compensation) return {};
  const pay = postedPay(job);
  return pay?.source === 'description' && pay.text ? { compensation_text: pay.text } : {};
}

function persistJob(db, job, fields = {}, markers = {}, mode = null, { omitJd = false } = {}) {
  const patch = { ...fields };
  // Downgrade guard: a re-discovered job the human already invested in
  // (decision, packet, approval, assist outcome, submission) keeps its status —
  // a stale/duplicate hit must never flip a prepared job back to "discarded".
  // Metadata (JD text, posted date, URL, score fields) still refreshes.
  // Narrow read where available — the guard only inspects four columns, so it
  // must not drag the row's jd_text along for every re-seen posting.
  const protectionRow = () => (typeof db.getJobProtectionFields === 'function'
    ? db.getJobProtectionFields(job.id)
    : db.getJob?.(job.id));
  const existing = mode || DISCOVERY_STATUSES.has(patch.status) ? protectionRow() : null;
  if (DISCOVERY_STATUSES.has(patch.status) && isProtectedJobRow(existing)) {
    delete patch.status;
    delete patch.discard_reason;
  }

  /*
   * WHO OWNS THIS ROW — and the one direction ownership may move.
   *
   * A personalized run always claims the row: finding a posting through the
   * saved profile is proof it belongs on the personalized board, even if an
   * ad-hoc role search happened to surface it first. The reverse is forbidden.
   * A role search that stumbles onto a job the profile already owns must leave
   * it alone, or typing "Product Manager" once would quietly re-label rows the
   * personalized search had earned — the exact leak the two modes exist to
   * prevent. Omitting the columns entirely (rather than writing null) leaves
   * them out of the UPDATE set, so the stored value survives untouched.
   */
  if (mode?.discovery_mode === 'profile') {
    patch.discovery_mode = 'profile';
    patch.search_query = null;
  } else if (mode?.discovery_mode === 'role_search') {
    const owner = existing?.discovery_mode ?? (existing ? 'profile' : null);
    if (owner === null) {
      patch.discovery_mode = 'role_search';
      patch.search_query = mode.search_query ?? null;
    } else if (owner === 'profile') {
      // F9 — THE VERDICT BELONGS TO THE OWNER TOO. A role search judges the
      // posting against the same profile vocabulary but with keepBelowThreshold
      // and its own ad-hoc intent; writing its score/tier/status over a
      // profile-owned row was measured turning 93 Priority rows into Apply. The
      // search may refresh the posting's text and metadata, nothing else.
      for (const col of VERDICT_COLUMNS) delete patch[col];
    }
  }
  const location = String(job.location ?? '').trim();
  db.upsertJob({
    id: job.id,
    source: job.source,
    company: job.company,
    title: job.title,
    // A blank location is "the listing did not say", never "the place is
    // unknown now" — omitted, so the stored place survives (S8a).
    ...(location ? { location: job.location } : {}),
    url: job.url,
    // Stale and excluded discards never have their description read again, so
    // the text is not written (P5); the stored text, if any, is left as is.
    ...(omitJd ? {} : { jd_text: job.jdText }),
    posted_at: job.postedAt,
    applicant_count: job.applicantCount,
    employment_type: job.employmentType,
    employment_category: patch.employment_category ?? classifyEmployment(job, markers).category,
    // 1 when the description was never fetched, so downstream can tell
    // "judged and rejected" apart from "never read".
    summary_only: job.rawMetadata?.summaryOnly === true ? 1 : 0,
    ...(job.rawMetadata?.compensation
      ? { compensation_text: String(job.rawMetadata.compensation).trim() }
      : {}),
    ...patch,
  });
}

/**
 * M3 — retire rows their source has stopped listing.
 *
 * A row is expired when its source completed a FULL listing (no real error,
 * not cancelled) in each of its last EXPIRE_AFTER_MISSED_RUNS recorded runs and
 * the row was not seen in any of them. "Seen" is `updated_at`: every returned
 * posting is written or touched during the run, so a row whose updated_at is
 * older than the earliest of those runs was absent from all of them. A source
 * with any unsuccessful run inside that span is skipped — a failed board
 * proves nothing about its postings.
 *
 * Only active rows (scored / needs_description) are touched, never a row the
 * human invested in. Lifecycle has no 'expired' status, so the row becomes
 * `discarded` with reason "expired: not listed by source for N runs".
 *
 * @returns {number} rows expired
 */
export function expireUnlisted({
  db, perSource = [], sourceTimings, writer = null, runs = EXPIRE_AFTER_MISSED_RUNS,
} = {}) {
  const raw = db?.db && typeof db.db.prepare === 'function' ? db.db : null;
  if (!raw || typeof sourceTimings?.historyOf !== 'function') return 0;
  // Aggregate adapters (atsSearch, careers, apify, adzuna) write rows under the
  // DIRECT sources' names. If one of them did not complete this run, a row it
  // alone still lists was not touched, so no source name may be expired.
  if (perSource.some((e) => !adapterSourceName(e?.adapter) && e?.succeeded !== true)) return 0;
  const w = writer ?? createWriter(db);
  let expired = 0;
  const reason = `expired: not listed by source for ${runs} runs`;
  // Every configured source of an adapter must qualify: two Workday sources
  // both write `source = 'workday'`, and one failing says nothing about the
  // other's rows.
  const byAdapter = new Map();
  for (const entry of perSource) {
    const name = adapterSourceName(entry?.adapter);
    if (!name || !entry.source) continue;
    if (!byAdapter.has(name)) byAdapter.set(name, []);
    byAdapter.get(name).push(entry);
  }
  for (const [sourceName, entries] of byAdapter) {
    let cutoff = null;
    let qualifies = true;
    for (const entry of entries) {
      const history = sourceTimings.historyOf(entry.source).filter((h) => !h.cancelled && !h.cached);
      const recent = history.slice(0, runs);
      if (!entry.succeeded || recent.length < runs || recent.some((h) => h.ok !== true)) { qualifies = false; break; }
      // `at` is stamped when the SEARCH ends, before any row is written, so a
      // row seen in the oldest of these runs has updated_at >= its `at`.
      const at = recent[runs - 1].at;
      if (!at) { qualifies = false; break; }
      cutoff = cutoff === null || at < cutoff ? at : cutoff;
    }
    if (!qualifies || !cutoff) continue;
    let rows;
    try {
      rows = raw.prepare(`SELECT id, applied, application_packet_path, user_decision, status FROM jobs
        WHERE source = ? AND status IN ('scored', 'needs_description')
          AND coalesce(updated_at, '') < ?
          AND (discovery_mode IS NULL OR discovery_mode = 'profile')`).all(sourceName, cutoff);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (isProtectedJobRow(row)) continue;
      expired += 1;
      w.write(() => db.upsertJob({ id: row.id, status: 'discarded', discard_reason: reason }));
    }
  }
  w.flush();
  return expired;
}

/**
 * The `jobs.source` value an adapter writes. Adapter ids and source names are
 * the same for every direct adapter; the aggregate adapters (careers,
 * atsSearch, apify, manualUrls) write rows under OTHER sources' names, so a
 * run of theirs says nothing about which rows are still listed — they are
 * never used for expiry.
 */
function adapterSourceName(adapter) {
  return ['workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'rippling',
    'oracleRecruiting', 'icims', 'amazonJobs'].includes(adapter)
    ? adapter
    : null;
}

/**
 * A place for a stored Workday row whose location was saved blank.
 *
 * Discovery now recovers it from the posting URL (`/job/<Location>/…`), but
 * only when a job is rediscovered. Rows stored before that kept '', which the
 * US-only gate reads as "unknown, keep": on 2026-09-23 three Accenture
 * `/job/Hyderabad/…` requisitions were still on the board at score 72–79.
 * Re-scoring reads the same URL segment so stored rows are judged on it too.
 */
function storedWorkdayLocation(row) {
  if (!/\.myworkdayjobs\.com\//i.test(String(row.url ?? ''))) return '';
  try {
    const path = new URL(row.url).pathname;
    const at = path.indexOf('/job/');
    return at < 0 ? '' : locationFromExternalPath(path.slice(at));
  } catch {
    return '';
  }
}

/**
 * F10 — re-judge active rows whose stored verdict was produced by a DIFFERENT
 * configuration, from their stored description. No network.
 *
 * Rows: status scored / needs_description with scoring_fingerprint ≠ the
 * current one. Each goes through the same exclusions → sponsorship → score →
 * tier chain as discovery, so a changed profile, weight, taxonomy or
 * sponsorship list takes effect on the whole board at once instead of only on
 * postings that happen to be re-listed. Role-search rows keep their
 * below-threshold visibility. Protected rows keep their status (the persist
 * guard), but their verdict columns refresh.
 *
 * Exported for the `rescore` CLI command and called at the end of every
 * pipeline run and on profile activation.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.config loadConfig() bundle
 * @param {Date} [args.now]
 * @param {string} [args.fingerprint] precomputed scoringFingerprint(config)
 * @param {number} [args.limit] cap per call (default: all)
 * @returns {{rescored: number, discarded: number, unread: number}}
 */
export function rescoreStale({ db, config, now = new Date(), fingerprint, limit = Infinity } = {}) {
  const out = { rescored: 0, discarded: 0, unread: 0 };
  const raw = db?.db && typeof db.db.prepare === 'function' ? db.db : null;
  if (!raw || !config?.scoring) return out;
  const current = fingerprint ?? scoringFingerprint(config);
  // AGE IS A VERDICT INPUT TOO. Retention used to be enforced only when a
  // source re-listed the posting, so a row nobody rediscovered (no run for
  // weeks, a source that stopped listing it) stayed "scored" forever — the
  // store held 2,089 active rows past the 45-day limit and Today led with a
  // 67-day-old job. Rows posted before the retention cutoff are re-judged here
  // whatever their fingerprint, and the exclusion stage retires them exactly as
  // it would on rediscovery. The cutoff sits one FULL day past retention, as a
  // timestamp: with a date-only cutoff a posting 45.x days old was selected,
  // judged "45 days" (not > 45) by the exclusion stage, kept, and re-selected
  // on every sweep. ISO timestamps and date-only strings both compare
  // correctly as text against it.
  const retentionDays = Number(config.exclusions?.staleness?.skipOlderThanDays);
  const cutoff = Number.isFinite(retentionDays) && retentionDays > 0
    ? new Date(now.getTime() - (retentionDays + 1) * 864e5).toISOString()
    : null;
  let rows;
  try {
    rows = raw.prepare(`SELECT id, source, company, title, location, url, jd_text, posted_at,
        applicant_count, employment_type, compensation_text, summary_only, discovery_mode, search_query
      FROM jobs
      WHERE status IN ('scored', 'needs_description')
        AND (coalesce(scoring_fingerprint, '') <> ?
          OR (? IS NOT NULL AND posted_at IS NOT NULL AND posted_at <> '' AND posted_at < ?
            AND coalesce(applied, 0) = 0 AND coalesce(application_packet_path, '') = ''
            AND coalesce(user_decision, '') = ''))`)
      .all(current, cutoff, cutoff);
  } catch {
    return out;
  }
  const vocab = config.candidate ? profileVocabularyFor(config.candidate) : null;
  const freshnessModel = freshnessModelFor(config);
  const markers = config.exclusions?.employmentTypes;
  const writer = createWriter(db);
  for (const row of rows.slice(0, Number.isFinite(limit) ? limit : rows.length)) {
    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title,
      location: row.location || storedWorkdayLocation(row), url: row.url, jdText: row.jd_text ?? '',
      postedAt: row.posted_at, applicantCount: row.applicant_count,
      employmentType: row.employment_type ?? '', compensationText: row.compensation_text ?? '',
      rawMetadata: { summaryOnly: Number(row.summary_only) === 1 },
    };
    const keepBelow = row.discovery_mode === 'role_search';
    const mode = row.discovery_mode === 'role_search'
      ? { discovery_mode: 'role_search', search_query: row.search_query ?? null }
      : { discovery_mode: 'profile', search_query: null };
    const exclusion = applyExclusions(job, config.exclusions ?? {}, { now, candidate: config.candidate });
    let fields;
    if (exclusion.excluded) {
      out.discarded += 1;
      fields = { status: 'discarded', discard_reason: exclusion.reason, scoring_fingerprint: current };
    } else {
      const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
      const score = scoreJob(job, { scoring: config.scoring, sponsorship, candidate: config.candidate, now, freshnessModel });
      const titleVerdict = vocab ? classifyTitleFit(job.title, vocab).verdict : null;
      const { tier, explanation } = explainScore(score, config.scoring, { titleVerdict, candidate: config.candidate });
      const unread = isUnjudgeable(job, tier, titleVerdict);
      if (unread) out.unread += 1;
      else if (tier === TIERS.DISCARD && !keepBelow) out.discarded += 1;
      fields = {
        score: score.total, tier, sponsorship: sponsorship.status,
        sponsorship_signals: sponsorship.signals ?? [],
        matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
        explanation, scoring_fingerprint: current,
        status: tier === TIERS.DISCARD && !keepBelow ? 'discarded' : 'scored',
        discard_reason: tier === TIERS.DISCARD && !keepBelow ? 'below near-miss threshold' : null,
        ...(unread ? {
          status: 'needs_description',
          discard_reason: job.rawMetadata?.summaryOnly
            ? 'not judged: the description was never fetched (summary only)'
            : 'not judged: the posting has no description to judge fit by',
          tier: null,
        } : {}),
      };
    }
    out.rescored += 1;
    // `mode` is passed only to keep ownership stable; a row's own owner is
    // re-judging it, so the F9 guard (role search over a profile row) never fires.
    writer.write(() => persistJob(db, job, fields, markers, mode.discovery_mode === 'role_search' ? null : mode));
  }
  writer.flush();
  return out;
}
