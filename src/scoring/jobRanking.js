/**
 * Freshness-first job ranking.
 *
 * Deterministic comparator used to order queues, scored lists, and reports so
 * the human always sees the most actionable roles first. Sort priority:
 *
 *   1. tier                             (Priority > Apply > Queue > Near miss)
 *   2. posted within the last 24 hours  (freshest first, within the tier)
 *   3. sponsorship feasibility          (Confirmed/Approved > Likely > Unconfirmed;
 *                                        skipped for a candidate who needs none)
 *   4. score                            (higher first)
 *   5. source quality / direct ATS      (direct ATS boards before aggregators)
 *
 * Stable and side-effect free: ties fall through to the next key, and an equal
 * comparison returns 0 so callers can rely on a stable Array.prototype.sort.
 */

import { isWithinLast24Hours } from '../utils/dates.js';
import { DIRECT_ATS_SOURCES } from './scorer.js';

/** Higher rank = a stronger tier. Rows without a tier sort with the lowest. */
const TIER_RANK = Object.freeze({ Priority: 4, Apply: 3, Queue: 2, 'Near miss': 1 });

/** Higher rank = more feasible sponsorship outcome. */
const SPONSORSHIP_RANK = Object.freeze({
  Approved: 3,
  Confirmed: 3,
  Likely: 2,
  Unconfirmed: 1,
});

/** Read postedAt from either the normalized (camelCase) or db (snake_case) shape. */
function postedOf(job) {
  return job?.postedAt ?? job?.posted_at ?? null;
}

function sponsorshipRank(status) {
  return SPONSORSHIP_RANK[status] ?? 0;
}

/** Direct-ATS / first-party sources outrank aggregators on a tie (list shared with the scorer). */
function sourceQualityRank(source) {
  return DIRECT_ATS_SOURCES.has(source) ? 2 : 1;
}

/**
 * Apply-window bands, highest first: under 24 hours (first movers), 1-3 days
 * (prime), 4-7 days (open), 8-21 days, older. An undated posting sits with
 * 8-21 days: neither rewarded nor buried for a date nobody knows.
 * @returns {number} 4 freshest .. 0 aging
 */
export function freshnessBand(postedAt, now = new Date()) {
  if (isWithinLast24Hours(postedAt, now)) return 4;
  const t = postedAt ? new Date(postedAt).getTime() : NaN;
  if (!Number.isFinite(t)) return 1;
  const days = (new Date(now).getTime() - t) / 86_400_000;
  if (days < 0) return 4; // a clock-skewed future date is "just posted"
  if (days <= 3) return 3;
  if (days <= 7) return 2;
  if (days <= 21) return 1;
  return 0;
}

/**
 * Build a comparator that orders jobs freshest-first then by the remaining keys.
 * @param {Date|string|number} [now] reference clock (injectable for tests)
 * @returns {(a: object, b: object) => number}
 */
export function compareJobsForQueue(now = new Date(), { ignoreSponsorship = false } = {}) {
  return (a, b) => {
    // TIER FIRST. Freshness-first across tiers let a weak posting from the
    // last 24 hours outrank every strong one from yesterday (audit 2026-11-11:
    // NDCG@5 fell from 0.57-0.78 to 0.35-0.49 when two weak posts were made
    // fresh). Within a tier, fresh still leads: applying early is the point.
    const tierA = TIER_RANK[a?.tier] ?? 0;
    const tierB = TIER_RANK[b?.tier] ?? 0;
    if (tierA !== tierB) return tierB - tierA;

    // Freshness in BANDS, not one 24h cliff (audit Backlog #10): with only
    // "under a day / not", a two-day-old and a four-week-old posting with the
    // same score tied, and the score decided between them.
    const freshA = freshnessBand(postedOf(a), now);
    const freshB = freshnessBand(postedOf(b), now);
    if (freshA !== freshB) return freshB - freshA;

    // Only a question for a candidate who needs sponsoring.
    if (!ignoreSponsorship) {
      const sponA = sponsorshipRank(a?.sponsorship);
      const sponB = sponsorshipRank(b?.sponsorship);
      if (sponA !== sponB) return sponB - sponA;
    }

    const scoreA = typeof a?.score === 'number' ? a.score : -1;
    const scoreB = typeof b?.score === 'number' ? b.score : -1;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const srcA = sourceQualityRank(a?.source);
    const srcB = sourceQualityRank(b?.source);
    if (srcA !== srcB) return srcB - srcA;

    return 0;
  };
}

/**
 * Return a new array of jobs ordered freshest-first by {@link compareJobsForQueue}.
 * @param {object[]} jobs
 * @param {Date|string|number} [now]
 * @returns {object[]}
 */
export function sortJobsForQueue(jobs = [], now = new Date(), options = {}) {
  return [...jobs].sort(compareJobsForQueue(now, options));
}
