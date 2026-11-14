/**
 * One dashboard per install (audit BUG-03).
 *
 * `npm run app` probed only the port it was asked for, and `npm run dashboard`
 * probed nothing, so the two launchers could serve the SAME config and
 * database from two ports at once. Each caches config and the database handle
 * in memory, so a profile switch in one tab left the other querying the old
 * person's database against the new person's files.
 *
 * The running server records `{ pid, port }` in data/dashboard.lock (root-level
 * data/, not per workspace: the config both servers would share is root-level).
 * A launcher that finds a LIVE holder reuses it or refuses; a lock left by a
 * crashed process (its pid is gone) is ignored and replaced.
 *
 * fs + path only, so the CLI can check it before opening the database.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';

/** @param {string} root */
export const lockPath = (root) => join(root, 'data', 'dashboard.lock');

/** Is `pid` a running process? EPERM means it exists but belongs to someone else. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/**
 * The live dashboard holding this install, or null.
 *
 * @param {string} root
 * @param {{alive?: (pid: number) => boolean, selfPid?: number}} [deps]
 * @returns {{pid: number, port: number, startedAt: string|null}|null}
 */
export function readLiveLock(root, { alive = pidAlive, selfPid = process.pid } = {}) {
  try {
    const path = lockPath(root);
    if (!existsSync(path)) return null;
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    const pid = Number(lock?.pid);
    const port = Number(lock?.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (pid === selfPid || !alive(pid)) return null;
    return { pid, port, startedAt: lock?.startedAt ?? null };
  } catch {
    return null; // unreadable lock: treat as absent; the port probe still guards
  }
}

/**
 * Record this process as the holder. Returns a release function that removes
 * the lock only while it is still ours.
 *
 * @param {string} root
 * @param {{port: number, pid?: number, now?: Date}} info
 * @returns {() => void}
 */
export function writeLock(root, { port, pid = process.pid, now = new Date() }) {
  const path = lockPath(root);
  writeFileAtomic(path, `${JSON.stringify({ pid, port, startedAt: now.toISOString() })}\n`);
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, 'utf8'));
      if (Number(current?.pid) === pid) rmSync(path, { force: true });
    } catch { /* already gone */ }
  };
}
