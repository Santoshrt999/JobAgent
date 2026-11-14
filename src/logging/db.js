/**
 * SQLite persistence using Node's built-in `node:sqlite` (no native build deps).
 *
 * Exposes a thin wrapper that:
 *  - opens/creates the database file (or an in-memory DB for tests),
 *  - applies the schema idempotently,
 *  - provides small helpers for the tables defined in the build spec.
 *
 * Tables: jobs, run_log, application_events, approval_queue.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { PROJECT_ROOT } from '../config/loadConfig.js';
import { nowIso } from '../utils/dates.js';
import { assertTransition } from '../lifecycle.js';
import { localDayWindow } from '../domain/time.js';
import { workspacePaths } from '../profile/workspace.js';
import { backupStamp } from './backup.js';

// Load the built-in `node:sqlite` via createRequire so bundlers/test runners
// (Vite/Vitest) do not statically analyze and try to transform this newer
// built-in module. It is a standard Node module, not an npm dependency.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** The ORIGINAL workspace's database (profiles saved before workspaces use it). */
export const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data', 'applied_jobs.db');

/**
 * The active person's database: the original file for the original
 * workspace, data/profiles/<id>/applied_jobs.db for a profile with its own
 * (src/profile/workspace.js). Resolved at OPEN time, not import time, so a
 * CLI run started after a switch reads the person now active.
 */
export const activeDbPath = (root = PROJECT_ROOT) => workspacePaths(root).db;

/** Full schema, applied idempotently on open. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT,
  company TEXT,
  title TEXT,
  location TEXT,
  url TEXT,
  jd_text TEXT,
  posted_at TEXT,
  applicant_count INTEGER,
  employment_type TEXT,
  employment_category TEXT,
  compensation_text TEXT,
  score INTEGER,
  tier TEXT,
  sponsorship TEXT,
  sponsorship_signals TEXT,
  discard_reason TEXT,
  matched_keywords TEXT,
  missing_keywords TEXT,
  explanation TEXT,
  ats_platform TEXT,
  ats_score INTEGER,
  ats_band TEXT,
  status TEXT,
  resume_path TEXT,
  resume_docx_path TEXT,
  resume_pdf_path TEXT,
  cover_letter_path TEXT,
  application_packet_path TEXT,
  output_folder_path TEXT,
  applied INTEGER DEFAULT 0,
  applied_at TEXT,
  user_decision TEXT,
  decided_at TEXT,
  assist_filled_count INTEGER,
  assist_blockers TEXT,
  notes TEXT,
  submitted_confirmation TEXT,
  created_at TEXT,
  updated_at TEXT,
  summary_only INTEGER,
  discovery_mode TEXT,
  search_query TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
  run_id TEXT PRIMARY KEY,
  mode TEXT,
  started_at TEXT,
  ended_at TEXT,
  jobs_found INTEGER,
  jobs_scored INTEGER,
  jobs_skipped_unchanged INTEGER,
  jobs_cancelled INTEGER,
  jobs_queued INTEGER,
  jobs_prepared INTEGER,
  jobs_applied INTEGER,
  jobs_assisted INTEGER,
  jobs_submitted INTEGER,
  jobs_discarded INTEGER,
  jobs_unknown_date_review INTEGER,
  jobs_new INTEGER,
  jobs_unread INTEGER,
  jobs_duplicate INTEGER,
  jobs_discarded_stale INTEGER,
  jobs_discarded_excluded INTEGER,
  jobs_discarded_low_score INTEGER,
  jobs_suppressed_applied INTEGER,
  jobs_suppressed_url_owned INTEGER,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  event_type TEXT,
  message TEXT,
  metadata TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_queue (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  packet_path TEXT,
  approval_status TEXT,
  approved_by_user INTEGER DEFAULT 0,
  approved_at TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_tier ON jobs(tier);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_applied ON jobs(applied);
CREATE INDEX IF NOT EXISTS idx_events_job ON application_events(job_id);
CREATE INDEX IF NOT EXISTS idx_approval_job ON approval_queue(job_id);

`;

/**
 * Sort clauses `listJobsSummaryPage` will accept, keyed by the board's own sort
 * names. An allowlist rather than interpolation: the value reaches an ORDER BY
 * clause, and it arrives from a query string.
 *
 * Each mirrors the equivalent JavaScript comparator in src/dashboard/data.js
 * (SORTS). `company` is deliberately ABSENT — its comparator uses
 * `localeCompare`, which orders case and accents differently from any SQLite
 * collation, so pushing it down would make the fast and slow paths disagree
 * about the order of the same rows. That sort keeps the in-memory path.
 */
const SUMMARY_PAGE_ORDERS = Object.freeze({
  // NULLs sort last in SQLite DESC, matching `(b.score ?? -1) - (a.score ?? -1)`.
  score: 'score DESC',
  posted: "COALESCE(posted_at, '') DESC",
  updated: "COALESCE(updated_at, '') DESC",
  discovered: "COALESCE(created_at, '') DESC",
});

/** All jobs-table columns except jd_text (see listJobsSummary). */
const JOB_SUMMARY_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'posted_at',
  'applicant_count', 'employment_type', 'employment_category', 'compensation_text',
  'score', 'tier', 'sponsorship', 'sponsorship_signals',
  'discard_reason', 'matched_keywords', 'missing_keywords', 'explanation',
  'ats_platform', 'ats_score', 'ats_band', 'status', 'resume_path', 'resume_docx_path', 'resume_pdf_path',
  'cover_letter_path', 'application_packet_path', 'output_folder_path', 'prepared_at',
  'applied', 'applied_at', 'user_decision', 'decided_at',
  'assist_filled_count', 'assist_blockers', 'notes', 'submitted_confirmation',
  'created_at', 'updated_at', 'discovery_mode', 'search_query', 'decision_reason',
  'link_state', 'link_checked_at',
];

/**
 * SQL restricting a board read to ONE discovery mode.
 *
 * Every row written before this column existed came from a personalized run
 * (ad-hoc role search is the only other writer and it is newer), so NULL MEANS
 * 'profile'. That used to be spelled in every query as
 * `(discovery_mode IS NULL OR discovery_mode = 'profile')` — and an OR over a
 * nullable column cannot be answered from one covering index: SQLite split it
 * into a MULTI-INDEX OR with a row lookup per candidate. Measured on the live
 * 122,977-row store: the board's open-ids read took 188 ms that way, against
 * ~20 ms for the same read as an equality on a covering index.
 *
 * Schema v1 (see MIGRATIONS) backfills the NULLs and makes every new insert
 * default to 'profile', after which plain equality is exactly equivalent. The
 * NULL-tolerant form is kept ONLY for a handle on a database that has not been
 * migrated (a read-only connection opened by a tool), where equality would
 * silently drop 57k legacy rows off the board.
 *
 * @param {'profile'|'role_search'|'all'} [mode]
 * @param {string|null} [query] required to scope a role_search read to one phrase
 * @param {object} [options]
 * @param {boolean} [options.nullIsProfile=false] true for an unmigrated (v0) database
 * @returns {{sql: string, params: string[]}} a WHERE-ready fragment ('' when unrestricted)
 */
export function discoveryModeClause(mode = 'profile', query = null, { nullIsProfile = false } = {}) {
  if (mode === 'all') return { sql: '', params: [] };
  if (mode === 'role_search') {
    return query
      ? { sql: "discovery_mode = 'role_search' AND search_query = ?", params: [String(query)] }
      : { sql: "discovery_mode = 'role_search'", params: [] };
  }
  return nullIsProfile
    ? { sql: "(discovery_mode IS NULL OR discovery_mode = 'profile')", params: [] }
    : { sql: "discovery_mode = 'profile'", params: [] };
}

/** `WHERE <clause>` / `AND <clause>`, or '' when the mode is unrestricted. */
function whereMode(clause, keyword = 'WHERE') {
  return clause.sql ? ` ${keyword} ${clause.sql}` : '';
}

/**
 * The only columns dashboardStats reads — directly, or via the helpers it calls
 * (deriveAppStatus, fitBucket, isSponsorshipGated, isUndatedDrop,
 * postedConfidence, preparedAtOf, gradeFromScore, usLocationSignal).
 *
 * Stats must aggregate the WHOLE table, so it is the one dashboard read that
 * cannot be narrowed by rows — but it can be narrowed by columns. The wide
 * summary projection also carries `explanation`, `matched_keywords`,
 * `missing_keywords`, `notes` and friends: long per-row TEXT that stats never
 * looks at, but that SQLite still has to read off disk and V8 still has to
 * allocate a string for, once per row.
 *
 * Adding a column to the stats loop means adding it HERE too — a missing column
 * arrives as `undefined` and silently changes a count rather than failing.
 */
const JOB_STATS_COLUMNS = [
  'id', 'source', 'location', 'posted_at', 'score', 'tier', 'sponsorship',
  'discard_reason', 'status', 'application_packet_path', 'prepared_at',
  'applied', 'applied_at', 'user_decision', 'created_at', 'updated_at',
].join(', ');

/** Columns allowed for the jobs table (whitelist for safe upserts). */
const JOB_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'jd_text', 'posted_at',
  'applicant_count', 'employment_type', 'employment_category', 'compensation_text',
  'score', 'tier', 'sponsorship', 'sponsorship_signals',
  'discard_reason', 'matched_keywords', 'missing_keywords', 'explanation',
  'ats_platform', 'ats_score', 'ats_band', 'status', 'resume_path', 'resume_docx_path', 'resume_pdf_path',
  'cover_letter_path', 'application_packet_path', 'output_folder_path', 'prepared_at',
  'applied', 'applied_at', 'user_decision', 'decided_at',
  'assist_filled_count', 'assist_blockers', 'notes', 'submitted_confirmation',
  'created_at', 'updated_at',
  'summary_only', 'scoring_fingerprint',
  // Which search produced the row, and the phrase it was asked for. Omitted
  // from a patch, they keep their stored value — which is what lets a role
  // search update a posting's text without claiming a row the profile owns.
  'discovery_mode', 'search_query',
  // Why the user rejected/archived the job (schema v2). Written only through
  // setUserDecision, but allowed here so an import can carry it.
  'decision_reason',
  // Is the posting still open at its source (schema v3)? Written by
  // recordPostingCheck from an ATS-specific liveness check.
  'link_state', 'link_checked_at',
  // Description enrichment bookkeeping (schema v4), written by
  // src/search/enrich.js.
  'enrich_attempts', 'enrich_attempted_at', 'enrich_error',
];

/**
 * Open (and initialize) the database.
 *
 * @param {object} [options]
 * @param {string} [options.path=activeDbPath()] file path, or ':memory:'
 * @returns {Database}
 */
export function openDatabase({ path = activeDbPath() } = {}) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  // With WAL, NORMAL is the recommended high-throughput durability setting: it
  // is safe across process crashes (only risks a power loss) and avoids an
  // fsync on every commit. Discovery persists thousands of rows per run, so the
  // default FULL setting would otherwise dominate runtime with disk syncs.
  db.exec('PRAGMA synchronous = NORMAL;');
  // Two processes legitimately write this DB at once (dashboard server + CLI
  // watch mode). Without a busy timeout a concurrent write throws SQLITE_BUSY
  // immediately; with it, SQLite retries for up to 5s before giving up.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  // SQLite's default page cache is 2 MB. This database is hundreds of MB (jd_text
  // dominates), and the dashboard re-reads the jobs table on every stats build,
  // so at the default nearly every pass went back to disk. Negative = KiB, so
  // this is a 64 MB ceiling, not 64000 pages. temp_store=MEMORY keeps the sorter
  // for `ORDER BY score` out of a temp file.
  db.exec('PRAGMA cache_size = -65536;');
  db.exec('PRAGMA temp_store = MEMORY;');
  backupBeforeMigration(db, path);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  applyVersionedMigrations(db);
  if (path !== ':memory:') {
    // Long-lived readers (the dashboard) can keep the WAL from ever being
    // checkpointed; left alone it grows without bound (observed: 60+ MB).
    // A truncate checkpoint on open folds it back into the main DB file.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best effort */ }
  }
  return new Database(db);
}

/**
 * Opening the store applies pending schema migrations automatically, so before
 * a store that holds jobs is migrated, a copy is taken next to it in
 * backups/applied_jobs-pre-migration-<stamp>.db (P1-6). A migration that goes
 * wrong can then be undone by restoring that file. Synchronous on purpose: it
 * must finish before the first migration runs.
 */
function backupBeforeMigration(db, path) {
  if (path === ':memory:' || process.env.JOB_AGENT_PRE_MIGRATION_BACKUP === 'off') return;
  const from = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (from >= latest) return;
  const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
  if (!hasJobs || !db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n) return;
  const dest = join(dirname(path), 'backups', `applied_jobs-pre-migration-${backupStamp()}.db`);
  mkdirSync(dirname(dest), { recursive: true });
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

/** Idempotent, additive migrations for databases created by older schemas. */
function applyMigrations(db) {
  const runLogCols = new Set(db.prepare('PRAGMA table_info(run_log)').all().map((c) => c.name));
  for (const col of ['jobs_assisted', 'jobs_submitted', 'jobs_unknown_date_review',
    'jobs_skipped_unchanged', 'jobs_cancelled',
    // A run used to report one undifferentiated `jobs_discarded`, and no count
    // of what was actually NEW -- so a run that found thousands of new postings
    // and one that found none produced near-identical numbers. These split the
    // causes apart and record novelty.
    'jobs_new', 'jobs_unread', 'jobs_duplicate', 'jobs_discarded_stale', 'jobs_discarded_excluded',
    'jobs_discarded_low_score', 'jobs_suppressed_applied', 'jobs_suppressed_url_owned']) {
    if (!runLogCols.has(col)) {
      db.exec(`ALTER TABLE run_log ADD COLUMN ${col} INTEGER`);
    }
  }
  const jobCols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const col of ['resume_docx_path', 'resume_pdf_path', 'output_folder_path',
    'user_decision', 'decided_at', 'assist_blockers', 'notes', 'submitted_confirmation', 'ats_band',
    'employment_category', 'compensation_text', 'prepared_at',
    // Why a row says Confirmed/Denied. The classifier always computed these
    // signals and the pipeline always threw them away, so the sponsorship badge
    // asserted a conclusion with no recoverable evidence -- which is exactly why
    // 6 Humana rows could claim "Confirmed" off sentences that refused
    // sponsorship outright without anyone being able to see it from the UI.
    'sponsorship_signals']) {
    if (!jobCols.has(col)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
    }
  }
  // Whether the description was ever actually FETCHED. Without this the
  // system cannot distinguish "judged and rejected" from "never read", and
  // 31,409 rows scored on <200 characters were reported as poor fits.
  if (!jobCols.has('summary_only')) {
    db.exec('ALTER TABLE jobs ADD COLUMN summary_only INTEGER');
  }
  // PERFORMANCE INDEXES (idx_jobs_board_open, idx_jobs_stats) are owned by the
  // versioned migrations below — they now lead with discovery_mode, a column
  // this function adds further down, so they cannot be created at this point.

  if (!jobCols.has('assist_filled_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN assist_filled_count INTEGER');
  }
  if (!jobCols.has('ats_score')) {
    db.exec('ALTER TABLE jobs ADD COLUMN ats_score INTEGER');
  }
  // Which CONFIGURATION produced this row's score. Incremental discovery skips
  // a job whose posting has not changed, and without this it had no way to
  // notice that the candidate had. Rows scored before this column existed hold
  // NULL, which never matches a live fingerprint, so they rescore once and are
  // then correctly skipped.
  if (!jobCols.has('scoring_fingerprint')) {
    db.exec('ALTER TABLE jobs ADD COLUMN scoring_fingerprint TEXT');
  }

  /*
   * WHICH SEARCH FOUND THIS ROW.
   *
   * 'profile'     — personalized discovery, judged against the saved profile.
   * 'role_search' — an ad-hoc "search by job role" for a phrase the user typed.
   *
   * Without this the two were the same pile. An ad-hoc search runs the same
   * pipeline with `keepBelowThreshold`, so every row it touched persisted as
   * `scored` no matter how it rated against the profile — searching "Product
   * Manager" once permanently seeded the personalized board with product roles
   * and there was no way to tell them apart afterwards, or to undo it.
   *
   * Existing rows hold NULL and are read as 'profile': every row already in the
   * database was found by a profile run, because ad-hoc search is the only
   * other writer and it is newer than every row here.
   */
  if (!jobCols.has('discovery_mode')) {
    db.exec('ALTER TABLE jobs ADD COLUMN discovery_mode TEXT');
  }
  if (!jobCols.has('search_query')) {
    db.exec('ALTER TABLE jobs ADD COLUMN search_query TEXT');
  }
  // The board filters on discovery_mode on EVERY query, including the covering
  // open-rows path above, so it has to be part of that index or the filter
  // reverts the plan to a full scan of a 383 MB table.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_mode
             ON jobs(discovery_mode, search_query, status, score, id)`);
}

/*
 * PERFORMANCE INDEXES.
 *
 * These two are the difference between a dashboard that responds instantly
 * and one that appears hung. Measured on 112,709 rows / a 383 MB jobs table:
 *   board open-rows predicate   15.3 s -> 39 ms   (covering, no row reads)
 *   stats tiles (all rows)      25.7 s -> 663 ms  (index-only scan)
 * jd_text is stored INLINE, so any full table scan drags every stored job
 * description through memory; these let SQLite answer from the index instead.
 *
 * Both LEAD with discovery_mode: every board and stats read is scoped to one
 * mode by an equality, so the scope is a range seek into the index and the
 * rest of the read stays covering. Keep idx_jobs_stats in sync with
 * JOB_STATS_COLUMNS — a column in the query but missing from the index silently
 * reverts the plan to a full scan (tests/node/dbMigrations.test.js asserts the
 * plan says COVERING INDEX).
 */
const PERF_INDEXES = Object.freeze([
  ['idx_jobs_board_open', 'jobs(discovery_mode, status, applied, user_decision, score, id)'],
  ['idx_jobs_stats', `jobs(discovery_mode, score, id, source, location, posted_at, tier, sponsorship,
      status, applied, applied_at, user_decision, created_at, updated_at, prepared_at,
      discard_reason, application_packet_path)`],
]);

/**
 * "This row has a generated document." Shared, verbatim, by idx_jobs_documents
 * and listDocumentJobs: SQLite only uses a partial index when the query's WHERE
 * implies the index's, and textual identity is the reliable way to ensure it.
 */
const DOCUMENT_ROW_PREDICATE = 'resume_docx_path IS NOT NULL OR resume_path IS NOT NULL '
  + 'OR resume_pdf_path IS NOT NULL OR cover_letter_path IS NOT NULL OR application_packet_path IS NOT NULL';

/** Add a column only when it is missing (ALTER TABLE has no IF NOT EXISTS). */
function addColumnIfMissing(db, table, column, type) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * VERSIONED migrations, tracked in `PRAGMA user_version`.
 *
 * The additive `applyMigrations` above is enough for "add a nullable column",
 * but not for a change that rewrites data or replaces an index: those must run
 * exactly once, completely or not at all. Each step here runs in its own
 * `BEGIN IMMEDIATE` transaction together with the user_version bump, so a
 * crash mid-migration leaves the previous version intact and the step simply
 * re-runs on the next open. Every step is also idempotent on its own.
 *
 * Measured on a synthetic 120,000-row store (47% NULL discovery_mode, ~2 KB
 * jd_text/row): v0 -> v2 in 1.84 s (open-ids read 181 -> 18 ms, stats read
 * 455 -> 211 ms, both now COVERING). See tests/node/dbMigrations.test.js.
 */
/** Statuses a closed posting is retired from (open, nobody has acted on it). */
const RETIREABLE_STATUSES = new Set(['scored', 'needs_description', 'near_miss', 'queued']);

/** Statuses where a packet may exist but nothing was submitted or is mid-fill. */
const UNSUBMITTED_PACKET_STATUSES = new Set(['queued', 'prepared', 'failed', 'assist_blocked', 'cancelled', 'skipped']);

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'discovery_mode is never NULL; board/stats indexes lead with it',
    up(db) {
      // Rows written before the column existed are personalized — see
      // discoveryModeClause. Backfilling lets every read use equality.
      db.exec("UPDATE jobs SET discovery_mode = 'profile' WHERE discovery_mode IS NULL");
      for (const [name, on] of PERF_INDEXES) {
        db.exec(`DROP INDEX IF EXISTS ${name}`);
        db.exec(`CREATE INDEX ${name} ON ${on}`);
      }
      // `status` and `score` alone: each was a PREFIX of the old board/stats
      // index, and is not of the new ones — they still serve the unscoped
      // (`mode: 'all'`) reads and `WHERE status = ?`, so they are kept.
    },
  },
  {
    version: 2,
    name: 'decision reasons, and per-source run summaries',
    up(db) {
      // Why the user rejected/archived a job ("salary", "location", …): the
      // one signal about their preferences the product threw away.
      addColumnIfMissing(db, 'jobs', 'decision_reason', 'TEXT');
      // A run's per-source summary (found / errors / duration per board), so
      // /api/runs can answer "which board failed last night?" after a restart.
      addColumnIfMissing(db, 'run_log', 'per_source', 'TEXT');
      addColumnIfMissing(db, 'run_log', 'jobs_discarded_stale', 'INTEGER');
      // The few hundred rows with a generated document. A PARTIAL index whose
      // WHERE is exactly listDocumentJobs' predicate, so the Documents view and
      // the master-resume staleness count stop scanning the whole table
      // (measured live without it: ~1.0 s each, reading every inline jd_text).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_documents ON jobs(id) WHERE ${DOCUMENT_ROW_PREDICATE}`);
    },
  },
  {
    version: 3,
    name: 'posting liveness: is the job still open at its source?',
    up(db) {
      // Measured 2026-09-23 on the live board: 24 of the 40 best-scored open
      // Workday rows and 5 of 6 SmartRecruiters rows had been CLOSED by the
      // employer, yet still sat on the board — clicking through showed
      // Workday's "The page you are looking for doesn't exist". Workday answers
      // 200 for that page, so the old HTTP link check could never tell.
      addColumnIfMissing(db, 'jobs', 'link_state', 'TEXT');
      addColumnIfMissing(db, 'jobs', 'link_checked_at', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'description enrichment attempts (resumable, bounded retries)',
    up(db) {
      // Half the store was summary-only and the only fix was a manual script
      // that retried the same dead postings on every pass. Recording each
      // attempt lets enrichment resume where it stopped, back off from a row
      // that failed, and give up on one whose posting is gone.
      addColumnIfMissing(db, 'jobs', 'enrich_attempts', 'INTEGER');
      addColumnIfMissing(db, 'jobs', 'enrich_attempted_at', 'TEXT');
      addColumnIfMissing(db, 'jobs', 'enrich_error', 'TEXT');
    },
  },
]);

/** Highest schema version this code knows how to produce. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Bring the database up to SCHEMA_VERSION, one transactional step at a time.
 * @param {DatabaseSync} db
 * @returns {{from: number, to: number}}
 */
export function applyVersionedMigrations(db) {
  const from = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  // A store written by NEWER code has columns and meanings this code does not
  // know. Writing to it (an older checkout, a restored newer backup) would
  // silently produce rows the newer code misreads, so refuse instead.
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (from > latest) {
    throw Object.assign(new Error(
      `this job database is from a newer JobAgent (schema ${from}; this version understands up to ${latest}). `
      + 'Update JobAgent, or open a backup made by this version.',
    ), { code: 'SCHEMA_TOO_NEW' });
  }
  let current = from;
  for (const step of MIGRATIONS) {
    if (current >= step.version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db);
      // Integer interpolation of a constant from this file, never input.
      db.exec(`PRAGMA user_version = ${Number(step.version)}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw new Error(`schema migration v${step.version} (${step.name}) failed: ${err.message}`);
    }
    current = step.version;
  }
  // Belt and braces: an index dropped by hand is recreated (a no-op otherwise).
  for (const [name, on] of PERF_INDEXES) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${on}`);
  return { from, to: current };
}

/** Serialize a value for a TEXT column (objects/arrays become JSON). */
function toText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** Thin convenience wrapper around a DatabaseSync handle. */
export class Database {
  /** @param {DatabaseSync} handle */
  constructor(handle) {
    /** @type {DatabaseSync} */
    this.db = handle;
    /**
     * Prepared-statement cache. Discovery upserts thousands of rows per run,
     * each via getJob + INSERT…ON CONFLICT; re-preparing identical SQL every
     * call is wasted work, so we memoize by SQL text.
     * @type {Map<string, import('node:sqlite').StatementSync>}
     */
    this._stmtCache = new Map();
    /**
     * Where non-fatal bookkeeping problems go (e.g. a run_log update for a run
     * that was never opened). Replaceable so a caller can route it to its
     * logger; tests silence it.
     * @type {(message: string) => void}
     */
    this.onWarning = (message) => { process.emitWarning(message, { code: 'JOBAGENT_DB' }); };
    this._detectSchema();
  }

  /**
   * Read the schema version and column set this handle actually has.
   *
   * `openDatabase` always migrates, so this is normally SCHEMA_VERSION. It is
   * NOT for a handle wrapped directly — a read-only connection a tool opened
   * against a database nobody has migrated yet. Such a handle must neither
   * select columns that do not exist (decision_reason arrives in v2) nor use
   * the equality mode clause on rows that still hold NULL (v1 backfills them).
   */
  _detectSchema() {
    let version = SCHEMA_VERSION;
    let cols = null;
    try {
      version = Number(this.db.prepare('PRAGMA user_version').get().user_version) || 0;
      cols = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
    } catch { /* exotic stub handle — assume current */ }
    this.schemaVersion = version;
    this._nullModeIsProfile = version < 1;
    const summary = cols && cols.size ? JOB_SUMMARY_COLUMNS.filter((c) => cols.has(c)) : JOB_SUMMARY_COLUMNS;
    this._summaryColumns = summary.join(', ');
    this._hasDecisionReason = !cols || !cols.size || cols.has('decision_reason');
  }

  /** The discovery-mode clause appropriate to THIS database's schema version. */
  _modeClause(mode, query) {
    return discoveryModeClause(mode, query, { nullIsProfile: this._nullModeIsProfile });
  }

  /**
   * A token that changes whenever ANY connection commits a write.
   *
   * `total_changes()` alone only counts THIS connection's writes, so a cache
   * keyed on it never noticed a CLI `watch` / `discover` process writing the
   * same file — the dashboard kept serving numbers from before the run.
   * `PRAGMA data_version` is the complement: it changes when another
   * connection commits, and never for our own. Together they cover both.
   *
   * @returns {string}
   */
  changeToken() {
    const version = this.prepareCached('PRAGMA data_version').get()?.data_version ?? 0;
    const changes = this.prepareCached('SELECT total_changes() AS c').get()?.c ?? 0;
    return `${version}:${changes}`;
  }

  /** Prepare (and cache) a statement by its SQL text. */
  prepareCached(sql) {
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Run `fn` inside a single transaction. Commits on success, rolls back on
   * throw. Used to batch the thousands of per-job upserts a discovery run makes
   * into one durable write instead of thousands.
   *
   * BEGIN IMMEDIATE, not a deferred BEGIN: two processes write this file (the
   * dashboard and a CLI run). A deferred transaction that reads first and then
   * tries to write can fail with SQLITE_BUSY *without* honouring busy_timeout,
   * because upgrading a read lock would deadlock; IMMEDIATE takes the write
   * lock up front, so contention waits the 5 s busy timeout instead of failing.
   *
   * Re-entrant: called while a transaction is already open (a helper that
   * wraps its own writes, invoked from inside a caller's batch), `fn` simply
   * joins the outer transaction.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T} whatever `fn` returned
   */
  transaction(fn) {
    // `DatabaseSync#isTransaction` only exists from Node 22.16, and the engines
    // floor is 22.13. There it is undefined, so a nested call issued a second
    // BEGIN and threw "cannot start a transaction within a transaction". Our own
    // flag covers that floor; isTransaction still catches a BEGIN made elsewhere.
    if (this.db.isTransaction || this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Apply `fn` to every item, committing every `size` items.
   *
   * One transaction per row made a discovery run pay a WAL commit per posting;
   * one transaction for the whole run holds the write lock for its entire
   * duration, so the dashboard's own writes (a decision click) wait behind it
   * and can hit the busy timeout. Chunks bound both: a few hundred rows per
   * commit is ~all of the batching win while releasing the lock many times a
   * second.
   *
   * A throw rolls back ONLY the chunk it happened in (earlier chunks are
   * already durable) and propagates.
   *
   * @template I, R
   * @param {I[]} items
   * @param {number} size rows per transaction (>= 1; default 500)
   * @param {(item: I, index: number) => R} fn called once per item, inside a transaction
   * @returns {R[]} fn's results, in item order
   */
  transactionChunks(items = [], size = 500, fn) {
    if (typeof fn !== 'function') throw new TypeError('transactionChunks(items, size, fn) requires fn');
    const step = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 500;
    const list = Array.isArray(items) ? items : [...items];
    const results = new Array(list.length);
    for (let start = 0; start < list.length; start += step) {
      const end = Math.min(start + step, list.length);
      this.transaction(() => {
        for (let i = start; i < end; i += 1) results[i] = fn(list[i], i);
      });
    }
    return results;
  }

  close() {
    this._stmtCache.clear();
    this.db.close();
  }

  /**
   * Insert or update a job row by id. Unknown keys are ignored; timestamps
   * are managed automatically.
   *
   * Returns only the write's outcome. It used to return `getJob(id)` — a
   * `SELECT *` that dragged the row's full jd_text (~8 KB avg) back off disk
   * after every write, on every one of the tens of thousands of rows a
   * discovery run persists, for a value no production caller ever read.
   * A caller that needs the row calls getJob itself.
   *
   * @param {Record<string, any>} job
   * @returns {{changes: number}}
   */
  upsertJob(job) {
    if (!job || !job.id) throw new Error('upsertJob requires a job with an id');
    const now = nowIso();

    const record = { ...job };
    record.created_at = job.created_at ?? now;
    record.updated_at = now;

    // `!== undefined`, not `in`: a patch built from an object whose field
    // happened to be missing (`jd_text: job.jdText` for a posting with no
    // description) used to write NULL over the stored value — erasing a
    // description some earlier run had paid to fetch. `null` is still an
    // explicit "clear it".
    const cols = JOB_COLUMNS.filter((c) => record[c] !== undefined);
    // Every NEW row is owned by a search. Omitted from a patch, the mode keeps
    // its stored value on UPDATE (see the ownership rule in pipeline/index.js),
    // but an INSERT without one would recreate the NULLs schema v1 backfilled.
    const insertCols = cols.includes('discovery_mode') ? cols : [...cols, 'discovery_mode'];
    const placeholders = insertCols.map((c) => `@${c}`).join(', ');
    // `created_at` is deliberately NOT in the UPDATE list: the first insert owns
    // it and a re-discovery must never move it. This used to be enforced by
    // reading the existing row first (`existing?.created_at ?? ...`) and writing
    // the same value back — a full `SELECT *` per upsert, pulling ~8 KB of
    // jd_text off disk for one timestamp, on every one of the tens of thousands
    // of rows a discovery run persists. Omitting the column from the UPDATE is
    // equivalent and needs no read at all.
    const updates = cols
      .filter((c) => c !== 'id' && c !== 'created_at')
      .map((c) => `${c} = ${this._updateExpr(c, cols)}`).join(', ');

    const params = {};
    for (const c of cols) params[c] = toText(record[c]);
    if (!cols.includes('discovery_mode')) params.discovery_mode = 'profile';

    const sql = `INSERT INTO jobs (${insertCols.join(', ')}) VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates}`;
    const result = this.prepareCached(sql).run(params);
    return { changes: Number(result?.changes ?? 0) };
  }

  /**
   * The UPDATE expression for one column of an upsert.
   *
   * THE DESCRIPTION GUARD. A source that returns only a title + snippet marks
   * its row `summary_only = 1` and carries whatever short text it has. When
   * such a sighting re-discovers a posting whose FULL description is already
   * stored, the plain `jd_text = @jd_text` replaced 8 KB of real description
   * with a 150-character teaser (or NULL) and flagged the row unread — and the
   * next re-score then judged the job on the teaser. A stored description of
   * >= 200 characters is therefore never replaced by a shorter one from a
   * summary-only write, and the row keeps `summary_only = 0`, because it is
   * still, truthfully, a row whose description we have read.
   *
   * @param {string} c column name (allowlisted)
   * @param {string[]} cols columns present in this upsert
   * @returns {string} SQL expression
   */
  _updateExpr(c, cols) {
    if (!cols.includes('summary_only')) return `@${c}`;
    const keepsStored = "(excluded.summary_only = 1 AND length(coalesce(jobs.jd_text, '')) >= 200"
      + (cols.includes('jd_text')
        ? " AND length(coalesce(excluded.jd_text, '')) < length(jobs.jd_text))"
        : ')');
    if (c === 'jd_text') return `CASE WHEN ${keepsStored} THEN jobs.jd_text ELSE excluded.jd_text END`;
    if (c === 'summary_only') return `CASE WHEN ${keepsStored} THEN 0 ELSE excluded.summary_only END`;
    return `@${c}`;
  }

  /** @param {string} id */
  getJob(id) {
    return this.prepareCached('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  /**
   * Just the columns `isProtectedJobRow` (src/lifecycle.js) inspects, for the
   * downgrade guard discovery runs apply to every re-seen posting. Same verdict
   * as passing a full `getJob` row, without reading that row's jd_text.
   * @param {string} id
   * @returns {{applied: number|null, application_packet_path: string|null,
   *            user_decision: string|null, status: string|null}|null}
   */
  getJobProtectionFields(id) {
    return this.prepareCached(
      'SELECT applied, application_packet_path, user_decision, status, discovery_mode FROM jobs WHERE id = ?',
    ).get(id) ?? null;
  }

  /**
   * Return a Set of all job ids that have been APPLIED to. Loading them once is
   * far cheaper than calling getJob() per discovered job during dedup (a
   * discovery run examines thousands of jobs every time).
   * @returns {Set<string>}
   */
  getAppliedJobIds() {
    const rows = this.db.prepare('SELECT id FROM jobs WHERE applied = 1').all();
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Return a Set of EVERY job id currently known to the database (any status).
   * Watch mode snapshots this before a cycle so it can tell which jobs are
   * brand-new this cycle (worth alerting on) vs. already-seen.
   * @returns {Set<string>}
   */
  getKnownJobIds() {
    const rows = this.db.prepare('SELECT id FROM jobs').all();
    return new Set(rows.map((r) => r.id));
  }

  /**
   * URL identities that already own an actionable/protected record. Closed
   * discovery-only history is excluded so a genuinely reposted role can return.
   * @returns {Array<{id: string, url: string}>}
   */
  getActiveJobUrls() {
    return this.db.prepare(`
      SELECT id, url FROM jobs
      WHERE trim(coalesce(url, '')) <> ''
        AND (applied = 1
          OR status NOT IN ('discarded', 'skipped')
          OR user_decision = 'shortlisted')
    `).all();
  }

  /**
   * A full description already paid for in an earlier discovery run.
   *
   * Reusing it avoids repeating hundreds of optional public detail requests.
   * This was originally hardcoded to `source = 'workday'`, which meant every
   * OTHER adapter with a detail budget re-bought descriptions it already had on
   * every single run — SmartRecruiters alone spent ~3,700 requests per run
   * re-reading postings that were already stored. A posting's description does
   * not change often enough to be worth that, and the id is already
   * source-qualified, so the restriction bought nothing.
   *
   * @param {string} id
   * @returns {{jdText:string,postedAt:string|null}|null}
   */
  getReusableDetail(id) {
    return this.prepareCached(`
      SELECT jd_text AS jdText, posted_at AS postedAt FROM jobs
      WHERE id = ?
        AND length(trim(coalesce(jd_text, ''))) >= 200
    `).get(id) ?? null;
  }

  /**
   * @deprecated Use {@link getReusableDetail}. Kept so an external caller that
   * still asks for the Workday-only form keeps working.
   * @param {string} id
   * @returns {{jdText:string,postedAt:string|null}|null}
   */
  getReusableWorkdayDetail(id) {
    return this.getReusableDetail(id);
  }

  /**
   * @param {object} [filter]
   * @param {string} [filter.tier]
   * @param {string} [filter.status]
   * @returns {object[]}
   */
  listJobs({ tier, status, mode = 'all', query = null } = {}) {
    const clauses = [];
    const params = [];
    if (tier) { clauses.push('tier = ?'); params.push(tier); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    // Defaults to 'all', unlike every other read here, because this is the raw
    // whole-table accessor its existing callers already expect. It takes the
    // option so a caller that DOES need one search's rows can say so and be
    // obeyed — passing `mode` to a method that silently ignored it is exactly
    // how a scoping bug hides.
    const clause = this._modeClause(mode, query);
    if (clause.sql) { clauses.push(clause.sql); params.push(...clause.params); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM jobs${where} ORDER BY score DESC`).all(...params);
  }

  /**
   * Ids of every job a re-score could touch, cheapest possible read.
   *
   * Re-scoring needs each row's jd_text, but it needs them ONE AT A TIME. Doing
   * `SELECT *` up front materialized the entire corpus (~150 MB of JD text at
   * 32k rows) in memory before the first row was scored. Fetching ids first and
   * then loading each row on demand keeps peak memory flat and lets the loop
   * yield to the event loop between rows.
   *
   * @returns {string[]}
   */
  listJobIds({ mode = 'profile', query = null } = {}) {
    const clause = this._modeClause(mode, query);
    return this.db.prepare(
      `SELECT id FROM jobs${whereMode(clause)} ORDER BY score DESC`,
    ).all(...clause.params).map((r) => r.id);
  }

  /**
   * Every job WITHOUT the jd_text column. jd_text dominates row size (~8 KB
   * avg on real data — ~200 MB across 25k jobs), and the dashboard board/stats
   * never render it (job detail loads it via getJob). Excluding it cuts each
   * full-table decoration pass from hundreds of MB of I/O to a few MB.
   * @returns {object[]} jobs-table rows minus jd_text
   */
  listJobsSummary({ mode = 'profile', query = null } = {}) {
    const clause = this._modeClause(mode, query);
    return this.db.prepare(
      `SELECT ${this._summaryColumns} FROM jobs${whereMode(clause)} ORDER BY score DESC`,
    ).all(...clause.params);
  }

  /**
   * Summary rows that carry a generated document (tailored resume, cover
   * letter or packet), every discovery mode — the Documents view and the
   * master-resume staleness count.
   *
   * Both used to decorate or scan the WHOLE table to find the few hundred rows
   * with a file on disk; measured live that was 897 ms and 785 ms per request.
   * @returns {object[]}
   */
  listDocumentJobs() {
    return this.prepareCached(`SELECT ${this._summaryColumns} FROM jobs
      WHERE ${DOCUMENT_ROW_PREDICATE}`).all();
  }

  /**
   * Recorded assist blockers of every row the board shows as needing help
   * (blocked / failed / cancelled, not submitted or closed by the user).
   * A few dozen rows found through idx_jobs_status — the stats scan never
   * reads assist_blockers, and adding it there would break the covering index.
   * @returns {{id: string, status: string, assist_blockers: string|null}[]}
   */
  listAttentionBlockers({ mode = 'profile', query = null } = {}) {
    const clause = this._modeClause(mode, query);
    return this.prepareCached(`SELECT id, status, assist_blockers FROM jobs
      WHERE status IN ('assist_blocked', 'failed', 'cancelled')
        AND COALESCE(applied, 0) <> 1
        AND (user_decision IS NULL OR user_decision NOT IN ('rejected', 'archived'))${whereMode(clause, 'AND')}`)
      .all(...clause.params);
  }

  /** Total rows in the jobs table, within one discovery mode. */
  countJobs({ mode = 'profile', query = null } = {}) {
    const clause = this._modeClause(mode, query);
    return this.prepareCached(
      `SELECT COUNT(*) AS c FROM jobs${whereMode(clause)}`,
    ).get(...clause.params).c ?? 0;
  }

  /**
   * The saved role searches that still have rows, newest first.
   * @returns {{query: string, jobs: number, lastFoundAt: string}[]}
   */
  listRoleSearches() {
    return this.prepareCached(`SELECT search_query AS query, COUNT(*) AS jobs,
        MAX(created_at) AS lastFoundAt
      FROM jobs
      WHERE discovery_mode = 'role_search' AND search_query IS NOT NULL
      GROUP BY search_query ORDER BY lastFoundAt DESC`).all();
  }

  /**
   * Clear one role search — without destroying anything the user invested in.
   *
   * This used to DELETE every row the search produced, including a job the
   * user had since applied to, shortlisted/rejected, prepared a packet for or
   * queued for approval — erasing their application history and orphaning the
   * approval row and packet files that pointed at it. Those rows are now
   * RE-OWNED by the personalized board (discovery_mode = 'profile'), which is
   * where a job the user acted on belongs anyway; only untouched rows are
   * deleted, together with their now-orphaned events, in one transaction.
   *
   * @param {string} query
   * @returns {number} rows deleted (rows kept are left in `lastRoleSearchKept`)
   */
  deleteRoleSearch(query) {
    const q = String(query);
    const PROTECTED = `(COALESCE(applied, 0) = 1 OR user_decision IS NOT NULL
        OR application_packet_path IS NOT NULL
        OR EXISTS (SELECT 1 FROM approval_queue aq WHERE aq.job_id = jobs.id))`;
    const SCOPE = "discovery_mode = 'role_search' AND search_query = ?";
    return this.transaction(() => {
      const kept = this.db.prepare(
        `UPDATE jobs SET discovery_mode = 'profile', search_query = NULL, updated_at = ?
          WHERE ${SCOPE} AND ${PROTECTED}`,
      ).run(nowIso(), q).changes ?? 0;
      this.db.prepare(
        `DELETE FROM application_events WHERE job_id IN (SELECT id FROM jobs WHERE ${SCOPE})`,
      ).run(q);
      const removed = this.db.prepare(`DELETE FROM jobs WHERE ${SCOPE}`).run(q).changes ?? 0;
      this.lastRoleSearchKept = Number(kept);
      return Number(removed);
    });
  }

  /**
   * ONE PAGE of summary rows, ordered and limited BY SQLITE.
   *
   * Why this exists: the board read every row, decorated every row, sorted, and
   * then returned a hundred. Measured on this 111,108-row table, the unfiltered
   * "all jobs" view cost 5.8 s of blocked event loop and ~640 MB of resident
   * memory to produce a 100-row response — 0.8 s of it the read, the rest
   * decorating 111,008 rows nobody would see. While that ran, every other
   * request on this single-threaded server waited, including the ones that
   * cancel a run.
   *
   * Only usable when NO predicate needs a decorated field, which the caller
   * decides (see `boardPage`). Ordering is restricted to an allowlist of raw
   * columns so the clause can never be caller-controlled text, and `id` is
   * appended as a tiebreaker: without it SQLite may order rows with equal
   * scores differently between two LIMIT/OFFSET queries, which is how a paged
   * list silently repeats one row and skips another.
   *
   * @param {object} [options]
   * @param {string} [options.orderBy] one of SUMMARY_PAGE_ORDERS
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {object[]}
   */
  listJobsSummaryPage({ orderBy = 'score', limit = 200, offset = 0, mode = 'profile', query = null } = {}) {
    const order = SUMMARY_PAGE_ORDERS[orderBy];
    if (!order) throw new Error(`unsupported page order "${orderBy}"`);
    const take = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
    const skip = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const clause = this._modeClause(mode, query);
    return this.prepareCached(
      `SELECT ${this._summaryColumns} FROM jobs${whereMode(clause)} ORDER BY ${order}, id LIMIT ? OFFSET ?`,
    ).all(...clause.params, take, skip);
  }

  /**
   * Every job, but only the columns dashboardStats reads (JOB_STATS_COLUMNS).
   * Same row count as listJobsSummary — stats counts the whole table — at a
   * fraction of the bytes read and strings allocated.
   * @returns {object[]}
   */
  listJobsForStats({ mode = 'profile', query = null } = {}) {
    const clause = this._modeClause(mode, query);
    return this.prepareCached(
      // No ORDER BY: every statistic is an order-insensitive count or max, and
      // asking for score order made SQLite either sort 120k rows or walk the
      // index in score order instead of seeking straight to this mode's range.
      `SELECT ${JOB_STATS_COLUMNS} FROM jobs${whereMode(clause)}`,
    ).all(...clause.params);
  }

  /**
   * Same as listJobsSummary, minus rows that are PROVABLY the derived status
   * `discarded` — which the default board hides anyway.
   *
   * Why this exists: on real data the discard pile dwarfs everything else
   * (measured: 99,532 of 101,620 rows). The board was reading and decorating
   * all 101,620 to render a page drawn from the ~2,088 that could actually
   * appear, costing ~5s of blocked event loop per cache miss — which is what
   * made every filter click and every row action feel frozen.
   *
   * The WHERE clause mirrors `deriveAppStatus` (dashboard/data.js) exactly for
   * this one subset, and is deliberately CONSERVATIVE: it excludes a row only
   * when every branch that could out-rank `discarded` is ruled out —
   *   applied != 1        (else SUBMITTED)
   *   user_decision NULL  (else ARCHIVED / REJECTED / SHORTLISTED)
   *   status = 'discarded' (so none of the assist/submit statuses apply, and it
   *                         is not 'unknown_date_review' -> DATE_UNCONFIRMED)
   *   no approval_queue row (else REJECTED / APPROVED / NEEDS_REVIEW)
   * Anything it cannot prove is discarded is KEPT, so callers still see a
   * superset of what they may display and apply their own predicates on top.
   * @returns {object[]} jobs-table rows minus jd_text, minus certain discards
   */
  listOpenJobsSummary({ mode = 'profile', query = null } = {}) {
    // Every comparison here must be NULL-SAFE. `status = 'discarded'` yields
    // NULL (not false) for a row whose status is NULL, and `NOT (NULL AND ...)`
    // is NULL, which WHERE treats as no-match — so the plain form silently DROPS
    // status-less rows from the board instead of keeping them. Caught by a
    // differential check against the live table; `IS` is SQLite's null-safe
    // equality, and the `applied` test spells out its own NULL case.
    // TWO PHASES, because asking for the predicate and the 40 columns at once
    // defeats the index that makes the predicate cheap.
    //
    // Selecting the wide column list forces SQLite to visit a row page for
    // every candidate, so it abandons the covering index and scans the table
    // via idx_jobs_score instead — reading all 383 MB of `jobs`, including
    // every inline jd_text the query never asked for. Measured: 21.1 seconds.
    //
    // Phase 1 asks ONLY for ids, which the covering index answers without
    // touching a single row (51 ms over 112,709 rows). Phase 2 then fetches
    // the wide columns for just the ~2,500 ids that survived — a few thousand
    // primary-key seeks rather than a whole-table read. Same rows, same order,
    // 1.6 s cold and 185 ms warm.
    const clause = this._modeClause(mode, query);
    const ids = this.prepareCached(`SELECT id FROM jobs
      WHERE NOT (
        status IS 'discarded'
        AND (applied IS NULL OR applied <> 1)
        AND user_decision IS NULL
        AND NOT EXISTS (SELECT 1 FROM approval_queue aq WHERE aq.job_id = jobs.id)
      )${whereMode(clause, 'AND')}`).all(...clause.params).map((r) => r.id);
    if (!ids.length) return [];
    return this.rowsByIds(ids)
      // Phase 2 returns rows in whatever order the chunks came back, so the
      // documented score-descending contract is restored here. Sorting a few
      // thousand already-loaded rows is microseconds; making SQLite do it was
      // what pulled the whole table through the score index in the first place.
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }

  /**
   * Fetch full summary rows for a set of ids, chunked to stay well inside
   * SQLite's bound-parameter ceiling.
   * @param {string[]} ids
   * @returns {object[]}
   */
  rowsByIds(ids = []) {
    if (!ids.length) return [];
    // ONE statement, one bound JSON array. The `IN (?,?,…)` form prepared a
    // new statement for every distinct chunk length and cached each forever —
    // the final partial chunk of every board read was a fresh SQL text — and
    // capped a call at the bound-parameter limit. `json_each` takes any length
    // through a single parameter, and the primary-key seeks are unchanged.
    return this.prepareCached(
      `SELECT ${this._summaryColumns} FROM jobs WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids));
  }

  /**
   * Every job that is, or has been, an APPLICATION: submitted, mid-fill,
   * prepared, or holding an approval row — whichever search found it, because
   * the Applications workspace is a record of the user's own work.
   *
   * Same two phases as listOpenJobsSummary: three index searches for ids
   * (idx_jobs_applied, idx_jobs_status, idx_approval_job), then primary-key
   * fetches. Measured on the live 125k-row store: well under 1 ms.
   * @returns {object[]}
   */
  listApplicationJobsSummary() {
    const ids = this.prepareCached(`SELECT id FROM jobs WHERE applied = 1
      UNION SELECT id FROM jobs WHERE status IN ('prepared', 'assist_started', 'assist_blocked',
        'ready_for_submit', 'submit_unverified', 'submitted', 'failed', 'cancelled')
      UNION SELECT job_id FROM approval_queue WHERE job_id IS NOT NULL`).all().map((r) => r.id);
    return this.rowsByIds(ids);
  }

  /**
   * Events of the given types for a set of jobs, oldest first (insertion
   * order breaks same-millisecond ties). Served by idx_events_job, so it never
   * scans the 75k-row event log.
   * @param {string[]} jobIds
   * @param {string[]} types
   * @returns {object[]}
   */
  listEventsForJobs(jobIds = [], types = []) {
    if (!jobIds.length || !types.length) return [];
    return this.prepareCached(`SELECT id, job_id, event_type, message, metadata, created_at
      FROM application_events
      WHERE job_id IN (SELECT value FROM json_each(?)) AND event_type IN (SELECT value FROM json_each(?))
      ORDER BY created_at, rowid`).all(JSON.stringify(jobIds), JSON.stringify(types));
  }

  /**
   * Record a USER decision on a job (dashboard actions). Decisions are the
   * human's own triage state — they never overwrite pipeline status.
   * @param {string} id job id
   * @param {'shortlisted'|'rejected'|'archived'|null} decision null clears it
   */
  setUserDecision(id, decision, { reason = null } = {}) {
    const allowed = new Set(['shortlisted', 'rejected', 'archived', null]);
    if (!allowed.has(decision)) {
      throw new Error(`invalid user decision: ${decision} (use shortlisted/rejected/archived/null)`);
    }
    if (this._hasDecisionReason) {
      this.db.prepare(
        'UPDATE jobs SET user_decision = ?, decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?',
      ).run(decision, decision ? nowIso() : null, decision ? reason : null, nowIso(), id);
    } else {
      this.db.prepare(
        'UPDATE jobs SET user_decision = ?, decided_at = ?, updated_at = ? WHERE id = ?',
      ).run(decision, decision ? nowIso() : null, nowIso(), id);
    }
    return this.getJob(id);
  }

  /**
   * Move a job to a new lifecycle status — the ONE door for status writes that
   * a human or an assist outcome causes.
   *
   * Status writes used to be bare upserts from half a dozen places, none of
   * which asked whether the move was legal, and none of which left a trace: a
   * submitted job could be "re-marked" unverified and silently stop counting as
   * an application. This reads the current status, asks lifecycle
   * `assertTransition`, writes the status plus any extra columns, and appends an
   * application_events row — all in one transaction.
   *
   * @param {string} id
   * @param {string} to a LIFECYCLE value
   * @param {object} [options]
   * @param {string} [options.reason] recorded on the event
   * @param {Record<string, any>} [options.patch] extra columns to write
   * @param {'system'|'human'} [options.actor] a human may report a submission from any
   *   non-terminal state (see lifecycle HUMAN_REACHABLE)
   * @returns {{id: string, from: string|null, to: string}}
   * @throws {Error} statusCode 404 for an unknown id, 409 for an illegal move
   */
  /**
   * Ids of every job in one lifecycle status (startup recovery).
   * @param {string} status
   * @returns {string[]}
   */
  jobIdsWithStatus(status) {
    return this.prepareCached('SELECT id FROM jobs WHERE status = ?').all(status).map((r) => r.id);
  }

  setJobStatus(id, to, { reason = '', patch = {}, actor = 'system' } = {}) {
    return this.transaction(() => {
      const current = this.prepareCached('SELECT status FROM jobs WHERE id = ?').get(id);
      if (!current) throw Object.assign(new Error(`unknown job id: ${id}`), { statusCode: 404 });
      const from = current.status ?? null;
      try { assertTransition(from, to, reason, { actor }); }
      catch (err) { throw Object.assign(err, { statusCode: 409 }); }
      this.upsertJob({ ...patch, id, status: to });
      if (from !== to) {
        this.insertEvent({
          id: randomUUID(), job_id: id, event_type: 'status_changed',
          message: `${from ?? '(none)'} -> ${to}${reason ? `: ${reason}` : ''}`,
          metadata: { from, to, reason: reason || null, actor },
        });
      }
      return { id, from, to };
    });
  }

  /**
   * Record whether a posting is still open at its source, and retire it from
   * the board when the employer has closed it.
   *
   * Only rows nobody has invested in are retired: a job you applied to, hold a
   * packet for, or shortlisted keeps its status and just carries the flag —
   * a closed posting you already applied to is normal, not a reason to hide
   * it. Everything else moves to `discarded` with an `expired:` reason through
   * setJobStatus, so the move is a legal, logged transition.
   *
   * @param {string} id
   * @param {{ state: 'open'|'closed'|'unknown', via?: string, checkedAt?: string }} check
   * @returns {{ id: string, state: string, retired: boolean }}
   */
  recordPostingCheck(id, { state, via = '', checkedAt = new Date().toISOString() } = {}) {
    const row = this.prepareCached(
      'SELECT status, applied, application_packet_path, user_decision FROM jobs WHERE id = ?',
    ).get(id);
    if (!row) return { id, state, retired: false };
    if (state !== 'open' && state !== 'closed') {
      // Unknown proves nothing either way; only note that we looked.
      this.prepareCached('UPDATE jobs SET link_checked_at = ? WHERE id = ?').run(checkedAt, id);
      return { id, state, retired: false };
    }
    const retireable = state === 'closed'
      && RETIREABLE_STATUSES.has(row.status)
      && Number(row.applied ?? 0) !== 1
      && !row.application_packet_path
      && !['shortlisted', 'approved'].includes(row.user_decision ?? '');
    // A closed posting with an unsubmitted packet: the packet can never be used
    // (the four "Retry auto-fill" jobs on 2026-09-23 included two of these).
    const deadPacket = state === 'closed'
      && Number(row.applied ?? 0) !== 1
      && Boolean(row.application_packet_path)
      && UNSUBMITTED_PACKET_STATUSES.has(row.status);
    if (deadPacket) {
      const out = this.supersedePacket(id, { reason: `the employer closed this posting${via ? ` (${via})` : ''}`, retire: true });
      this.prepareCached('UPDATE jobs SET link_state = ?, link_checked_at = ? WHERE id = ?').run(state, checkedAt, id);
      return { id, state, retired: out.action === 'retired' };
    }
    if (retireable) {
      this.setJobStatus(id, 'discarded', {
        reason: `expired: the employer closed this posting${via ? ` (${via})` : ''}`,
        patch: {
          discard_reason: `expired: the employer closed this posting (checked ${checkedAt.slice(0, 10)}${via ? `, ${via}` : ''})`,
          link_state: 'closed', link_checked_at: checkedAt,
        },
      });
      return { id, state, retired: true };
    }
    this.prepareCached('UPDATE jobs SET link_state = ?, link_checked_at = ? WHERE id = ?').run(state, checkedAt, id);
    return { id, state, retired: false };
  }

  /**
   * Open rows whose posting has not been checked recently, best-scored first.
   * @param {{ olderThan: string, limit?: number, sources?: string[] }} args
   */
  listPostingsToCheck({ olderThan, limit = 300 } = {}) {
    return this.db.prepare(`SELECT id, source, url, company, title FROM jobs
      WHERE status IN ('scored', 'needs_description', 'near_miss', 'queued', 'prepared',
                       'failed', 'assist_blocked', 'cancelled', 'skipped')
        AND COALESCE(applied, 0) = 0
        AND (link_checked_at IS NULL OR link_checked_at < ?)
      ORDER BY COALESCE(score, 0) DESC
      LIMIT ?`).all(olderThan, Math.max(1, Math.min(5000, Number(limit) || 300)));
  }

  /** @param {string} id */
  jobExists(id) {
    return this.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Count jobs applied inside a half-open [start, end) UTC window.
   *
   * The daily application cap needs the candidate's LOCAL day (see
   * src/domain/time.js localDayWindow): the UTC day reset the cap at 8 pm for
   * a US Eastern user, mid-session. A range over ISO strings also avoids
   * running substr() on every applied row.
   * @param {string} start ISO timestamp (inclusive)
   * @param {string} end ISO timestamp (exclusive)
   */
  countAppliedBetween(start, end) {
    const row = this.prepareCached(
      'SELECT COUNT(*) AS c FROM jobs WHERE applied = 1 AND applied_at >= ? AND applied_at < ?',
    ).get(String(start), String(end));
    return row?.c ?? 0;
  }

  /**
   * Jobs applied on the candidate's LOCAL calendar day containing `now` — what
   * the daily application cap means by "today".
   * @param {Date} [now]
   * @param {string|null} [timeZone] IANA zone (candidate.location.timezone); null = UTC day
   * @returns {number}
   */
  countAppliedOnLocalDay(now = new Date(), timeZone = null) {
    const { start, end } = localDayWindow(now instanceof Date ? now : new Date(now), timeZone);
    return this.countAppliedBetween(start, end);
  }

  /**
   * Count jobs applied on a given ISO date (YYYY-MM-DD prefix) — the UTC day.
   * @deprecated use countAppliedBetween with a local-day window.
   */
  countAppliedOn(isoDatePrefix) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE applied = 1 AND substr(applied_at,1,10) = ?")
      .get(isoDatePrefix);
    return row?.c ?? 0;
  }

  /** @param {Record<string, any>} row */
  insertRunLog(row) {
    // Every real run_log column is writable — the counter list was hardcoded,
    // so jobs_new / jobs_discarded_stale / … were silently dropped on insert.
    const present = this._runLogColumns().filter((c) => row[c] !== undefined);
    const params = {};
    for (const c of present) params[c] = toText(row[c]);
    this.db.prepare(
      `INSERT INTO run_log (${present.join(', ')}) VALUES (${present.map((c) => `@${c}`).join(', ')})`,
    ).run(params);
  }

  /**
   * Update a run_log row, INSERTING it if no row exists for this run id.
   *
   * It used to be a bare UPDATE. The dashboard — the primary UI — opened its
   * runs with its own `startRun()` and never called `logger.startRun()`, so the
   * row was never inserted and every `UPDATE ... WHERE run_id = ?` matched
   * nothing. Each run's counters, duration and errors were silently discarded:
   * `SELECT COUNT(*) FROM run_log` returned 0 against 101,857 jobs and six
   * recorded `run_end` events. Upserting means a missing opening row costs the
   * end of the record, never the whole thing.
   *
   * @param {string} runId
   * @param {Record<string, any>} patch
   */
  updateRunLog(runId, patch) {
    const known = new Set(this._runLogColumns());
    const cols = Object.keys(patch).filter((c) => known.has(c) && c !== 'run_id' && patch[c] !== undefined);
    if (cols.length === 0) return;
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    const params = { run_id: runId };
    for (const c of cols) params[c] = toText(patch[c]);
    const result = this.db.prepare(`UPDATE run_log SET ${set} WHERE run_id = @run_id`).run(params);
    if (Number(result?.changes ?? 0) > 0) return;
    // No opening row. Recreate it only when the caller KNOWS what kind of run
    // this was. The pipeline's endRun used to land here with the dashboard
    // SESSION's run id and no mode, inventing a mode='unknown' row that then
    // absorbed the counters of every later run in the session. A phantom row
    // is worse than a missing one, so without a mode it is reported, not made.
    if (!patch.mode) {
      this.onWarning?.(`run_log: no run "${runId}" was started; its end counters were not recorded`);
      return;
    }
    this.insertRunLog({
      run_id: runId,
      started_at: patch.started_at ?? nowIso(),
      ...patch,
    });
  }

  /** run_log's real columns (cached; schema v2 adds some). */
  _runLogColumns() {
    if (!this._runLogCols) {
      this._runLogCols = this.db.prepare('PRAGMA table_info(run_log)').all().map((c) => c.name);
    }
    return this._runLogCols;
  }

  /**
   * Most recent runs, newest first.
   *
   * `run_log` was write-only: nothing in the codebase read it, so even once
   * rows existed a user still could not answer "what did last night's run do?".
   *
   * @param {object} [options]
   * @param {number} [options.limit=25]
   * @returns {object[]} run_log rows with a computed durationMs
   */
  listRunLogs({ limit = 25 } = {}) {
    const rows = this.db.prepare(
      'SELECT * FROM run_log ORDER BY started_at DESC, rowid DESC LIMIT ?',
    ).all(Math.max(1, Math.min(500, Number(limit) || 25)));
    return rows.map((row) => {
      const started = Date.parse(row.started_at ?? '');
      const ended = Date.parse(row.ended_at ?? '');
      return {
        ...row,
        durationMs: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null,
      };
    });
  }

  /** @param {string} runId */
  getRunLog(runId) {
    return this.db.prepare('SELECT * FROM run_log WHERE run_id = ?').get(runId) ?? null;
  }

  /**
   * Close run_log rows that a previous process opened and never ended.
   *
   * `endRun` closes a row on the happy path only, so a crash, a Ctrl-C or a
   * killed terminal leaves `ended_at` NULL forever. Such a row is
   * indistinguishable from a run that is still going, which quietly corrupts any
   * "when did we last complete a run" question asked of this table.
   *
   * `ended_at` is set to `started_at` rather than to now: the true end time is
   * unrecoverable (events carry no run_id), and stamping the current time would
   * invent a multi-day duration for a run that died in seconds. A zero-length
   * window plus the note below says "we do not know" without fabricating one.
   *
   * @param {object} [options]
   * @param {number} [options.olderThanMs] only reap rows older than this
   *   (default 6h — far beyond any real run, so a genuinely concurrent run is
   *   never closed out from under itself)
   * @param {Date} [options.now]
   * @returns {number} rows closed
   */
  reapAbandonedRuns({ olderThanMs = 6 * 60 * 60 * 1000, now = new Date() } = {}) {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
    const stale = this.db.prepare(
      'SELECT run_id, started_at FROM run_log WHERE ended_at IS NULL AND started_at < ?',
    ).all(cutoff);
    const note = 'run did not report an end (process exited before endRun); '
      + 'closed by a later run, so its duration is unknown';
    for (const row of stale) {
      this.db.prepare(
        'UPDATE run_log SET ended_at = @ended_at, errors = @errors WHERE run_id = @run_id',
      ).run({ run_id: row.run_id, ended_at: row.started_at, errors: note });
    }
    return stale.length;
  }

  /** @param {Record<string, any>} event */
  insertEvent(event) {
    this.db.prepare(
      `INSERT INTO application_events (id, job_id, event_type, message, metadata, created_at)
       VALUES (@id, @job_id, @event_type, @message, @metadata, @created_at)`,
    ).run({
      id: event.id,
      job_id: event.job_id ?? null,
      event_type: event.event_type,
      message: event.message ?? null,
      metadata: toText(event.metadata),
      created_at: event.created_at ?? nowIso(),
    });
  }

  /** @param {string} [jobId] */
  /** Submitted (or submitted-unverified) applications, for matching replies (P1-7). */
  listSubmittedJobs() {
    return this.db.prepare(
      `SELECT id, company, title, url, applied_at, status FROM jobs
       WHERE applied = 1 OR status IN ('submitted', 'submit_unverified')`,
    ).all();
  }

  listEvents(jobId) {
    if (jobId) {
      return this.db.prepare(
        'SELECT * FROM application_events WHERE job_id = ? ORDER BY created_at, rowid',
      ).all(jobId);
    }
    return this.db.prepare('SELECT * FROM application_events ORDER BY created_at, rowid').all();
  }

  /** @param {Record<string, any>} row */
  insertApproval(row) {
    this.db.prepare(
      `INSERT INTO approval_queue (id, job_id, packet_path, approval_status, approved_by_user, approved_at, created_at)
       VALUES (@id, @job_id, @packet_path, @approval_status, @approved_by_user, @approved_at, @created_at)`,
    ).run({
      id: row.id,
      job_id: row.job_id ?? null,
      packet_path: row.packet_path ?? null,
      approval_status: row.approval_status ?? 'pending',
      approved_by_user: row.approved_by_user ? 1 : 0,
      approved_at: row.approved_at ?? null,
      created_at: row.created_at ?? nowIso(),
    });
  }

  /** @param {object} [filter] @param {string} [filter.status] */
  listApprovals({ status } = {}) {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM approval_queue WHERE approval_status = ? ORDER BY created_at',
      ).all(status);
    }
    return this.db.prepare('SELECT * FROM approval_queue ORDER BY created_at').all();
  }

  /**
   * Update an approval row's status (used by the human approval queue).
   * @param {string} id approval id
   * @param {object} fields
   * @param {string} fields.approval_status
   * @param {number} [fields.approved_by_user]
   * @param {string|null} [fields.approved_at]
   */
  updateApprovalStatus(id, { approval_status, approved_by_user = 0, approved_at = null }) {
    this.db.prepare(
      `UPDATE approval_queue
         SET approval_status = @approval_status,
             approved_by_user = @approved_by_user,
             approved_at = @approved_at
       WHERE id = @id`,
    ).run({
      id,
      approval_status,
      approved_by_user: approved_by_user ? 1 : 0,
      approved_at,
    });
  }

  /**
   * Withdraw a packet that can no longer be used, and put the job back where a
   * fresh one can be prepared.
   *
   * Two ways a packet goes bad after approval: it was built for ANOTHER profile
   * (the template "Jane Doe", or a profile since switched away from — every
   * fill path now refuses those), or its file is gone. Leaving it approved kept
   * the job on Today as "Retry auto-fill" forever, a button that could only
   * fail. Rejecting the approval instead would read on the board as if the
   * user had rejected the JOB, which they did not.
   *
   * So: the approval row is removed (with an event recording why), the
   * pointers to the old documents are cleared (the files stay on disk), and
   * the job returns to `queued` + shortlisted — the user already chose it once.
   * A closed posting is retired instead: nothing can be applied to there.
   *
   * @param {string} jobId
   * @param {{ reason: string, retire?: boolean }} options
   * @returns {{ id: string, action: 'requeued'|'retired'|'skipped' }}
   */
  supersedePacket(jobId, { reason, retire = false } = {}) {
    return this.transaction(() => {
      const job = this.prepareCached(
        'SELECT status, applied, user_decision FROM jobs WHERE id = ?',
      ).get(jobId);
      // Never touch a submission, or a form the human may be finishing.
      if (!job || Number(job.applied) === 1
        || ['submitted', 'submit_unverified', 'ready_for_submit', 'assist_started'].includes(job.status)) {
        return { id: jobId, action: 'skipped' };
      }
      this.prepareCached('DELETE FROM approval_queue WHERE job_id = ?').run(jobId);
      const cleared = {
        application_packet_path: null, resume_path: null, resume_docx_path: null, resume_pdf_path: null,
        cover_letter_path: null, output_folder_path: null, prepared_at: null, assist_blockers: null,
      };
      const now = new Date().toISOString();
      if (retire) {
        this.upsertJob({
          id: jobId, ...cleared, status: 'discarded',
          discard_reason: `expired: the employer closed this posting (checked ${now.slice(0, 10)})`,
        });
      } else {
        this.upsertJob({
          id: jobId, ...cleared, status: 'queued',
          user_decision: job.user_decision === 'rejected' || job.user_decision === 'archived'
            ? job.user_decision : 'shortlisted',
        });
      }
      this.insertEvent({
        id: randomUUID(), job_id: jobId, event_type: 'packet_superseded',
        message: `${retire ? 'retired' : 'returned to prepare'}: ${reason}`,
        metadata: { from: job.status, reason, retire },
      });
      return { id: jobId, action: retire ? 'retired' : 'requeued' };
    });
  }

  /** @param {string} id @returns {object|undefined} */
  getApproval(id) {
    return this.db.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id);
  }

  /**
   * Most recent approval row for a given job (used to de-duplicate the queue).
   * @param {string} jobId
   * @returns {object|undefined}
   */
  getApprovalByJob(jobId) {
    return this.db.prepare(
      'SELECT * FROM approval_queue WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(jobId);
  }

  /**
   * Repoint an existing approval row at a freshly prepared packet and reset it
   * for review. Used when a job is re-prepared so the queue updates in place
   * instead of accumulating duplicates.
   * @param {string} id approval id
   * @param {object} fields
   * @param {string} fields.packet_path
   * @param {string} fields.approval_status
   */
  updateApprovalPacket(id, { packet_path, approval_status }) {
    this.db.prepare(
      `UPDATE approval_queue
         SET packet_path = @packet_path,
             approval_status = @approval_status,
             approved_by_user = 0,
             approved_at = NULL
       WHERE id = @id`,
    ).run({ id, packet_path, approval_status });
  }
}
