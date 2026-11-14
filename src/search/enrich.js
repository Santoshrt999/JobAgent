/**
 * Description enrichment: fetch the full description for stored postings that
 * discovery only ever saw as a list-page summary, then judge them for real.
 *
 * Why it exists. Workday and SmartRecruiters list endpoints return no
 * description, and per-tenant detail budgets read only a fraction of what a
 * large tenant lists. A posting with no description cannot reach the discard
 * floor (~44 reachable of 100), so these rows sit as `needs_description` —
 * honest, but useless until someone reads them. This was a manual script
 * (scripts/enrichDescriptions.mjs, still a thin wrapper over this module) that
 * nothing scheduled.
 *
 * Guarantees:
 *   - Only ACTIVE rows (`needs_description` / `scored`) with a teaser-length
 *     description, a fetchable source, a title the profile does not reject,
 *     and a posting date inside retention. Discards are not re-fetched.
 *   - Rows the user acted on (shortlisted, packet, applied) are never touched.
 *   - Polite: a per-host concurrency ceiling and spacing (hostGate), bounded
 *     retries for 429/5xx only, a per-pass cap and a per-source budget.
 *   - Resumable: every row is written the moment it is judged, and every
 *     failed attempt is recorded (schema v4), so an interrupted pass loses at
 *     most the requests in flight, and a failing row backs off instead of
 *     being retried every pass. A 404/410 gives up at once — the posting is gone.
 *   - Same judging chain as discovery (exclusions → sponsorship → score →
 *     tier) with the shared freshness model and the scoring fingerprint.
 */

import { classifyTitleFit, buildProfileVocabulary } from '../scoring/profileFit.js';
import { scoreJob, freshnessModelFor } from '../scoring/scorer.js';
import { explainScore, TIERS } from '../scoring/explainScore.js';
import { classifySponsorship } from '../scoring/sponsorshipClassifier.js';
import { applyExclusions } from '../scoring/exclusionFilter.js';
import { scoringFingerprint } from '../scoring/fingerprint.js';
import { isProtectedJobRow } from '../lifecycle.js';
import { fetchWithTimeout, discoveryHeaders, httpError } from '../utils/httpClient.js';
import { createHostGate } from '../utils/hostGate.js';
import { withRetry } from '../utils/retryHandler.js';
import { htmlToText, parseJsonLdJobs } from './normalize.js';
import { ENRICHMENT_DEFAULTS } from '../config/userSettings.js';
import { safeFetch } from '../utils/safeFetch.js';

const TIMEOUT_MS = 20_000;
/** Below this, a stored jd_text is a teaser rather than a real description. */
export const TEASER_MAX_CHARS = 400;
/** HTTP statuses that mean the posting no longer exists: stop trying. */
const GONE_STATUSES = new Set([404, 410]);

/**
 * The public CXS detail endpoint for a stored Workday posting URL, or null.
 *
 * Two URL families exist and the tenant lives in a different place in each:
 *
 *   https://acme.wd5.myworkdayjobs.com/[en-US/]<site>/job/...
 *       tenant = first host label ("acme")
 *   https://wd5.myworkdaysite.com/[en-US/]recruiting/<tenant>/<site>/job/...
 *       tenant = the segment after "recruiting"; the host label is just the pod
 *
 * @param {string} url stored posting URL
 * @returns {string|null}
 */
export function workdayDetailApi(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean);
  const jobIdx = segs.indexOf('job');
  if (jobIdx < 1) return null;
  const site = segs[jobIdx - 1];
  let tenant;
  const recruiting = segs.indexOf('recruiting');
  if (/\.myworkdaysite\.com$/i.test(u.hostname) || (recruiting !== -1 && recruiting < jobIdx - 1)) {
    if (recruiting === -1 || recruiting + 3 !== jobIdx) return null;
    tenant = segs[recruiting + 1];
  } else {
    tenant = u.hostname.split('.')[0];
  }
  if (!tenant || !site) return null;
  const path = `/${segs.slice(jobIdx).join('/')}`;
  return `https://${u.hostname}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}${path}`;
}

/**
 * A row to leave alone because its source stopped listing it.
 * @param {object} row jobs-table row
 * @returns {boolean}
 */
export function isExpiredRow(row = {}) {
  return row.status === 'expired' || /^expired\b/i.test(String(row.discard_reason ?? ''));
}

async function getJson(url, ctx, label) {
  const res = await ctx.gate.run(url, () => fetchWithTimeout(
    ctx.fetchImpl, url, { headers: discoveryHeaders({ Accept: 'application/json' }) }, TIMEOUT_MS,
  ));
  if (!res.ok) throw httpError(res, label, url);
  return res.json();
}

async function getText(url, ctx, label) {
  const res = await ctx.gate.run(url, () => fetchWithTimeout(
    ctx.fetchImpl, url, { headers: discoveryHeaders({ Accept: 'text/html' }) }, TIMEOUT_MS,
  ));
  if (!res.ok) throw httpError(res, label, url);
  return res.text();
}

/**
 * How to fetch one posting's description, per source. Each reuses the public
 * endpoint its adapter already reads — no new surface, no login, no evasion.
 * A source with no strategy here is reported as "cannot be fetched", not guessed at.
 */
export const FETCHERS = Object.freeze({
  /** Workday CXS per-job detail, derived from the stored public URL. */
  async workday(row, ctx) {
    const api = workdayDetailApi(row.url);
    if (!api) return null;
    const data = await getJson(api, ctx, 'Workday detail');
    const info = data?.jobPostingInfo ?? {};
    const text = htmlToText(info.jobDescription ?? info.jobDescriptionText ?? '');
    // The LIST endpoint collapses a multi-location req to "2 Locations", so the
    // real places and the authoritative country only exist here.
    const places = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])]
      .map((x) => String(x ?? '').replace(/,\s*$/, '').trim()).filter(Boolean);
    const country = typeof (info.country?.descriptor ?? info.country) === 'string'
      ? String(info.country.descriptor ?? info.country).trim() : null;
    return text
      ? { text, postedAt: info.startDate ?? null, location: places.join('; ') || null, country }
      : null;
  },

  /** Oracle Recruiting detail endpoint. */
  async oracleRecruiting(row, ctx) {
    const u = new URL(row.url);
    const segs = u.pathname.split('/').filter(Boolean);
    const site = segs[segs.indexOf('sites') + 1];
    const id = segs[segs.indexOf('job') + 1];
    if (!site || !id) return null;
    const api = `https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
      + `?expand=all&onlyData=true&finder=ById;Id="${encodeURIComponent(id)}",siteNumber=${site}`;
    const detail = (await getJson(api, ctx, 'Oracle detail'))?.items?.[0];
    if (!detail) return null;
    const text = [
      detail.ExternalDescriptionStr, detail.ExternalResponsibilitiesStr,
      detail.ExternalQualificationsStr, detail.CorporateDescriptionStr,
    ].map((p) => htmlToText(String(p ?? '')).trim()).filter(Boolean).join('\n\n');
    return text ? { text, postedAt: detail.ExternalPostedStartDate ?? null } : null;
  },

  /** iCIMS renders the real document behind in_iframe=1. */
  async icims(row, ctx) {
    const u = new URL(row.url);
    u.searchParams.set('in_iframe', '1');
    const html = await getText(u.href, ctx, 'iCIMS detail');
    const [job] = parseJsonLdJobs(html, { url: row.url, source: 'icims' });
    if (job?.jdText) return { text: job.jdText, postedAt: job.postedAt ?? null };
    const text = htmlToText(html).slice(0, 12000);
    return text ? { text, postedAt: null } : null;
  },

  /** SmartRecruiters publishes a per-posting JSON document. */
  async smartrecruiters(row, ctx) {
    const m = /jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/.exec(row.url);
    if (!m) return null;
    const data = await getJson(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`, ctx, 'SmartRecruiters detail');
    const s = data?.jobAd?.sections ?? {};
    const text = [
      s.companyDescription?.text, s.jobDescription?.text,
      s.qualifications?.text, s.additionalInformation?.text,
    ].map((p) => htmlToText(String(p ?? '')).trim()).filter(Boolean).join('\n\n');
    return text ? { text, postedAt: data?.releasedDate ?? null } : null;
  },
});

/** Sources enrichment knows how to read. */
export const FETCHABLE_SOURCES = Object.freeze(Object.keys(FETCHERS));

/**
 * The database patch for one enriched row, judged by the same chain discovery
 * uses — including the shared freshness model and the scoring fingerprint, so
 * an enriched verdict is current and is not immediately re-judged by
 * rescoreStale. Returns `patch: null` for a row the human has acted on
 * (shortlisted, packet built, applied): enrichment must never flip a row the
 * user owns to `discarded`.
 *
 * @param {object} row stored jobs row
 * @param {{text: string, location?: string, postedAt?: string, country?: string}} got fetched description
 * @param {{config: object, vocab: object, now: Date, fingerprint?: string}} ctx
 * @returns {{patch: object|null, score: object, tier: string, exclusion: object}}
 */
export function judgeEnriched(row, got, { config, vocab, now, fingerprint }) {
  const job = {
    id: row.id, source: row.source, company: row.company, title: row.title,
    location: got.location ?? row.location, url: row.url, jdText: got.text,
    postedAt: got.postedAt ?? row.posted_at, employmentType: row.employment_type,
    // An explicit country from the provider is decisive for the US-only gate.
    rawMetadata: got.country ? { country: got.country } : {},
  };
  const exclusion = applyExclusions(job, config.exclusions, { now, candidate: config.candidate });
  const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
  const score = scoreJob(job, {
    scoring: config.scoring, sponsorship, candidate: config.candidate, now,
    freshnessModel: freshnessModelFor(config),
  });
  const titleVerdict = classifyTitleFit(job.title, vocab).verdict;
  const { tier, explanation } = explainScore(score, config.scoring, { titleVerdict, candidate: config.candidate });
  if (isProtectedJobRow(row)) return { patch: null, score, tier, exclusion };
  const patch = {
    id: row.id,
    jd_text: got.text,
    posted_at: job.postedAt,
    location: job.location,
    summary_only: 0,
    score: score.total,
    tier: exclusion.excluded ? null : tier,
    sponsorship: sponsorship.status,
    sponsorship_signals: sponsorship.signals ?? [],
    explanation,
    matched_keywords: score.matchedKeywords,
    missing_keywords: score.missingKeywords,
    scoring_fingerprint: fingerprint ?? scoringFingerprint(config),
    status: exclusion.excluded
      ? 'discarded'
      : (tier === TIERS.DISCARD ? 'discarded' : 'scored'),
    discard_reason: exclusion.excluded
      ? exclusion.reason
      : (tier === TIERS.DISCARD ? 'below score threshold (description now read)' : null),
  };
  return { patch, score, tier, exclusion };
}

/** Effective enrichment settings: defaults < config.runtime.enrichment < overrides. */
export function enrichmentSettings(config = {}, overrides = {}) {
  return { ...ENRICHMENT_DEFAULTS, ...(config?.runtime?.enrichment ?? {}), ...overrides };
}

/** ISO cutoffs the selection query needs. */
function cutoffs(config, settings, now) {
  const retention = Number(config?.exclusions?.staleness?.skipOlderThanDays) || 45;
  return {
    // A posting past retention is about to be retired; reading it is waste.
    postedAfter: new Date(now.getTime() - retention * 864e5).toISOString(),
    retryBefore: new Date(now.getTime() - settings.retryAfterHours * 3600e3).toISOString(),
  };
}

const ACTIVE_UNREAD_WHERE = `status IN ('needs_description', 'scored')
    AND coalesce(url, '') <> ''
    AND coalesce(length(jd_text), 0) < ${TEASER_MAX_CHARS}
    AND coalesce(applied, 0) = 0 AND coalesce(application_packet_path, '') = ''
    AND coalesce(user_decision, '') = ''`;

/**
 * The rows the next pass would read, in priority order, with the per-source
 * budget and the pass cap applied.
 *
 * Priority: `needs_description` before `scored`, titles the profile ACCEPTS
 * before ones it merely does not reject, newest posting first. Rejected
 * titles are never fetched.
 *
 * @param {object} db openDatabase() handle
 * @param {object} config loadConfig() bundle
 * @param {object} [options]
 * @returns {object[]} jobs rows
 */
export function selectEnrichmentCandidates(db, config, {
  now = new Date(), settings = enrichmentSettings(config), source = null, vocab = null,
} = {}) {
  const raw = db?.db;
  if (!raw?.prepare) return [];
  const { postedAfter, retryBefore } = cutoffs(config, settings, now);
  const sources = source ? FETCHABLE_SOURCES.filter((s) => s === source) : FETCHABLE_SOURCES;
  if (!sources.length) return [];
  const rows = raw.prepare(`SELECT id, source, company, title, location, url, posted_at, employment_type,
      status, score, discard_reason, applied, application_packet_path, user_decision,
      enrich_attempts, enrich_attempted_at
    FROM jobs
    WHERE ${ACTIVE_UNREAD_WHERE}
      AND source IN (${sources.map(() => '?').join(', ')})
      AND (posted_at IS NULL OR posted_at = '' OR posted_at >= ?)
      AND coalesce(enrich_attempts, 0) < ?
      AND (enrich_attempted_at IS NULL OR enrich_attempted_at < ?)
    ORDER BY CASE status WHEN 'needs_description' THEN 0 ELSE 1 END, coalesce(posted_at, '') DESC, id`)
    .all(...sources, postedAfter, settings.maxAttempts, retryBefore);
  const v = vocab ?? (config.candidate ? buildProfileVocabulary(config.candidate) : null);
  const ranked = [];
  for (const row of rows) {
    if (isProtectedJobRow(row) || isExpiredRow(row)) continue;
    const verdict = v ? classifyTitleFit(row.title, v).verdict : 'accept';
    if (verdict === 'reject') continue;
    ranked.push({ row, accept: verdict === 'accept' ? 0 : 1 });
  }
  // Stable: keeps the SQL order within each title class.
  ranked.sort((a, b) => a.accept - b.accept);
  const perSource = new Map();
  const out = [];
  for (const { row } of ranked) {
    if (out.length >= settings.maxPerPass) break;
    const used = perSource.get(row.source) ?? 0;
    if (used >= settings.perSourceBudget) continue;
    perSource.set(row.source, used + 1);
    out.push(row);
  }
  return out;
}

/**
 * What is waiting to be read, for the dashboard. Counts only — cheap enough to
 * compute on demand (active rows are a few thousand at most).
 *
 * @returns {{unread: number, fetchable: number, readyNow: number, coolingDown: number,
 *   gaveUp: number, unsupported: number, bySource: Record<string, number>}}
 */
export function enrichmentBacklog(db, config, { now = new Date(), settings = enrichmentSettings(config) } = {}) {
  const raw = db?.db;
  const empty = { unread: 0, fetchable: 0, readyNow: 0, coolingDown: 0, gaveUp: 0, unsupported: 0, bySource: {} };
  if (!raw?.prepare) return empty;
  const { retryBefore } = cutoffs(config, settings, now);
  const rows = raw.prepare(`SELECT source, coalesce(enrich_attempts, 0) AS attempts, enrich_attempted_at AS at, COUNT(*) AS n
    FROM jobs WHERE ${ACTIVE_UNREAD_WHERE} AND status = 'needs_description'
    GROUP BY source, attempts, at IS NULL OR at < ?`).all(retryBefore);
  const out = { ...empty, bySource: {} };
  for (const r of rows) {
    out.unread += r.n;
    out.bySource[r.source] = (out.bySource[r.source] ?? 0) + r.n;
    if (!FETCHABLE_SOURCES.includes(r.source)) { out.unsupported += r.n; continue; }
    out.fetchable += r.n;
    if (r.attempts >= settings.maxAttempts) out.gaveUp += r.n;
    else if (r.at && r.at >= retryBefore) out.coolingDown += r.n;
  }
  out.readyNow = selectEnrichmentCandidates(db, config, { now, settings }).length;
  return out;
}

/** Record a failed or empty attempt; a gone posting is not retried. */
function recordFailure(db, row, { now, error, gone, settings }) {
  db.upsertJob({
    id: row.id,
    enrich_attempts: gone ? settings.maxAttempts : (Number(row.enrich_attempts) || 0) + 1,
    enrich_attempted_at: now.toISOString(),
    enrich_error: String(error ?? 'no description returned').slice(0, 240),
  });
}

/**
 * Run one enrichment pass.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.config loadConfig() bundle
 * @param {Date} [args.now]
 * @param {object} [args.overrides] settings overrides (maxPerPass, source budget …)
 * @param {string|null} [args.source] only this source
 * @param {boolean} [args.apply=true] false = dry run: fetch and judge, write nothing
 * @param {() => boolean} [args.shouldCancel] checked before every row
 * @param {(p: object) => void} [args.onProgress]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {object} [args.gate] hostGate (tests)
 * @returns {Promise<object>} stats
 */
export async function runEnrichment({
  db, config, now = new Date(), overrides = {}, source = null, apply = true,
  shouldCancel = () => false, onProgress = () => {}, fetchImpl = safeFetch, gate = null,
  sleepFn,
} = {}) {
  const settings = enrichmentSettings(config, overrides);
  const vocab = config.candidate ? buildProfileVocabulary(config.candidate) : null;
  const fingerprint = scoringFingerprint(config);
  const batch = selectEnrichmentCandidates(db, config, { now, settings, source, vocab });
  const stats = {
    total: batch.length, done: 0, fetched: 0, failed: 0, gone: 0, improved: 0,
    nowActionable: 0, stillWeak: 0, excluded: 0, cancelled: false, bySource: {}, recovered: [],
  };
  const ctx = {
    fetchImpl,
    gate: gate ?? createHostGate({ maxConcurrent: settings.hostConcurrency, minSpacingMs: settings.minSpacingMs }),
  };
  const report = () => onProgress({ ...stats, recovered: stats.recovered.slice(0, 10) });
  report();

  // Sequential per pass with the gate's per-host ceiling providing the
  // politeness; parallelism comes from different hosts.
  const queue = [...batch];
  const worker = async () => {
    while (queue.length) {
      if (shouldCancel()) { stats.cancelled = true; return; }
      const row = queue.shift();
      const src = (stats.bySource[row.source] ??= { fetched: 0, failed: 0 });
      let got = null;
      let error = null;
      try {
        got = await withRetry(() => FETCHERS[row.source](row, ctx), {
          maxRetries: settings.maxRetries, ...(sleepFn ? { sleepFn } : {}),
        });
      } catch (err) {
        error = err;
      }
      stats.done += 1;
      if (!got?.text) {
        const gone = GONE_STATUSES.has(Number(error?.status));
        stats.failed += 1;
        src.failed += 1;
        if (gone) stats.gone += 1;
        if (apply) recordFailure(db, row, { now, error: error?.message ?? null, gone, settings });
        report();
        continue;
      }
      stats.fetched += 1;
      src.fetched += 1;
      const { patch, score, tier, exclusion } = judgeEnriched(row, got, { config, vocab, now, fingerprint });
      if (score.total > Number(row.score ?? 0)) stats.improved += 1;
      if (exclusion.excluded) stats.excluded += 1;
      else if (tier !== TIERS.DISCARD) {
        stats.nowActionable += 1;
        stats.recovered.push({ id: row.id, company: row.company, title: row.title, score: score.total, tier });
      } else stats.stillWeak += 1;
      if (apply && patch) {
        db.upsertJob({
          ...patch,
          enrich_attempts: (Number(row.enrich_attempts) || 0) + 1,
          enrich_attempted_at: now.toISOString(),
          enrich_error: null,
        });
      }
      report();
    }
  };
  const workers = Math.max(1, Math.min(settings.hostConcurrency * 2, 8));
  await Promise.all(Array.from({ length: Math.min(workers, batch.length || 1) }, worker));
  stats.recovered.sort((a, b) => b.score - a.score);
  return stats;
}
