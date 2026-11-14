/**
 * SQLite maintenance for data/applied_jobs.db.
 *
 * The dashboard checkpoints the WAL on every open, but a long-running reader
 * can still let it grow, and deleted rows leave free pages in the main file.
 * Run this occasionally (with the dashboard/watch STOPPED) to compact:
 *
 *   node scripts/dbMaintenance.mjs           # checkpoint + stats (safe, fast)
 *   node scripts/dbMaintenance.mjs --vacuum  # + full VACUUM (rewrites the file;
 *                                            #   can take a while on a large DB)
 *
 * Retention
 * ---------
 * `jd_text` is stored inline in the jobs table, and discarded rows keep their
 * full description forever. Measured on the live store: 288 MB of the 443 MB
 * file is jd_text, and 14,871 discarded, never-touched rows older than 30 days
 * account for 71 MB of it. Those descriptions cannot change any decision — the
 * row is already excluded, and re-discovery re-fetches what it needs.
 *
 *   node scripts/dbMaintenance.mjs --prune-descriptions           # DRY RUN, 60d
 *   node scripts/dbMaintenance.mjs --prune-descriptions=30        # DRY RUN, 30d
 *   node scripts/dbMaintenance.mjs --prune-descriptions=30 --apply
 *
 * application_events grows by one `score_explained` row per scored job per run
 * (and one `exclusion_matched` per excluded job); those are diagnostics, not
 * the audit trail. Only those two types are ever pruned:
 *
 *   node scripts/dbMaintenance.mjs --prune-events=30 [--apply]
 *
 * Nothing is changed without --apply. A description is only eligible when the
 * row is `discarded`, was never applied to, and carries no user decision — so
 * anything you shortlisted, rejected by hand, prepared or submitted keeps its JD.
 *
 * --apply and --vacuum REFUSE to run while a run holds data/.run.lock or the
 * dashboard answers on 127.0.0.1:4646 (override the port with --port=N, and the
 * database with --db=<path> for a scratch copy).
 */

import { createRequire } from 'node:module';
import { statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readRunLock, isPidAlive } from '../src/utils/runLock.js';

// Same createRequire pattern as src/logging/db.js: a static `import ... from
// 'node:sqlite'` is resolved eagerly by bundlers and test runners, which do not
// know the builtin and fail the whole module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * "Older than N days" as an ISO-8601 UTC string, the format every timestamp in
 * this database is written in (nowIso()). The old cutoff used
 * datetime('now', ?) — 'YYYY-MM-DD HH:MM:SS', with a SPACE — against values
 * with a 'T', so for rows on the cutoff day the string comparison was simply
 * wrong ('T' sorts after ' ').
 */
const CUTOFF_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)";

/** Event types that are diagnostics and may be pruned. */
export const PRUNABLE_EVENT_TYPES = Object.freeze(['score_explained', 'exclusion_matched']);

/**
 * Clear old, untouched discarded rows' descriptions.
 * @param {DatabaseSync} db
 * @param {{ days: number, apply: boolean }} options
 * @returns {{ eligible: number, bytes: number, cleared: number }}
 */
export function pruneDescriptions(db, { days = 60, apply = false } = {}) {
  // Deliberately narrow. `discarded` alone is not enough: a row the user later
  // shortlisted or rejected by hand is evidence about their preferences, and a
  // prepared or submitted row must keep the text its packet was built from.
  const WHERE = `
    WHERE status = 'discarded'
      AND COALESCE(applied, 0) = 0
      AND (user_decision IS NULL OR user_decision = '')
      AND application_packet_path IS NULL
      AND jd_text IS NOT NULL
      AND LENGTH(jd_text) > 0
      AND created_at < ${CUTOFF_SQL}`;
  const offset = `-${Math.max(1, Math.floor(days))} days`;
  const { n, bytes } = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(jd_text)), 0) AS bytes FROM jobs ${WHERE}`,
  ).get(offset);
  let cleared = 0;
  if (apply && n) {
    // summary_only marks the row as "we no longer hold the description", which
    // is exactly what the discovery path already means by it — so re-discovery
    // and `npm run enrich` treat a pruned row the same as a never-fetched one.
    cleared = Number(db.prepare(`UPDATE jobs SET jd_text = NULL, summary_only = 1 ${WHERE}`).run(offset).changes);
  }
  return { eligible: Number(n), bytes: Number(bytes), cleared };
}

/**
 * Delete diagnostic events (PRUNABLE_EVENT_TYPES only) older than N days.
 * @param {DatabaseSync} db
 * @param {{ days: number, apply: boolean }} options
 * @returns {{ eligible: number, deleted: number }}
 */
export function pruneEvents(db, { days = 30, apply = false } = {}) {
  const types = PRUNABLE_EVENT_TYPES.map(() => '?').join(', ');
  const WHERE = `WHERE event_type IN (${types}) AND created_at < ${CUTOFF_SQL}`;
  const params = [...PRUNABLE_EVENT_TYPES, `-${Math.max(1, Math.floor(days))} days`];
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM application_events ${WHERE}`).get(...params);
  const deleted = apply && n
    ? Number(db.prepare(`DELETE FROM application_events ${WHERE}`).run(...params).changes) : 0;
  return { eligible: Number(n), deleted };
}

/**
 * Why a WRITE must not run now, or null when it is safe.
 *
 * Maintenance used to trust the comment "run with the dashboard stopped". A
 * VACUUM or bulk UPDATE under a live dashboard or CLI run either stalls it on
 * the busy timeout or fails half-way; now it checks both ways a writer can be
 * present.
 *
 * @param {object} args
 * @param {string} args.root project root
 * @param {number} [args.port=4646]
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<string|null>}
 */
export async function unsafeToWriteReason({ root, port = 4646, fetchImpl = fetch } = {}) {
  const holder = readRunLock(root);
  if (holder && isPidAlive(holder.pid)) {
    return `a ${holder.phase} run (${holder.owner}, pid ${holder.pid}) holds data/.run.lock`;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    // No access token: a running dashboard answers 401 without one, which is
    // all this needs, and the token is never sent to an unverified listener.
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/run/status`, { signal: controller.signal });
    clearTimeout(timer);
    // 401 is a dashboard that is up but locked (its access token, P1-5): it is
    // still holding the database, so writing now is just as unsafe.
    if (res.ok || res.status === 401) return `the dashboard is running on 127.0.0.1:${port} — stop it first`;
  } catch { /* nothing listening: safe */ }
  return null;
}

const mb = (p) => {
  try { return `${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`; } catch { return '—'; }
};

/** Parse `--name=value` from argv. */
const argValue = (argv, name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));

async function main(argv = process.argv.slice(2)) {
  const dbArg = argValue(argv, 'db');
  const dbPath = dbArg?.includes('=') ? resolve(dbArg.split('=')[1]) : join(ROOT, 'data', 'applied_jobs.db');
  const port = Number(argValue(argv, 'port')?.split('=')[1]) || 4646;
  const apply = argv.includes('--apply');
  const vacuum = argv.includes('--vacuum');

  if (!existsSync(dbPath)) {
    console.error(`no database at ${dbPath} — nothing to do`);
    process.exitCode = 1;
    return;
  }
  if (apply || vacuum) {
    const reason = await unsafeToWriteReason({ root: ROOT, port });
    if (reason) {
      console.error(`refusing to modify the database: ${reason}`);
      process.exitCode = 2;
      return;
    }
  }

  console.log(`db:  ${dbPath} (${mb(dbPath)})`);
  console.log(`wal: ${mb(`${dbPath}-wal`)}`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  console.log('checkpointing WAL…');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  console.log(`wal after checkpoint: ${mb(`${dbPath}-wal`)}`);

  const pruneArg = argValue(argv, 'prune-descriptions');
  if (pruneArg) {
    const days = Math.max(1, Number(pruneArg.split('=')[1]) || 60);
    const t0 = Date.now();
    const r = pruneDescriptions(db, { days, apply });
    console.log(`\nretention: ${r.eligible} discarded, untouched row(s) older than ${days}d `
      + `hold ${(r.bytes / 1024 / 1024).toFixed(1)} MB of jd_text`);
    if (!r.eligible) console.log('  nothing to prune');
    else if (!apply) console.log('  DRY RUN — re-run with --apply to clear them (add --vacuum to reclaim the space)');
    else console.log(`  cleared ${r.cleared} description(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const eventsArg = argValue(argv, 'prune-events');
  if (eventsArg) {
    const days = Math.max(1, Number(eventsArg.split('=')[1]) || 30);
    const r = pruneEvents(db, { days, apply });
    console.log(`\nevents: ${r.eligible} ${PRUNABLE_EVENT_TYPES.join('/')} event(s) older than ${days}d`);
    if (r.eligible && !apply) console.log('  DRY RUN — re-run with --apply to delete them');
    else if (apply) console.log(`  deleted ${r.deleted}`);
  }

  if (vacuum) {
    console.log('vacuuming (this rewrites the whole file — do not interrupt)…');
    const t0 = Date.now();
    db.exec('VACUUM;');
    console.log(`vacuum done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const jobs = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const events = db.prepare('SELECT COUNT(*) AS n FROM application_events').get().n;
  console.log(`rows: ${jobs} jobs, ${events} events`);
  db.close();
  console.log(`db after: ${mb(dbPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
