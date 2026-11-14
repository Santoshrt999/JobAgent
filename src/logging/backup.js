// @ts-check
/**
 * Backups of the job store (P1-6).
 *
 * Every database (the default one and each profile's) is copied with SQLite's
 * VACUUM INTO, which writes a consistent, compact snapshot even while the
 * dashboard is using the database, then checked with PRAGMA quick_check.
 * Copies live next to the database they come from, in a `backups/` folder:
 *
 *   data/backups/applied_jobs-<label>-<UTC stamp>.db
 *   data/profiles/<id>/backups/applied_jobs-<label>-<UTC stamp>.db
 *
 * Labels: `auto` (daily, rotated), `manual` (Back up now), `pre-migration`
 * (taken by openDatabase before a schema change), `pre-import`, `pre-prune`.
 * Only `auto` copies are rotated by age; every other label keeps its newest
 * KEEP_PER_LABEL copies. Backups contain all personal data and stay under the
 * gitignored data/ folder.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const KEEP_PER_LABEL = 5;
const NAME_RE = /^applied_jobs-([a-z][a-z-]*?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.db$/;

/** "2026-11-11T05:12:30.123Z" -> "2026-11-11T05-12-30Z" (safe on Windows). */
export function backupStamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export function parseBackupName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const iso = m[2].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  return { label: m[1], createdAt: new Date(iso) };
}

/** Every job-store database under a workspace root that exists on disk. */
export function databaseFiles(root) {
  const out = [];
  const main = join(root, 'data', 'applied_jobs.db');
  if (existsSync(main)) out.push({ workspaceId: '', path: main });
  const profilesDir = join(root, 'data', 'profiles');
  if (existsSync(profilesDir)) {
    for (const id of readdirSync(profilesDir).sort()) {
      const p = join(profilesDir, id, 'applied_jobs.db');
      if (/^[A-Za-z0-9_-]+$/.test(id) && existsSync(p)) out.push({ workspaceId: id, path: p });
    }
  }
  return out;
}

/** Copy one database in a worker thread; resolves { path, bytes, ok, integrity }. */
export function snapshotDatabase(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./vacuumWorker.js', import.meta.url), { workerData: { src, dest } });
    worker.once('message', (msg) => {
      if (msg.error) { rmSync(dest, { force: true }); reject(new Error(`backup of ${basename(src)} failed: ${msg.error}`)); return; }
      if (!msg.ok) { rmSync(dest, { force: true }); reject(new Error(`backup of ${basename(src)} failed its integrity check: ${msg.integrity}`)); return; }
      resolve({ path: dest, bytes: msg.bytes, ok: true, integrity: msg.integrity });
    });
    worker.once('error', reject);
  });
}

/**
 * Back up every database of a workspace root.
 * @returns {Promise<Array<{workspaceId: string, path: string, bytes: number}>>}
 */
export async function backupAll(root, { label = 'manual', now = new Date() } = {}) {
  if (!/^[a-z][a-z-]*$/.test(label)) throw new Error(`invalid backup label: ${label}`);
  const results = [];
  for (const db of databaseFiles(root)) {
    const dest = join(dirname(db.path), 'backups', `applied_jobs-${label}-${backupStamp(now)}.db`);
    const copy = await snapshotDatabase(db.path, dest);
    results.push({ workspaceId: db.workspaceId, path: copy.path, bytes: copy.bytes });
    rotateBackups(dirname(dest), { now });
  }
  return results;
}

/** Backups in one folder, newest first. */
export function listBackupsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, parsed: parseBackupName(name) }))
    .filter((x) => x.parsed)
    .map(({ name, parsed }) => ({
      file: join(dir, name), name, label: parsed.label, createdAt: parsed.createdAt.toISOString(),
      bytes: statSync(join(dir, name)).size,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every backup under a workspace root, newest first. */
export function listBackups(root) {
  const dirs = [join(root, 'data', 'backups')];
  const profilesDir = join(root, 'data', 'profiles');
  if (existsSync(profilesDir)) {
    for (const id of readdirSync(profilesDir)) dirs.push(join(profilesDir, id, 'backups'));
  }
  return dirs.flatMap((d) => listBackupsIn(d)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Which backups to delete (pure). `auto` copies: keep the newest per day for
 * `keepDaily` days and the newest per ISO week for `keepWeekly` more weeks.
 * Other labels: keep the newest KEEP_PER_LABEL each.
 */
export function planRotation(backups, { keepDaily = 3, keepWeekly = 2, now = new Date() } = {}) {
  const remove = [];
  const byLabel = new Map();
  for (const b of backups) {
    if (!byLabel.has(b.label)) byLabel.set(b.label, []);
    byLabel.get(b.label).push(b);
  }
  for (const [label, list] of byLabel) {
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (label !== 'auto') {
      remove.push(...sorted.slice(KEEP_PER_LABEL));
      continue;
    }
    const keptDays = new Set(); const keptWeeks = new Set();
    for (const b of sorted) {
      const t = new Date(b.createdAt);
      const ageDays = (now.getTime() - t.getTime()) / 86_400_000;
      const day = b.createdAt.slice(0, 10);
      const week = isoWeek(t);
      if (ageDays < keepDaily && !keptDays.has(day)) { keptDays.add(day); continue; }
      // Older copies: the newest of each ISO week, at most `keepWeekly` weeks.
      if (ageDays >= keepDaily && keptWeeks.size < keepWeekly && !keptWeeks.has(week)) { keptWeeks.add(week); continue; }
      remove.push(b);
    }
  }
  return remove;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)}`;
}

export function rotateBackups(dir, options = {}) {
  const env = options.env ?? process.env;
  const keepDaily = Number(env.JOB_AGENT_BACKUP_KEEP_DAILY ?? 3) || 3;
  const keepWeekly = Number(env.JOB_AGENT_BACKUP_KEEP_WEEKLY ?? 2) || 0;
  const doomed = planRotation(listBackupsIn(dir), { keepDaily, keepWeekly, now: options.now ?? new Date() });
  for (const b of doomed) rmSync(b.file, { force: true });
  return doomed.map((b) => b.name);
}

/** The newest `auto` backup time across the root, or null. */
export function lastAutoBackupAt(root) {
  const auto = listBackups(root).find((b) => b.label === 'auto');
  return auto ? auto.createdAt : null;
}

/** Take the daily `auto` backup when the last one is older than `minAgeHours`. */
export async function maybeAutoBackup(root, { now = new Date(), minAgeHours = 24 } = {}) {
  const last = lastAutoBackupAt(root);
  if (last && (now.getTime() - new Date(last).getTime()) < minAgeHours * 3_600_000) return { skipped: true, last };
  const made = await backupAll(root, { label: 'auto', now });
  return { skipped: false, made };
}
