/**
 * CLI command orchestration.
 *
 * Composes the existing building blocks (search, pipeline, packets, approval
 * queue, browser automation) into the discrete phases a user drives from the
 * command line:
 *
 *   discover      search only            -> data/found_jobs.json
 *   score         search + score          -> scored_jobs.json + queued_jobs.json
 *   prepare-apps  + tailor + packets       -> data/packets + approval queue
 *   assist        open browser + fill      -> stops before submit
 *   end-to-end    discover -> ... -> assist (always stops before submit)
 *
 * Plus the approval-queue commands (approvals/approve/reject/packets/packet).
 *
 * Every function takes its dependencies (config/db/logger) so it is testable in
 * isolation; the thin CLI in src/index.js wires the real ones.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { runSearch } from '../search/index.js';
import { classifyDiscovery } from '../search/discoveryFilter.js';
import { sourceKind } from '../search/sources.js';
import { fetchUrl } from '../search/adapters/genericPublicPage.js';
import { runPipeline, preparePacket } from '../pipeline/index.js';
import { jsonList } from '../utils/json.js';
import { writeFoundJobs } from '../outputs.js';
import { emptyCounters } from '../outputs.js';
import { LIFECYCLE, isProtectedJobRow } from '../lifecycle.js';
import { assertPublicHttpUrl, publicOnlyFetch } from '../utils/publicUrl.js';
import { createSafeFetch, safeFetch } from '../utils/safeFetch.js';
import {
  listPending, approve, reject, APPROVAL_STATUS,
} from '../apply/approvalQueue.js';
import { applyExclusions } from '../scoring/exclusionFilter.js';
import { classifySponsorship, SPONSORSHIP } from '../scoring/sponsorshipClassifier.js';
import { classifyEmployment } from '../scoring/employmentClassifier.js';
import { scoreJob, freshnessModelFor } from '../scoring/scorer.js';
import { explainScore } from '../scoring/explainScore.js';
import { scoringFingerprint } from '../scoring/fingerprint.js';
import { assistApply } from '../automation/applyRunner.js';
import { packetOwnershipCheck } from '../apply/applicationPacket.js';
import { EVENT_TYPES } from '../logging/jobLogger.js';
import { isQueryFirstAdapter } from '../search/sources.js';

/**
 * DISCOVER — search only, write data/found_jobs.json (no scoring).
 * @returns {Promise<{ counters: object, found: string, jobs: object[] }>}
 */
export async function runDiscover({ config, logger, deps = {} } = {}) {
  const searchFn = deps.searchFn ?? runSearch;
  logger?.event?.(EVENT_TYPES.SEARCH_START, { message: 'Discovery search starting' });
  const { jobs, duplicates, errors } = await searchFn({
    jobboards: config.jobboards,
    candidate: config.candidate,
    scoring: config.scoring,
    existsInDb: () => false,
  });
  logger?.event?.(EVENT_TYPES.SEARCH_END, {
    message: `Discovery complete: ${jobs.length} jobs`,
    meta: { found: jobs.length, duplicates: duplicates.length, errors: errors.length },
  });

  const discovered = jobs.map((job) => {
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    return {
      id: job.id,
      source: job.source,
      sourceKind: job.rawMetadata?.sourceKind ?? sourceKind(job.source),
      company: job.company,
      title: job.title,
      location: job.location,
      url: job.url,
      discoveryMatch: discovery?.match ?? 'unknown',
      discoverySignals: discovery?.signals ?? [],
      discoveryReasons: discovery?.reasons ?? [],
      keptForScoring: null,
      lifecycle: LIFECYCLE.FOUND,
      score: null,
      tier: null,
      sponsorship: null,
      matchedKeywords: [],
      missingKeywords: [],
      packetPath: null,
      discardReason: null,
    };
  });

  const counters = { ...emptyCounters(), jobs_found: jobs.length };
  const found = writeFoundJobs(config.root, { discovered, duplicates, errors, counters }, deps);
  return { counters, found, jobs: discovered, errors };
}

/**
 * SCORE — search + score, write found/scored/queued artifacts (no packets).
 * Delegates to the pipeline in DRY_RUN mode.
 */
export async function runScore({ config, db, logger, deps = {} } = {}) {
  return runPipeline({ config, db, logger, mode: 'DRY_RUN', deps });
}

/**
 * QUERY SEARCH — find jobs matching an ad-hoc phrase, right now.
 *
 * The board already had a free-text filter, but it only filtered rows that had
 * ALREADY been discovered. There was no way to ask the job boards a new
 * question: every run searched `candidate.targetTitles` and nothing else. So
 * trying a different role meant editing the profile and waiting for a full run.
 *
 * Two deliberate narrowings make this fast enough to be interactive:
 *
 *   1. Only QUERY_FIRST_ADAPTERS run (Workable via atsSearch, Adzuna). They
 *      search across employers from a phrase and return in seconds. A full run
 *      enumerates 226 Workday tenants for ~14 minutes, which is not a search box.
 *   2. The query is injected as `options.queries`, which both adapters already
 *      support, so no adapter needed changing.
 *
 * For this call only, in a config copy that is never written, the phrase BECOMES
 * the target list. Without that, `classifyDiscovery` would judge the results
 * against the stored profile and discard the very rows the user just asked for —
 * searching "product manager" from a data-engineering profile would return
 * nothing and look broken. Nothing about the saved profile changes.
 *
 * Every row written here is stamped `discovery_mode = 'role_search'` with the
 * phrase, so these results have their own list and never reach the personalized
 * board. That stamp is what makes the two flows independent; see the pipeline's
 * `runMode` and `boardPage`'s scope.
 *
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {object} args.db
 * @param {object} args.logger
 * @param {string} args.query free-text role/phrase to search for
 * @param {object} [args.deps]
 * @returns {Promise<{ query: string, counters: object, sources: string[], errors: object[] }>}
 */
export async function runQuerySearch({ config, db, logger, query, deps = {} } = {}) {
  const phrase = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (!phrase) throw new Error('a search needs a query');
  if (phrase.length > 120) throw new Error('that search phrase is too long (limit 120 characters)');

  const all = config?.jobboards?.sources ?? [];
  const sources = all
    .filter((src) => src.enabled && isQueryFirstAdapter(src.adapter))
    .map((src) => ({
      ...src,
      options: { ...(src.options ?? {}), queries: [phrase] },
    }));

  if (sources.length === 0) {
    throw new Error(
      'no query-capable source is enabled. Enable `ats-search` (keyless) or '
      + '`adzuna-aggregator` in config/jobboards.json to search by phrase.',
    );
  }

  /*
   * THE SEARCHED PHRASE IS THE WHOLE PROFILE, FOR THIS CALL ONLY.
   *
   * This used to PREPEND the phrase to the saved `targetTitles` and keep the
   * rest. That made a role search a personalized search with one extra term:
   * asking for "Product Manager" still recognized, scored and boarded every
   * data-engineering title on the list, so the two features returned
   * overlapping results and neither answered its own question cleanly.
   *
   * Replacing the list instead makes this mode mean exactly what its name says
   * — find what the market calls THIS role — and is safe precisely because the
   * rows it writes are stamped `role_search` and never reach the personalized
   * board. Nothing here is persisted to config: `searchConfig` is a copy, and
   * the saved profile is untouched.
   */
  const searchConfig = {
    ...config,
    jobboards: { ...config.jobboards, sources },
    candidate: {
      ...config.candidate,
      targetTitles: [phrase],
      anchorTitles: [phrase],
      adjacentTitles: [],
      searchPhrases: [phrase],
    },
  };

  const result = await runPipeline({
    config: searchConfig, db, logger, mode: 'DRY_RUN',
    deps: {
      ...deps,
      // The user asked for these rows by name. Scoring them against a keyword
      // vocabulary built for a different role and then discarding them would
      // return nothing and look broken — see keepBelowThreshold in the pipeline.
      keepBelowThreshold: true,
      // What makes the line above safe: every row written here is stamped as
      // belonging to THIS query, so keeping low scorers cannot leak them onto
      // the personalized board.
      discoveryMode: 'role_search',
      searchQuery: phrase,
    },
  });
  return {
    query: phrase,
    counters: result.counters ?? {},
    sources: sources.map((src) => src.id),
    errors: result.errors ?? [],
  };
}

/**
 * PREPARE_APPS — search + score + tailor resumes + build packets + enqueue.
 * Delegates to the pipeline in PREPARE mode.
 */
export async function runPrepareApps({ config, db, logger, deps = {} } = {}) {
  return runPipeline({ config, db, logger, mode: 'PREPARE', deps });
}

/**
 * DB statuses a re-score may overwrite — rows still owned by the pipeline.
 *
 * `unknown_date_review` is included deliberately. Discovery routes any posting
 * with no parseable date into that bucket WITHOUT scoring it, so those rows
 * have no score, no tier, and no explanation. Omitting the status here made the
 * bucket a permanent dead end: never scored on the way in, and skipped by the
 * one command that could score them afterwards. 2,509 rows in the live database
 * had a null posting date and could never become actionable no matter what the
 * user did. A missing DATE is not a reason to refuse to judge the ROLE.
 */
const RESCORABLE_STATUSES = new Set([
  LIFECYCLE.FOUND, LIFECYCLE.SCORED, LIFECYCLE.NEAR_MISS, 'discarded',
  'unknown_date_review', '', null, undefined,
]);

/**
 * RE-SCORE — recompute exclusions, sponsorship, score, tier, and explanation
 * for every job ALREADY in the DB, from its stored JD. Purely local: no
 * discovery, no network. This is what the dashboard's "Re-score" button runs
 * (it used to silently re-run the full discovery pipeline).
 *
 * Only rows still owned by the pipeline are touched: anything the human acted
 * on (decision, packet, approval, assist outcome, submission) keeps both its
 * status AND its recorded score untouched.
 *
 * @param {object} args { config, db, logger, deps }
 * @returns {Promise<{ counters: object }>}
 */
export async function runRescore({ config, db, logger, deps = {} } = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : deps.now ?? new Date();
  // Stream by id rather than materializing every row: each row carries its full
  // JD text (~150 MB across a 32k-job corpus) and only one is needed at a time.
  // Falls back to the eager read for test stubs without listJobIds.
  /*
   * RE-SCORE JUDGES THE PERSONALIZED BOARD, AND ONLY IT.
   *
   * Re-scoring recomputes fit against the SAVED PROFILE. Applying that to a row
   * an ad-hoc role search found is a category error: the user asked for that
   * job by name, and the profile's vocabulary has no opinion worth acting on
   * about a role outside it. Measured before this scope existed, one re-score
   * took a "Senior Product Manager, Payments" kept at 20/100 by an explicit
   * search for "Product Manager", re-tiered it Discard, and marked it
   * `discarded` — emptying the role-search list the user had just built, with
   * no action of theirs and no way to tell what had happened.
   */
  const ids = typeof db.listJobIds === 'function' ? db.listJobIds({ mode: 'profile' }) : null;
  const eagerRows = ids ? null : db.listJobs({});
  const total = ids ? ids.length : eagerRows.length;
  const counters = { jobs_rescored: 0, jobs_excluded: 0, jobs_skipped_protected: 0 };

  let i = 0;
  for (let index = 0; index < total; index += 1) {
    if (deps.shouldCancel?.()) {
      counters.jobs_cancelled = (counters.jobs_cancelled ?? 0) + 1;
      break;
    }
    // Yield the event loop periodically so the dashboard stays responsive
    // while tens of thousands of rows are re-scored in the background.
    i += 1;
    if (i % 250 === 0) await new Promise((r) => setImmediate(r));
    const row = ids ? db.getJob(ids[index]) : eagerRows[index];
    if (!row) continue;

    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title,
      location: row.location, url: row.url, jdText: row.jd_text ?? '',
      postedAt: row.posted_at, applicantCount: row.applicant_count,
      employmentType: row.employment_type,
    };

    if (isProtectedJobRow(row) || !RESCORABLE_STATUSES.has(row.status)) {
      // The row's WORKFLOW state is the human's and stays untouched — status,
      // score, tier, decision, packet all keep their values.
      //
      // Its SPONSORSHIP VERDICT is a fact about the employer, not workflow
      // state, and a wrong one must never be preserved. These are the most
      // dangerous rows in the corpus: after the polarity fix, 4 rows still read
      // "Confirmed" — all of them `prepared`/`assist_blocked`, i.e. packets
      // built and queued to apply to employers whose postings refuse
      // sponsorship in writing ("does not provide work visa sponsorship").
      // Refreshing the verdict here means the human sees the refusal before
      // submitting, without the re-score touching anything they own.
      const verdict = classifySponsorship(job, config.scoring.sponsorship);
      // Also backfill when the verdict is unchanged but its evidence was never
      // recorded — otherwise the badge keeps telling the reader to re-score to
      // capture evidence that a re-score would skip.
      if (verdict.status !== row.sponsorship || !row.sponsorship_signals) {
        db.upsertJob({
          id: job.id,
          sponsorship: verdict.status,
          sponsorship_signals: verdict.signals ?? [],
        });
        counters.jobs_sponsorship_corrected = (counters.jobs_sponsorship_corrected ?? 0) + 1;
      }
      counters.jobs_skipped_protected += 1;
      continue;
    }

    // Same chain as discovery: exclusions -> sponsorship -> score -> tier.
    const exclusion = applyExclusions(job, config.exclusions, { now, candidate: config.candidate });
    if (exclusion.excluded) {
      // The sponsorship verdict is refreshed for EVERY discarded row, whatever
      // the discard reason. It is a fact about the employer, independent of why
      // this posting was dropped, and leaving it alone preserved verdicts from
      // the old polarity-blind logic: 454 rows discarded for geography or
      // staleness still read "Confirmed" — with no evidence — and resurfaced
      // that way the moment "Closed jobs" was ticked.
      const denied = exclusion.category === 'sponsorship_denial';
      const verdict = denied
        ? { status: SPONSORSHIP.DENIED, signals: exclusion.matched }
        : classifySponsorship(job, config.scoring.sponsorship);
      db.upsertJob({
        id: job.id,
        status: 'discarded',
        discard_reason: exclusion.reason,
        sponsorship: verdict.status,
        sponsorship_signals: verdict.signals ?? [],
      });
      counters.jobs_excluded += 1;
      continue;
    }
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const score = scoreJob(job, {
      scoring: config.scoring, sponsorship, candidate: config.candidate, now, freshnessModel: freshnessModelFor(config),
    });
    const { tier, explanation } = explainScore(score, config.scoring, { candidate: config.candidate });
    db.upsertJob({
      id: job.id,
      score: score.total, tier, sponsorship: sponsorship.status,
      sponsorship_signals: sponsorship.signals ?? [],
      employment_category: classifyEmployment(job, config.exclusions?.employmentTypes).category,
      matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
      explanation,
      // The configuration that produced this verdict, so incremental discovery
      // can tell a current score from one judged under a different profile.
      scoring_fingerprint: scoringFingerprint(config),
      status: tier === 'Discard' ? 'discarded' : 'scored',
      discard_reason: tier === 'Discard' ? 'below score threshold on re-score' : null,
    });
    counters.jobs_rescored += 1;
  }

  logger?.event?.(EVENT_TYPES.SCORE_EXPLAINED, {
    message: `re-score complete: ${counters.jobs_rescored} rescored, `
      + `${counters.jobs_excluded} excluded, ${counters.jobs_skipped_protected} protected`,
    meta: counters,
  });
  return { counters };
}

/**
 * ADD ONE JOB BY URL — the fully-compliant manual path for postings on sites
 * the discovery adapters cannot enumerate (Microsoft/Amazon/Apple and other
 * custom/Eightfold/bot-protected career platforms). Fetches ONLY the public
 * page the user pasted (schema.org JobPosting JSON-LD, else readable content),
 * then runs the SAME exclusion → sponsorship → score → tier logic the pipeline
 * uses, and persists the job so it appears on the board to triage/prepare/assist
 * exactly like a discovered one. No login, no scraping of search results, no
 * evasion — one public URL the human chose.
 *
 * @param {object} args
 * @param {object} args.config loadConfig bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} [args.logger]
 * @param {string} args.url a public job posting URL
 * @param {object} [args.deps] { fetchImpl, lookupImpl, now }
 * @returns {Promise<{ id, company, title, url, score, tier, sponsorship, appStatusHint, alreadyExisted }>}
 */
export async function ingestUrl({ config, db, logger, url, deps = {} } = {}) {
  const clean = String(url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(clean)) {
    throw Object.assign(new Error('please paste a valid public job URL (http/https)'), { statusCode: 400 });
  }
  // Same guard the check-link / replace-link endpoints already applied. Without
  // it this was the one path that would fetch an arbitrary host on request —
  // including loopback, link-local metadata, and private LAN addresses.
  const publicCheck = assertPublicHttpUrl(clean);
  if (!publicCheck.ok) {
    throw Object.assign(new Error(publicCheck.reason), { statusCode: 400 });
  }
  const now = deps.now ?? new Date();
  // The check above covers the pasted URL's shape only. The real fetch is
  // safeFetch, which checks every hop AND the address each hop resolves to when
  // it connects, so neither a redirect nor a public name that resolves to a
  // private address can bounce the read onto this machine or the LAN. An
  // injected fetch (tests) keeps the per-hop shape check.
  const fetchImpl = deps.fetchImpl
    ? publicOnlyFetch(deps.fetchImpl)
    : (deps.lookupImpl ? createSafeFetch({ lookupImpl: deps.lookupImpl }) : safeFetch);

  let parsed;
  try {
    parsed = await fetchUrl(clean, { fetchImpl, source: 'manual-url', maxRetries: 1 });
  } catch (err) {
    // An address the guard refused is the user's input problem, not the site's.
    if (err?.code === 'BLOCKED_URL') {
      throw Object.assign(new Error(err.message), { statusCode: 400 });
    }
    // A blocked/erroring page is a normal outcome for bot-protected sites — be
    // honest rather than fabricate a job. Never bypass the protection.
    throw Object.assign(
      new Error(`could not read that page (${err.message}). Some career sites block automated reads — open it and paste the job description manually if needed.`),
      { statusCode: 422 },
    );
  }
  const job = parsed[0];
  if (!job || (!job.title && !job.jdText)) {
    throw Object.assign(
      new Error('no job posting found at that URL (no readable title or description). It may require login or block automated reads.'),
      { statusCode: 422 },
    );
  }

  const existed = Boolean(db.getJob?.(job.id));

  // A manually-pasted URL is a DELIBERATE human choice, so it is ALWAYS scored —
  // the bulk freshness filter (skip postings older than N days) must not silently
  // discard it without a score, which is what hid the fit for an older posting.
  // Any exclusion that WOULD have applied during bulk discovery (staleness, a
  // "no sponsorship" phrase, a role/location mismatch) is surfaced as a visible
  // caveat instead of a hard discard; the score + tier still decide the outcome.
  const exclusion = applyExclusions(job, config.exclusions, { now, candidate: config.candidate });
  const caveat = exclusion.excluded ? `Heads-up (${exclusion.category}): ${exclusion.reason}.` : null;
  if (caveat) {
    logger?.event?.(EVENT_TYPES.EXCLUSION_MATCHED, { jobId: job.id, message: `${exclusion.reason} (added manually, scored anyway)` });
  }

  const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
  // Exclusions are passed through because this path scores an excluded job
  // anyway: a hard clearance requirement then shows up as an eligibility
  // penalty and reason, not only as a caveat.
  const score = scoreJob(job, {
    scoring: config.scoring, sponsorship, candidate: config.candidate, now, exclusions: config.exclusions,
    freshnessModel: freshnessModelFor(config),
  });
  const { tier, explanation } = explainScore(score, config.scoring, { candidate: config.candidate });
  const fullExplanation = caveat ? `${caveat} ${explanation}` : explanation;

  const patch = {
    id: job.id, source: job.source, company: job.company, title: job.title,
    location: job.location, url: job.url, jd_text: job.jdText, posted_at: job.postedAt,
    applicant_count: job.applicantCount, employment_type: job.employmentType,
    ...(job.rawMetadata?.compensation
      ? { compensation_text: String(job.rawMetadata.compensation).trim() }
      : {}),
    employment_category: classifyEmployment(job, config.exclusions?.employmentTypes).category,
    score: score.total, tier, sponsorship: sponsorship.status,
    sponsorship_signals: sponsorship.signals ?? [],
    scoring_fingerprint: scoringFingerprint(config),
    matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
    explanation: fullExplanation, status: tier === 'Discard' ? 'discarded' : 'scored',
    discard_reason: tier === 'Discard' && caveat ? exclusion.reason : null,
  };
  // Downgrade guard: re-pasting the URL of a job that already has a packet /
  // decision / assist outcome refreshes its metadata but keeps its status.
  if (isProtectedJobRow(db.getJob?.(job.id))) {
    delete patch.status;
    delete patch.discard_reason;
  }
  db.upsertJob(patch);
  logger?.event?.(EVENT_TYPES.SCORE_EXPLAINED, {
    jobId: job.id, message: `${score.total}/100 -> ${tier} (manual URL)`,
    meta: { score: score.total, tier, sponsorship: sponsorship.status, url: job.url, caveat },
  });

  return {
    id: job.id, company: job.company, title: job.title, url: job.url,
    score: score.total, tier, sponsorship: sponsorship.status,
    appStatusHint: tier === 'Discard' ? 'discarded' : 'scored',
    caveat, alreadyExisted: existed,
  };
}

/**
 * PREPARE SELECTED — build packets for SPECIFIC jobs the human chose on the
 * dashboard, using their already-stored score/keywords. Unlike the pipeline,
 * this does not re-discover or re-score; it prepares exactly what was asked,
 * even below the auto-prepare tiers (the human's choice overrides the tiers —
 * but never the safety gates: packets still enter the approval queue).
 *
 * @param {object} args { config, db, logger, jobIds, deps }
 * @returns {Promise<{ prepared: Array<{jobId, packetPath}>, failed: Array<{jobId, error}>,
 *   cancelled: Array<{jobId, reason}> }>}
 */
export async function preparePacketsForJobs({ config, db, logger, jobIds = [], deps = {} } = {}) {
  const prepared = [];
  const failed = [];
  // Kept apart from `failed`: a job the person stopped before it started did
  // not break, and the run details must not paint it red (BUG-07).
  const cancelled = [];
  const counters = { jobs_prepared: 0 };

  for (const jobId of jobIds) {
    // Cooperative cancel (dashboard Cancel button): stop between jobs.
    if (deps.shouldCancel?.()) {
      cancelled.push({ jobId, reason: 'cancelled before this job started' });
      continue;
    }
    const row = db.getJob(jobId);
    if (!row) { failed.push({ jobId, error: 'unknown job id' }); continue; }
    if (Number(row.applied) === 1) {
      failed.push({ jobId, error: 'already submitted — not re-preparing' });
      continue;
    }
    // An unconfirmed submission is still a possible submission. Re-preparing
    // reset it to "prepared", which erased the marker the duplicate guard reads.
    if (row.status === 'submit_unverified') {
      failed.push({ jobId, error: 'reported submitted but not confirmed — confirm or deny it before preparing again' });
      continue;
    }
    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title,
      location: row.location, url: row.url, jdText: row.jd_text ?? '',
      postedAt: row.posted_at, applicantCount: row.applicant_count,
      employmentType: row.employment_type,
    };
    const score = {
      total: typeof row.score === 'number' ? row.score : 0,
      matchedKeywords: jsonList(row.matched_keywords),
      missingKeywords: jsonList(row.missing_keywords),
    };
    try {
      const packetPath = await preparePacket({
        config, db, logger, job, score, tier: row.tier ?? 'Queue', deps, counters,
      });
      prepared.push({ jobId, packetPath });
    } catch (err) {
      failed.push({ jobId, error: err.message });
      logger?.error?.(`prepare-selected failed: ${err.message}`, {}, jobId);
    }
  }
  return { prepared, failed, cancelled, counters };
}

/**
 * Load the packet JSON referenced by an approval row.
 * @returns {object|null}
 */
export function loadPacket(approvalRow, deps = {}) {
  const readImpl = deps.readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  if (!approvalRow?.packet_path) return null;
  try {
    return JSON.parse(readImpl(approvalRow.packet_path));
  } catch {
    return null;
  }
}

/**
 * ASSIST — open the browser for queued packets and fill them, advancing through
 * safe multi-step navigation (Next/Continue/Review) and stopping before the
 * final submit. Submission is never attempted — a human reviews and submits.
 *
 * @param {object} args
 * @param {string} [args.mode] resolved run mode; defaults to LIVE_ASSIST
 * @returns {Promise<{ results: object[], counters: object }>}
 */
export async function runAssist({ config, db, logger, mode, options = {}, deps = {} } = {}) {
  const assistFn = deps.assistFn ?? assistApply;
  const effectiveMode = mode ?? 'LIVE_ASSIST';
  // The CLI never submits. Enforce it here rather than trusting every caller:
  // the only final-submit path is the dashboard's explicitly confirmed
  // POST /api/auto-submit-batch, which does not come through this function.
  const assistOptions = { ...options, autoSubmit: false };

  // Only act on packets a human has approved. Pending/rejected are skipped.
  const approvals = db.listApprovals({ status: APPROVAL_STATUS.APPROVED });
  const results = [];
  const counters = { ...emptyCounters(), jobs_skipped_already_applied: 0, jobs_skipped_not_owned: 0 };
  let dailyCount = db.countAppliedOnLocalDay?.(deps.now ?? new Date(), config?.candidate?.location?.timezone ?? null) ?? db.countAppliedOn?.(isoDate(deps.now)) ?? 0;

  for (const approval of approvals) {
    // Idempotency guard: never re-assist a job that was already submitted — or
    // whose submission is unverified (re-filling could double-apply). Re-running
    // assist must NOT reopen a completed application.
    const jobRow = db.getJob?.(approval.job_id) ?? null;
    if (jobRow && (Number(jobRow.applied) === 1
        || jobRow.status === LIFECYCLE.SUBMITTED
        || jobRow.status === LIFECYCLE.SUBMIT_UNVERIFIED)) {
      counters.jobs_skipped_already_applied += 1;
      logger?.event?.(EVENT_TYPES.DUPLICATE_SKIPPED, {
        jobId: approval.job_id,
        message: 'already applied — skipping to avoid reopening a completed application',
        meta: { status: jobRow.status ?? null, applied_at: jobRow.applied_at ?? null },
      });
      continue;
    }

    const packet = loadPacket(approval, deps);
    if (!packet) {
      logger?.error?.(`could not load packet for approval ${approval.id}`, {}, approval.job_id);
      continue;
    }

    // Approved is not the same as "approved FOR THIS CANDIDATE". An approval
    // survives a profile switch, so without this the CLI filled the previous
    // person's packet onto the new person's application. The runner refuses
    // too; skipping here keeps a foreign packet from even opening a browser.
    const owned = packetOwnershipCheck(packet, config ?? {});
    if (!owned.ok) {
      counters.jobs_skipped_not_owned += 1;
      logger?.warn?.({ jobId: approval.job_id },
        `skipping: this packet is not the active candidate's — ${owned.reason}; prepare it again`);
      continue;
    }

    const result = await assistFn({
      packet, config, mode: effectiveMode, approval, dailyCount, options: assistOptions,
      // A confirmation page seen after hand-off is recorded as a human
      // submission awaiting the user's confirmation (never applied=1).
      deps: { onHumanSubmitted: (update) => recordAssistResult(db, approval.job_id, update), ...deps },
    });
    results.push(result);
    counters.jobs_assisted += 1;
    // The daily cap is enforced by the runner against THIS number, so a batch
    // that auto-submits must count its own submissions or it can exceed the
    // cap by the size of the batch.
    if (result?.submitted === true) dailyCount += 1;
    recordAssistResult(db, approval.job_id, result);
    logger?.event?.(EVENT_TYPES.PREFILL_STARTED, {
      jobId: approval.job_id,
      message: `assist ${result.status}`,
      meta: { status: result.status, blockers: result.blockers?.length ?? 0 },
    });
  }

  return { results, counters };
}

/**
 * END_TO_END — prepare packets, then assist. Always stops before submit; assist
 * only acts on packets a human has already approved.
 */
export async function runEndToEnd({ config, db, logger, options = {}, deps = {} } = {}) {
  const prepared = await runPrepareApps({ config, db, logger, deps });
  const assisted = await runAssist({ config, db, logger, options, deps });
  return { prepared: prepared.counters, assisted: assisted.counters, results: assisted.results };
}

/* --------------------------- approval-queue CLI --------------------------- */

/** List packets awaiting review (or all, with `all: true`). */
export function listApprovalQueue(db, { all = false } = {}) {
  return all ? db.listApprovals() : listPending(db);
}

/** Approve a packet by approval id. */
export function approvePacket(db, approvalId) {
  return approve(db, approvalId);
}

/** Reject a packet by approval id. */
export function rejectPacket(db, approvalId) {
  return reject(db, approvalId);
}

/** List prepared packets (joined view from the approval queue). */
export function listPackets(db, deps = {}) {
  return db.listApprovals().map((a) => {
    const packet = loadPacket(a, deps);
    return {
      approvalId: a.id,
      jobId: a.job_id,
      status: a.approval_status,
      approvedByUser: Boolean(a.approved_by_user),
      packetPath: a.packet_path,
      company: packet?.job?.company ?? null,
      title: packet?.job?.title ?? null,
      score: packet?.score ?? null,
      tier: packet?.tier ?? null,
      blockers: packet?.blockers ?? [],
    };
  });
}

/** Load a single packet by job id or packet/approval id. */
export function getPacket(db, idOrJobId, deps = {}) {
  const approvals = db.listApprovals();
  const match = approvals.find(
    (a) => a.job_id === idOrJobId || a.id === idOrJobId || a.packet_path?.includes(idOrJobId),
  );
  if (!match) return null;
  return { approval: match, packet: loadPacket(match, deps) };
}

/* ------------------------------- helpers --------------------------------- */

function isoDate(now) {
  // deps.now may be a Date OR a clock function (dashboard/tests inject both).
  const d = typeof now === 'function' ? now() : now ?? new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Persist the outcome of one assisted-fill run: lifecycle status, how many
 * fields were actually filled, and the blockers that need the human. This is
 * what makes "Fields Filled" / "Blockers" in the tracker and dashboard real
 * data instead of guesses. Exported so the dashboard server records assists
 * identically to the CLI.
 */
export function recordAssistResult(db, jobId, result) {
  if (!jobId) return;
  try {
    // A confirmed submission is terminal. The hand-off watcher (or a stale
    // extension tab) can report AFTER the user pressed "Mark submitted";
    // writing its submit_unverified over applied=1 would un-submit the job.
    const existing = db.getJob?.(jobId);
    // Never CREATE a job row from a run result. A store that does not hold
    // this job (a late report after a profile switch, a stale extension tab)
    // is the wrong store, and an upsert planted a stub row in it.
    if (typeof db.getJob === 'function' && !existing) return;
    if (existing && (Number(existing.applied) === 1 || existing.status === 'submitted')) return;
    const patch = {
      id: jobId,
      status: result.status,
      assist_filled_count: Array.isArray(result.filled) ? result.filled.length : null,
      assist_blockers: Array.isArray(result.blockers) ? result.blockers : [],
    };
    // Auto-submit (explicit per-run opt-in) is the ONE automated path to
    // applied=1 — and the runner only sets result.submitted after VERIFYING
    // the submission (confirmation page / redirect with the form gone). An
    // unverified click arrives here as status `submit_unverified` and is
    // never recorded as applied — the human confirms it via Mark submitted.
    if (result.submitted === true && result.submitVerification?.verified === true) {
      const signals = result.submitVerification?.signals ?? [];
      patch.applied = 1;
      patch.applied_at = new Date().toISOString();
      patch.status = 'submitted';
      patch.submitted_confirmation = `auto-submitted — confirmed by ${signals.join(', ') || 'post-submit check'}`;
    } else if (result.humanSubmissionDetected) {
      // The HUMAN submitted in the window we handed over and the ATS showed
      // its confirmation page. That is evidence, not proof we can act on
      // alone: the job moves to submit_unverified with the evidence recorded,
      // and only the user's "Mark submitted" makes it applied.
      const seen = result.humanSubmissionDetected;
      patch.status = LIFECYCLE.SUBMIT_UNVERIFIED;
      patch.submitted_confirmation = 'you appear to have submitted it — confirmation page seen'
        + `${seen.url ? ` at ${seen.url}` : ''} (${(seen.signals ?? []).join(', ') || 'confirmation message'}); `
        + 'confirm with "Mark submitted"';
    } else if (result.submitted === true) {
      // Defensive truthfulness guard: a caller may accidentally claim
      // `submitted` without the runner's positive verification result. Never
      // turn that inconsistent payload into applied=1; require the human to
      // verify it before the job can move to Submitted.
      patch.applied = 0;
      patch.status = LIFECYCLE.SUBMIT_UNVERIFIED;
    }
    // Through the state machine, so the move is validated and leaves a
    // status_changed event (retractSubmissionReport reads those to know where
    // an unverified submission came from). Test doubles without it upsert.
    if (typeof db.setJobStatus === 'function') {
      const { id: _id, status, ...fields } = patch;
      const reason = String(result.note ?? result.blockers?.[0] ?? '').slice(0, 200);
      db.setJobStatus(jobId, status, { actor: 'assist', reason, patch: fields });
    } else {
      db.upsertJob(patch);
    }
    // Persist the run's phase trail (Queued -> Precheck -> ... -> terminal) as
    // an audit event, so "where exactly did the last fill get to?" is
    // answerable from the job's history — and a resumed run appends a fresh
    // trail rather than overwriting the old one.
    if (Array.isArray(result.phases) && result.phases.length && typeof db.insertEvent === 'function') {
      try {
        db.insertEvent({
          id: randomUUID(),
          job_id: jobId,
          event_type: 'assist_phases',
          message: result.phases.map((ph) => ph.phase).join(' -> '),
          metadata: { phases: result.phases, status: patch.status },
        });
      } catch {
        // Audit insertion is best-effort. The authoritative job state above
        // already committed and must not be misreported as a failed update.
      }
    }
  } catch (err) {
    // A result that cannot be stored must be loud. Swallowing it left the job
    // showing its old status (often "ready to auto-fill") after a run that
    // filled, blocked or submitted it, with nothing on screen to say so.
    const what = result.submitted === true ? 'submitted application' : `auto-fill result (${result.status})`;
    throw new Error(`failed to record ${what} for ${jobId}: ${err.message}`, { cause: err });
  }
}
