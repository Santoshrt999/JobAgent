/**
 * Is the running server older than the code on disk?
 *
 * The dashboard's page files are read from disk on every load, but the server
 * — and the auto-fill runner it starts — is whatever Node loaded at startup.
 * After an update the page looks new while Auto-fill still runs the old code
 * (2026-11-12: a fix to Oracle's privacy checkbox was on disk, the app had not
 * been restarted, and the run hit the very bug the fix removed). This module
 * notices that and the Today data carries a "restart to use the update"
 * notice.
 *
 * Only server-side JavaScript under src/ counts: src/dashboard/public is
 * served live, and Python helpers start fresh on every call.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const LIVE_DIRS = [join('dashboard', 'public')];

/**
 * Newest modification among the server's JavaScript files.
 * @param {object} [options]
 * @param {string} [options.root] the src/ folder
 * @returns {{ mtimeMs: number, file: string } | null}
 */
export function newestServerCode({ root = SRC } = {}) {
  let newest = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        if (!LIVE_DIRS.some((live) => rel === live || rel.startsWith(live + sep))) walk(path);
        continue;
      }
      if (!/\.(?:m?js)$/.test(entry.name)) continue;
      const { mtimeMs } = statSync(path);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { mtimeMs, file: rel };
    }
  };
  walk(root);
  return newest;
}

/**
 * A cached check: the folder is walked at most once per `ttlMs`.
 * @param {object} [options]
 * @param {number} [options.startedAt] when this server loaded its code
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 * @param {() => ({ mtimeMs: number, file: string } | null)} [options.scan]
 * @returns {() => ({ changedAt: string, file: string } | null)}
 */
export function createCodeFreshness({
  startedAt = Date.now(), ttlMs = 60_000, now = () => Date.now(), scan = () => newestServerCode(),
} = {}) {
  let cache = null;
  return function changedSinceStart() {
    if (cache && now() - cache.at < ttlMs) return cache.value;
    let value = null;
    try {
      const newest = scan();
      // A second of slack: files written while the server was starting up
      // are the code it loaded.
      if (newest && newest.mtimeMs > startedAt + 1000) {
        value = { changedAt: new Date(newest.mtimeMs).toISOString(), file: newest.file };
      }
    } catch { value = null; }
    cache = { at: now(), value };
    return value;
  };
}

/** The notice the page shows while the server is behind the code on disk. */
export function restartNotice(change) {
  if (!change) return null;
  return {
    code: 'restart_needed',
    severity: 'warn',
    message: 'JobAgent was updated after it started. Auto-fill is still running the old version until you restart it.',
    fix: 'Stop it (Ctrl+C in its terminal), then run `npm run app` again.',
  };
}
