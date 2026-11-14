/**
 * Worker thread for backups: copy a SQLite database with VACUUM INTO on its own
 * read-only connection, then check the copy. Runs off the main thread so a
 * large store (hundreds of MB) never stalls the dashboard while it is copied.
 */
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

try {
  const { src, dest } = workerData;
  const source = new DatabaseSync(src, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(dest, { readOnly: true });
  let integrity;
  try {
    integrity = copy.prepare('PRAGMA quick_check').get().quick_check;
  } finally {
    copy.close();
  }
  parentPort.postMessage({ ok: integrity === 'ok', integrity, bytes: statSync(dest).size });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
}
