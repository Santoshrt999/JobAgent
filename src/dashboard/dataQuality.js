/**
 * "Why is my board this size?" — the numbers behind discovery, in plain words.
 *
 * Measured on the store this was written against: 125,706 postings, 3,813
 * active, ~97% discarded — and nowhere in the dashboard said why. The reasons
 * were stored per row (`discard_reason`) but only as free text with day counts
 * baked in ("stale: posted 29 day(s) ago (> 3d window)"), so they could not be
 * summed. This groups them into the few categories a person can act on, and
 * reports the freshness settings and the description backlog alongside.
 *
 * Read-only. Uses the covering stats index (discovery_mode, status,
 * discard_reason) so it never reads job descriptions.
 */

import { FRESHNESS_WINDOW_DAYS } from '../utils/credentialManager.js';
import { enrichmentBacklog, enrichmentSettings, FETCHABLE_SOURCES } from '../search/enrich.js';
import { RETENTION_RANGE } from '../config/userSettings.js';
import { activeJobCount, cachedForData } from './data.js';

/**
 * Discard categories, keyed by the reason's prefix. `action` says what the
 * user can do about it, which is the point of showing it.
 */
const CATEGORIES = Object.freeze({
  outside_window: {
    label: 'Older than the discovery window when found',
    explain: 'New postings are added only if they were posted inside your discovery window.',
    action: 'Widen the discovery window to admit older postings on the next search.',
  },
  undated: {
    label: 'No posting date',
    explain: 'The source gave no usable date, so its age could not be checked.',
    action: null,
  },
  retired: {
    label: 'Retired: older than retention',
    explain: 'Jobs leave the board once they are older than your retention limit.',
    action: 'Raise retention to keep jobs longer.',
  },
  unlisted: {
    label: 'No longer listed or closed by the employer',
    explain: 'The source stopped listing the job, or its own job system reports it closed.',
    action: null,
  },
  low_fit: {
    label: 'Read, and below the near-miss score',
    explain: 'The full description was read and scored below your near-miss threshold.',
    action: null,
  },
  unread_legacy: {
    label: 'Never read (recorded before descriptions were tracked)',
    explain: 'Discarded by an older version without its description being fetched.',
    action: null,
  },
  geography_mismatch: { label: 'Location outside your search', explain: 'The posting is outside the locations your profile allows.', action: null },
  employment_mismatch: { label: 'Employment type you ruled out', explain: 'Contract, part-time or another type your profile excludes.', action: null },
  sponsorship_denial: { label: 'States it will not sponsor', explain: 'The description explicitly refuses visa sponsorship, which your profile needs.', action: null },
  role_mismatch: { label: 'Role outside your target', explain: 'The title or description matched a role you excluded.', action: null },
  security_clearance: { label: 'Requires a security clearance', explain: 'The description requires a clearance your profile does not list.', action: null },
  below_salary_floor: { label: 'Pays below your minimum', explain: 'The stated pay range tops out below your salary floor.', action: null },
  unlabelled: {
    label: 'No reason recorded (older runs)',
    explain: 'Low-score discards written before the reason was always recorded.',
    action: null,
  },
});

/**
 * The category key for one stored discard reason.
 * @param {string|null} reason
 * @returns {string}
 */
export function discardCategory(reason) {
  const r = String(reason ?? '').trim();
  if (!r) return 'unlabelled';
  if (r.startsWith('stale_posting')) return 'retired';
  // Older runs prefixed undated drops with "stale:" too; an unknown date is
  // not an old one, so test it first.
  if (/^(stale:\s*)?unknown posting date/.test(r)) return 'undated';
  if (r.startsWith('stale:')) return 'outside_window';
  if (/^(expired|closed)\b/i.test(r)) return 'unlisted';
  if (/^below (near-miss|score) threshold/i.test(r)) return 'low_fit';
  if (r.startsWith('not judged')) return 'unread_legacy';
  const prefix = r.split(':')[0].trim();
  return /^[a-z_]+$/.test(prefix) ? prefix : 'other';
}

function categoryInfo(key) {
  if (CATEGORIES[key]) return CATEGORIES[key];
  if (key === 'other') return { label: 'Other', explain: 'Discarded for a reason not grouped here.', action: null };
  const label = key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { label, explain: `Discarded by the ${key.replace(/_/g, ' ')} rule.`, action: null };
}

/** The latest run's failing sources, with the first recorded message for each. */
function sourceProblems(raw) {
  let row;
  try {
    row = raw.prepare(`SELECT run_id, started_at, per_source, errors FROM run_log
      WHERE per_source IS NOT NULL AND per_source <> '' ORDER BY started_at DESC LIMIT 1`).get();
  } catch { return { runAt: null, sources: [] }; }
  if (!row) return { runAt: null, sources: [] };
  const parse = (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const errors = parse(row.errors);
  const sources = parse(row.per_source)
    .filter((s) => s && (s.succeeded === false || Number(s.errors) > 0))
    .map((s) => {
      const first = errors.find((e) => e?.source === s.source);
      return {
        source: s.source,
        found: Number(s.found) || 0,
        errors: Number(s.errors) || 0,
        failed: s.succeeded === false,
        message: first ? String(first.message ?? '').slice(0, 200) : null,
        guidance: first?.guidance ? String(first.guidance).slice(0, 240) : null,
      };
    });
  return { runAt: row.started_at, sources };
}

/**
 * Plain-language description of the freshness model in effect.
 *
 * @param {object} config loadConfig() bundle
 */
export function freshnessSummary(config = {}) {
  const mode = config.runtime?.jobFreshnessMode ?? 'LAST_7_DAYS';
  const windowDays = FRESHNESS_WINDOW_DAYS[mode] ?? 7;
  const retentionDays = Number(config.exclusions?.staleness?.skipOlderThanDays) || 45;
  const windowText = Number.isFinite(windowDays) ? `${windowDays} day${windowDays === 1 ? '' : 's'}` : 'any age';
  const sources = config.settingSources ?? { discoveryWindow: 'env', retentionDays: 'config' };
  return {
    discoveryWindow: mode,
    discoveryDays: Number.isFinite(windowDays) ? windowDays : null,
    retentionDays,
    retentionRange: RETENTION_RANGE,
    sources,
    fallbackTo3Days: config.runtime?.includeLast3DaysFallback !== false && Number.isFinite(windowDays) && windowDays < 3,
    rules: [
      `Searches add a new job only if it was posted within ${windowText}.`,
      `A job already on your board stays until it is ${retentionDays} days old, then it is retired.`,
      'Jobs you shortlisted, prepared or applied to are never retired automatically.',
      'Jobs with no posting date are kept off the board rather than guessed at.',
    ],
  };
}

/**
 * Everything the "Discovery & data quality" view shows.
 *
 * @param {object} db openDatabase() handle
 * @param {object} config loadConfig() bundle
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object|null} [options.enrichmentState] the dashboard's live pass state
 */
export function dataQualitySummary(db, config, { now = new Date(), enrichmentState = null } = {}) {
  const raw = db?.db;
  const out = {
    generatedAt: now.toISOString(),
    freshness: freshnessSummary(config),
    board: { active: 0, scored: 0, needsDescription: 0, dateReview: 0, total: 0 },
    filtered: [],
    enrichment: {
      settings: enrichmentSettings(config),
      backlog: null,
      fetchableSources: FETCHABLE_SOURCES,
      state: enrichmentState,
    },
    sourceProblems: { runAt: null, sources: [] },
    settingsError: config.settingsError ?? null,
  };
  if (!raw?.prepare) return out;

  // Both groupings scan the whole table (the discarded one ~165k rows on a
  // real store, measured 331-338 ms of blocked event loop per dialog open), so
  // they are memoized on the shared data key and recomputed only after a write.
  const counts = cachedForData(db, 'dataQuality', now, () => {
    const board = { scored: 0, needsDescription: 0, dateReview: 0, total: 0 };
    for (const r of raw.prepare(`SELECT status, COUNT(*) AS n FROM jobs
        WHERE discovery_mode = 'profile' GROUP BY status`).all()) {
      board.total += r.n;
      if (r.status === 'scored') board.scored += r.n;
      if (r.status === 'needs_description') board.needsDescription += r.n;
      if (r.status === 'unknown_date_review') board.dateReview += r.n;
    }
    const byCategory = new Map();
    for (const r of raw.prepare(`SELECT discard_reason AS reason, COUNT(*) AS n FROM jobs
        WHERE discovery_mode = 'profile' AND status = 'discarded' GROUP BY discard_reason`).all()) {
      const key = discardCategory(r.reason);
      byCategory.set(key, (byCategory.get(key) ?? 0) + r.n);
    }
    const filtered = [...byCategory.entries()]
      .map(([key, count]) => ({ key, count, ...categoryInfo(key) }))
      .sort((a, b) => b.count - a.count);
    return { board, filtered };
  });
  out.board = { ...out.board, ...counts.board };
  // "Active" is the Jobs list's own "All jobs" count. Summing raw `scored` and
  // `needs_description` rows counted jobs you rejected or archived (their
  // status column stays `scored`) and missed prepared or in-progress ones, so
  // the two screens disagreed (BUG-10).
  out.board.active = activeJobCount(db, now);
  out.filtered = counts.filtered.map((f) => ({ ...f }));

  out.enrichment.backlog = enrichmentBacklog(db, config, { now });
  out.sourceProblems = sourceProblems(raw);
  return out;
}
