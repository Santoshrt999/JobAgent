/**
 * What this person's own job store already knows about an employer (audit
 * Backlog #3 and #7).
 *
 * SPONSORSHIP MEMORY. Most enterprise postings say nothing about visas, so the
 * verdict on each one alone is "Unconfirmed". But the store holds every
 * posting ever seen, and many of the same employer's other postings DID say:
 * "sponsorship is not available" (recorded as a sponsorship-denial discard) or
 * "we sponsor H-1B" (Confirmed / Likely). Counted per employer, that is
 * evidence the person can weigh. It is shown, never applied: it changes no
 * score, no tier and no gate.
 *
 * REPOSTS. The same title at the same employer appearing again and again over
 * months is an evergreen or reposted requisition — often a pipeline, not an
 * open seat. Counted per employer + title.
 *
 * Both are table-wide GROUP BYs (~0.4-1 s on a 168k-row store), so they are
 * built OFF the request path (setImmediate), cached per database, refreshed at
 * most every REFRESH_MS, and served stale while a refresh runs. Until the
 * first build finishes a detail simply has no history.
 */

export const REFRESH_MS = 10 * 60_000;
/** A title seen this many times or more, over at least this many days, is a repost. */
export const REPOST_MIN_COUNT = 3;
export const REPOST_MIN_SPAN_DAYS = 30;

const cache = new WeakMap(); // db -> { at, data, building }

const key = (s) => String(s ?? '').trim().toLowerCase();

/** Build the two maps from the store. Exported for tests. */
export function buildEmployerHistory(raw) {
  const companies = new Map();
  for (const r of raw.prepare(`SELECT lower(trim(company)) AS c, COUNT(*) AS n,
      SUM(CASE WHEN sponsorship IN ('Confirmed', 'Likely') THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN COALESCE(discard_reason, '') LIKE 'sponsorship_denial%' THEN 1 ELSE 0 END) AS no
      FROM jobs WHERE company IS NOT NULL AND trim(company) <> '' GROUP BY c`).all()) {
    companies.set(r.c, { postings: r.n, sponsorYes: r.yes, sponsorNo: r.no });
  }
  const reposts = new Map();
  for (const r of raw.prepare(`SELECT lower(trim(company)) AS c, lower(trim(title)) AS t, COUNT(*) AS n,
      MIN(COALESCE(posted_at, created_at)) AS first, MAX(COALESCE(posted_at, created_at)) AS last
      FROM jobs WHERE company IS NOT NULL AND title IS NOT NULL
      GROUP BY c, t HAVING COUNT(*) >= ${REPOST_MIN_COUNT}`).all()) {
    reposts.set(`${r.c}::${r.t}`, { count: r.n, first: r.first, last: r.last });
  }
  return { companies, reposts };
}

/** The cached history for a database, scheduling a (re)build when due. */
function historyFor(db, now, { sync = false } = {}) {
  const raw = db?.db;
  if (!raw?.prepare) return null;
  let entry = cache.get(db);
  if (!entry) { entry = { at: 0, data: null, building: false }; cache.set(db, entry); }
  const due = !entry.data || now - entry.at >= REFRESH_MS;
  if (due && sync) {
    entry.data = buildEmployerHistory(raw);
    entry.at = now;
  } else if (due && !entry.building) {
    entry.building = true;
    setImmediate(() => {
      try { entry.data = buildEmployerHistory(raw); entry.at = Date.now(); } catch { /* closed db: leave as is */ }
      entry.building = false;
    });
  }
  return entry.data;
}

/** How the employer's other postings answered the sponsorship question. */
export function sponsorshipVerdict({ sponsorYes = 0, sponsorNo = 0 } = {}) {
  if (sponsorNo >= 2 && sponsorYes === 0) return 'unlikely';
  if (sponsorYes >= 2 && sponsorNo === 0) return 'likely';
  if (sponsorYes > 0 && sponsorNo > 0) return 'mixed';
  return null;
}

/**
 * The employer history for one job, or null when there is nothing to say yet.
 *
 * @param {object} db openDatabase() handle
 * @param {{company?: string, title?: string}} job
 * @param {{now?: number, sync?: boolean}} [opts] `sync` builds inline (tests, CLI)
 * @returns {{employer: object|null, repost: object|null}|null}
 */
export function employerHistory(db, job, { now = Date.now(), sync = false } = {}) {
  const data = historyFor(db, now, { sync });
  if (!data) return null;
  const c = key(job?.company);
  const company = c ? data.companies.get(c) : null;
  const employer = company && company.postings > 1
    ? { ...company, verdict: sponsorshipVerdict(company) } : null;
  const r = c ? data.reposts.get(`${c}::${key(job?.title)}`) : null;
  let repost = null;
  if (r) {
    const span = (Date.parse(r.last) - Date.parse(r.first)) / 86_400_000;
    if (Number.isFinite(span) && span >= REPOST_MIN_SPAN_DAYS) {
      repost = { count: r.count, since: r.first, spanDays: Math.round(span) };
    }
  }
  return employer || repost ? { employer, repost } : null;
}
