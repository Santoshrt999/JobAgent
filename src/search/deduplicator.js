/**
 * Deduplicate normalized jobs.
 *
 * A job is a duplicate when its dedup key matches one already seen. The
 * primary key is normalized company + normalized title (except for distinct
 * requisitions, see isDistinctRequisition) — deliberately NOT
 * the source job id or location — so the same role posted across many cities
 * (e.g. a Deloitte listing repeated for 24 metros, each with its own gh_jid)
 * collapses to a single entry instead of flooding the queue. When two records
 * share a key, the one with the richer job description text is kept.
 *
 * A SECONDARY key is the normalized application URL: two records pointing at
 * the same posting are the same job even when their parsed company/title
 * differ (an aggregator that dropped the company name, a retitled cross-post).
 *
 * Optionally accepts an `exists(id|key)` predicate to also drop jobs already
 * present in the database from previous runs.
 */

import { normalizeLoose } from '../utils/textNormalize.js';
import { passesUsOnlyGate } from '../scoring/exclusionFilter.js';

/**
 * @param {object[]} jobs normalized jobs
 * @param {object} [options]
 * @param {(job: object, key: string) => boolean} [options.existsInDb]
 *   return true to treat a job as a known duplicate from a prior run
 * @returns {{ unique: object[], duplicates: object[], seenKeys: string[] }}
 */
export function deduplicate(jobs = [], { existsInDb, geography = null, splitRequisitions = true } = {}) {
  // The same US-only test the exclusion stage applies, so the copy kept here is
  // the one that will survive there. No geography config: every copy passes.
  const passesGeo = (job) => passesUsOnlyGate(job, geography);
  /** @type {Map<string, object>} */
  const byKey = new Map();
  /** @type {Set<string>} normalized URLs already owned by a kept record */
  const seenUrls = new Set();
  /** @type {Map<string, string[]>} company::title -> extra keys of distinct requisitions */
  const variantsOf = new Map();
  const duplicates = [];

  for (const job of jobs) {
    const key = keyFor(job);
    const urlKey = urlKeyFor(job);

    if (typeof existsInDb === 'function' && existsInDb(job, key)) {
      duplicates.push({ job, reason: 'exists_in_db', key });
      continue;
    }

    // DISTINCT REQUISITIONS (P1-4). company::title collapses one role posted
    // in many cities, which is right. But an employer can also have two real
    // openings with the same title (different teams, levels, products), and
    // merging those made one of them vanish. They stay apart only on clear
    // evidence: same source, different requisition ids, and full descriptions
    // that genuinely differ. Without descriptions they merge, as before.
    let variantKey = key;
    if (splitRequisitions && byKey.has(key)) {
      const variants = [key, ...(variantsOf.get(key) ?? [])];
      const same = variants.find((k) => !isDistinctRequisition(byKey.get(k), job));
      if (same) {
        variantKey = same;
      } else {
        variantKey = `${key}::req:${job.sourceJobId}`;
        if (!variantsOf.has(key)) variantsOf.set(key, []);
        variantsOf.get(key).push(variantKey);
      }
    }

    const prior = byKey.get(variantKey);
    if (!prior) {
      // New company::title — but the same posting URL may already be kept
      // under a differently-parsed company/title. Same URL = same job.
      if (urlKey && seenUrls.has(urlKey)) {
        duplicates.push({ job, reason: 'duplicate_url', key: urlKey });
        continue;
      }
      byKey.set(variantKey, job);
      if (urlKey) seenUrls.add(urlKey);
      continue;
    }
    // WHICH COPY SURVIVES.
    //
    // Longer JD used to win outright, so "Acme — Data Engineer (Remote, US)"
    // lost to the richer "Acme — Data Engineer (Bangalore)" copy, which the
    // US-only gate then discarded — and the role vanished from the board
    // although a perfectly good US copy had been found. The copy that PASSES
    // the geography gate now wins; JD length only breaks a tie. The loser's
    // location is kept on the winner as `alsoAt`, so the other places the role
    // is offered remain visible.
    const jobOk = passesGeo(job);
    const priorOk = passesGeo(prior);
    const jobWins = jobOk !== priorOk
      ? jobOk
      : (job.jdText?.length ?? 0) > (prior.jdText?.length ?? 0);
    const [winner, loser] = jobWins ? [job, prior] : [prior, job];
    noteAlsoAt(winner, loser);
    if (jobWins) {
      byKey.set(variantKey, job);
      if (urlKey) seenUrls.add(urlKey);
    }
    duplicates.push({ job: loser, reason: 'duplicate_in_batch', key: variantKey });
  }

  return {
    unique: [...byKey.values()],
    duplicates,
    seenKeys: [...byKey.keys()],
  };
}

/** Descriptions at least this similar are the same role, whatever the ids say. */
export const SAME_ROLE_SIMILARITY = 0.85;
/** Shorter descriptions are too thin to compare (stubs, "see website"). */
const MIN_JD_CHARS = 400;

/** Word 5-gram shingles of the first 4,000 characters of a description. */
function shingles(text) {
  const words = normalizeLoose(String(text ?? '').slice(0, 4000)).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 5 <= words.length; i += 1) out.add(words.slice(i, i + 5).join(' '));
  return out;
}

/** Jaccard similarity of two descriptions' shingles, 0..1. */
export function jdSimilarity(a, b) {
  const x = shingles(a); const y = shingles(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const s of x) if (y.has(s)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Are these two same-company, same-title records separate openings? Only with
 * evidence on both sides: one source, two different requisition ids, and two
 * full descriptions that are not the same text.
 */
export function isDistinctRequisition(kept, job) {
  if (!kept || !job) return false;
  const idA = String(kept.sourceJobId ?? '').trim();
  const idB = String(job.sourceJobId ?? '').trim();
  if (!idA || !idB || idA === idB) return false;
  const sameSource = String(kept.source ?? '') === String(job.source ?? '');
  // Two requisitions that differ only by SHIFT (a day-shift and a night-shift
  // ICU nurse) share nearly every word, and are still two openings.
  const shiftA = shiftOf(kept.jdText);
  const shiftB = shiftOf(job.jdText);
  if (sameSource && shiftA && shiftB && shiftA !== shiftB) return true;
  // Ids from two different sources are not comparable (one posting carries
  // both), and an aggregator's copy is often a rewritten or cut-down version
  // of the employer's, so across sources the copies always merge.
  if (!sameSource) return false;
  if ((kept.jdText?.length ?? 0) < MIN_JD_CHARS || (job.jdText?.length ?? 0) < MIN_JD_CHARS) return false;
  return jdSimilarity(kept.jdText, job.jdText) < SAME_ROLE_SIMILARITY;
}

/** The shift a posting states ("Shift: Nights", "day shift"), or null. */
export function shiftOf(text) {
  const t = String(text ?? '').toLowerCase();
  const m = /\bshift\s*[:-]\s*(days?|nights?|evenings?|weekends?|overnights?|rotating)\b/.exec(t)
    ?? /\b(days?|nights?|evenings?|weekends?|overnights?|rotating)\s+shifts?\b/.exec(t);
  return m ? m[1].replace(/s$/, '') : null;
}

/** Title words that are spelled several ways for the same thing. */
const TITLE_ABBREVIATIONS = [
  [/\bsr\b/g, 'senior'], [/\bjr\b/g, 'junior'], [/\bmgr\b/g, 'manager'], [/\bassoc\b/g, 'associate'],
  [/\beng\b/g, 'engineer'], [/\bdev\b/g, 'developer'], [/\bmgmt\b/g, 'management'], [/\bvp\b/g, 'vice president'],
];

/** Legal-form words that are not part of a company's identity. */
const COMPANY_SUFFIX = /\s+(?:inc|incorporated|llc|l\s?l\s?c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|lp|llp|pllc)$/;

function normalizeTitleForKey(title) {
  let t = normalizeLoose(title);
  for (const [re, word] of TITLE_ABBREVIATIONS) t = t.replace(re, word);
  return t.replace(/\s+/g, ' ').trim();
}

function normalizeCompanyForKey(company) {
  let c = normalizeLoose(company);
  for (let i = 0; i < 2; i += 1) c = c.replace(COMPANY_SUFFIX, '');
  return c.trim();
}

/** Query params that are pure tracking noise — never part of a job's identity. */
const TRACKING_PARAM_RE = /^(utm_\w+|gclid|fbclid|msclkid|ref|referrer|referer|src|source|gh_src|lever-source|trk|trackingid|cid|mkt_tok)$/i;

/**
 * Normalize an application URL into a stable identity key: lowercase host
 * (www. stripped), no hash, no trailing slash, tracking params removed,
 * remaining params sorted. Identity params like Greenhouse's gh_jid survive.
 *
 * @param {object} job
 * @returns {string|null} normalized URL key, or null when the job has no URL
 */
export function urlKeyFor(job = {}) {
  const raw = String(job.url ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RE.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${host}${path}${params ? `?${params}` : ''}`;
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Compute the dedup key for a normalized job.
 *
 * Company + title only. The source job id and location are intentionally
 * excluded so the same role advertised in multiple locations (each a distinct
 * posting/id) is treated as one. Job ids remain unique elsewhere (see
 * makeJobId), so this does not cause database primary-key collisions.
 */
export function keyFor(job = {}) {
  // "Sr. Accountant" and "Senior Accountant" at "Acme Corp" and "Acme
  // Corporation" are one posting, not two.
  const company = normalizeCompanyForKey(job.company);
  const title = normalizeTitleForKey(job.title);
  if (company && title) return `${company}::${title}`;
  // With either half missing, company+title no longer identifies a role: two
  // unrelated employers' "Data Engineer" postings (aggregators often drop the
  // company) would collapse into one, and the other job would vanish. Fall back
  // to the posting's own identity instead.
  const urlKey = urlKeyFor(job);
  if (urlKey) return `url:${urlKey}`;
  if (job.id) return `id:${job.id}`;
  return [company, title].filter(Boolean).join('::');
}

/** Record the loser's location on the winner, once, without touching `location`. */
function noteAlsoAt(winner, loser) {
  const places = [loser.location, ...(loser.rawMetadata?.alsoAt ?? [])]
    .map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!places.length) return;
  winner.rawMetadata = winner.rawMetadata ?? {};
  const own = String(winner.location ?? '').trim();
  const merged = new Set(winner.rawMetadata.alsoAt ?? []);
  for (const p of places) if (p !== own) merged.add(p);
  if (merged.size) winner.rawMetadata.alsoAt = [...merged];
}
