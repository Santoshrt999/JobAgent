/**
 * One-file export and import of everything personal in a JobAgent folder
 * (P1-6): every job-store database (the default one and each profile's), the
 * personal config files, and the master resumes with their kept versions.
 *
 * The bundle is itself a SQLite file (`.jobagent`):
 *   bundle_meta(key, value)                      format, versions, when
 *   bundle_files(path, kind, size, sha256)       one row per stored file
 *   bundle_chunks(path, seq, bytes)              the content, in 8 MB pieces
 * Chunking keeps memory flat for a store of hundreds of MB. Databases are
 * copied with VACUUM INTO first, so the export is consistent even while the
 * dashboard runs.
 *
 * Never included: .env (API keys), the dashboard access token, logs, generated
 * application documents (they can be regenerated) and backups.
 *
 * Optional encryption (`passphrase`): the finished bundle is encrypted with
 * AES-256-GCM under a scrypt-derived key, as a stream:
 *   "JOBAGENT-ENC1\n" | salt(16) | iv(12) | ciphertext | tag(16)
 *
 * Import validates every path against an allow-list, checks every sha256, and
 * (with apply) backs up what it is about to replace first.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';

import { backupAll, backupStamp, databaseFiles, snapshotDatabase } from './backup.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const BUNDLE_FORMAT = 'jobagent-bundle';
export const BUNDLE_FORMAT_VERSION = 1;
const CHUNK_BYTES = 8 * 1024 * 1024;
const ENC_MAGIC = Buffer.from('JOBAGENT-ENC1\n');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Personal config files, relative to the root. */
const CONFIG_FILES = [
  'config/candidate.json', 'config/screening_answers.json', 'config/cover_letter.json',
  'config/scoring.json', 'config/exclusions.json', 'data/settings.json',
];

/**
 * Paths an import may write. Anything else in a bundle is refused, so a
 * crafted bundle cannot write outside these places (no "..", no absolute paths).
 */
const ALLOWED = [
  /^config\/(candidate|screening_answers|cover_letter|scoring|exclusions)\.json$/,
  /^config\/profiles\/[A-Za-z0-9_.-]+\.json$/,
  /^data\/settings\.json$/,
  /^data\/applied_jobs\.db$/,
  /^data\/profiles\/[A-Za-z0-9_-]+\/applied_jobs\.db$/,
  /^resumes\/base\/(MASTER_RESUME\.docx|history\/[A-Za-z0-9_. -]+\.docx)$/,
  /^resumes\/profiles\/[A-Za-z0-9_-]+\/(MASTER_RESUME\.docx|history\/[A-Za-z0-9_. -]+\.docx)$/,
];

export function isAllowedBundlePath(p) {
  const s = String(p ?? '');
  return !s.includes('..') && !s.startsWith('/') && !s.includes('\\') && ALLOWED.some((re) => re.test(s));
}

const toPosix = (p) => p.split(sep).join('/');

/** The personal (non-database) files under a root, as root-relative POSIX paths. */
export function personalFiles(root) {
  const out = CONFIG_FILES.filter((p) => existsSync(join(root, p)));
  const profiles = join(root, 'config', 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles).sort()) {
      if (name.endsWith('.json')) out.push(`config/profiles/${name}`);
    }
  }
  const resumeDirs = [join(root, 'resumes', 'base')];
  const rp = join(root, 'resumes', 'profiles');
  if (existsSync(rp)) for (const id of readdirSync(rp).sort()) resumeDirs.push(join(rp, id));
  for (const dir of resumeDirs) {
    const master = join(dir, 'MASTER_RESUME.docx');
    if (existsSync(master)) out.push(toPosix(relative(root, master)));
    const history = join(dir, 'history');
    if (existsSync(history)) {
      for (const name of readdirSync(history).sort()) {
        if (name.endsWith('.docx')) out.push(toPosix(relative(root, join(history, name))));
      }
    }
  }
  return out.filter(isAllowedBundlePath);
}

function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function storeFile(bundle, relPath, sourcePath, kind) {
  const insert = bundle.prepare('INSERT INTO bundle_chunks (path, seq, bytes) VALUES (?, ?, ?)');
  const fd = openSync(sourcePath, 'r');
  let seq = 0;
  const hash = createHash('sha256');
  let size = 0;
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const piece = Buffer.from(buf.subarray(0, n));
      hash.update(piece);
      size += n;
      insert.run(relPath, seq, piece);
      seq += 1;
    }
  } finally { closeSync(fd); }
  bundle.prepare('INSERT INTO bundle_files (path, kind, size, sha256) VALUES (?, ?, ?, ?)')
    .run(relPath, kind, size, hash.digest('hex'));
  return size;
}

function userVersion(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number(db.prepare('PRAGMA user_version').get().user_version) || 0; } finally { db.close(); }
}

/**
 * Write a bundle of everything personal under `root` to `outFile`.
 * @returns {Promise<{ file: string, files: number, databases: number, bytes: number, encrypted: boolean }>}
 */
export async function exportBundle(root, outFile, { passphrase = null, appVersion = null, now = new Date() } = {}) {
  const work = join(tmpdir(), `jobagent-export-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const plain = passphrase ? join(work, 'bundle.jobagent') : outFile;
  try {
    rmSync(plain, { force: true });
    mkdirSync(dirname(plain), { recursive: true });
    const bundle = new DatabaseSync(plain);
    let databases = 0; let files = 0; let bytes = 0;
    const versions = {};
    try {
      bundle.exec(`
        CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE bundle_files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
        CREATE TABLE bundle_chunks (path TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (path, seq));
      `);
      bundle.exec('BEGIN');
      for (const db of databaseFiles(root)) {
        const rel = toPosix(relative(root, db.path));
        const snap = join(work, `${databases}.db`);
        await snapshotDatabase(db.path, snap);
        versions[rel] = userVersion(snap);
        bytes += storeFile(bundle, rel, snap, 'database');
        rmSync(snap, { force: true });
        databases += 1;
      }
      for (const rel of personalFiles(root)) {
        bytes += storeFile(bundle, rel, join(root, rel), 'file');
        files += 1;
      }
      const meta = bundle.prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)');
      meta.run('format', BUNDLE_FORMAT);
      meta.run('format_version', String(BUNDLE_FORMAT_VERSION));
      meta.run('created_at', now.toISOString());
      meta.run('app_version', String(appVersion ?? ''));
      meta.run('schema_versions', JSON.stringify(versions));
      bundle.exec('COMMIT');
    } finally {
      bundle.close();
    }
    if (passphrase) {
      mkdirSync(dirname(outFile), { recursive: true });
      await encryptFile(plain, outFile, passphrase);
    }
    return { file: outFile, files, databases, bytes, encrypted: Boolean(passphrase) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function encryptFile(src, dest, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(String(passphrase), salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([ENC_MAGIC, salt, iv]));
  await pipeline(createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

export function isEncryptedBundle(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(ENC_MAGIC.length);
    readSync(fd, head, 0, head.length, 0);
    return head.equals(ENC_MAGIC);
  } finally { closeSync(fd); }
}

async function decryptFile(src, dest, passphrase) {
  const size = statSync(src).size;
  const headerLen = ENC_MAGIC.length + 16 + 12;
  if (size < headerLen + 16) throw new Error('this encrypted bundle is truncated');
  const fd = openSync(src, 'r');
  const header = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(16);
  try {
    readSync(fd, header, 0, headerLen, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally { closeSync(fd); }
  const salt = header.subarray(ENC_MAGIC.length, ENC_MAGIC.length + 16);
  const iv = header.subarray(ENC_MAGIC.length + 16);
  const key = scryptSync(String(passphrase), salt, 32, SCRYPT);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(src, { start: headerLen, end: size - 17 }), decipher, createWriteStream(dest));
  } catch {
    rmSync(dest, { force: true });
    throw new Error('could not decrypt the bundle: wrong passphrase, or the file was changed');
  }
}

/**
 * Open a bundle (decrypting to a temp file when needed) and describe it.
 * The caller must call `close()`.
 */
export async function openBundle(file, { passphrase = null } = {}) {
  let path = file;
  let temp = null;
  if (isEncryptedBundle(file)) {
    if (!passphrase) throw new Error('this bundle is encrypted: give its passphrase');
    temp = join(tmpdir(), `jobagent-import-${process.pid}-${Date.now()}.jobagent`);
    await decryptFile(file, temp, passphrase);
    path = temp;
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM bundle_meta').all().map((r) => [r.key, r.value]));
    if (meta.format !== BUNDLE_FORMAT) throw new Error('this is not a JobAgent export');
    if (Number(meta.format_version) > BUNDLE_FORMAT_VERSION) {
      throw new Error(`this export (format ${meta.format_version}) is newer than this JobAgent; update JobAgent first`);
    }
    const files = db.prepare('SELECT path, kind, size, sha256 FROM bundle_files ORDER BY path').all()
      .map((r) => ({ path: r.path, kind: r.kind, size: Number(r.size), sha256: r.sha256 }));
    const bad = files.filter((f) => !isAllowedBundlePath(f.path));
    if (bad.length) throw new Error(`this export contains paths JobAgent will not write: ${bad.map((f) => f.path).join(', ')}`);
    return {
      meta: { ...meta, schema_versions: JSON.parse(meta.schema_versions ?? '{}') },
      files,
      /** Write one stored file to `dest`, verifying its sha256. */
      extract(relPath, dest) {
        const entry = files.find((f) => f.path === relPath);
        if (!entry) throw new Error(`not in the export: ${relPath}`);
        mkdirSync(dirname(dest), { recursive: true });
        const fd = openSync(dest, 'w');
        const hash = createHash('sha256');
        try {
          for (const row of db.prepare('SELECT bytes FROM bundle_chunks WHERE path = ? ORDER BY seq').iterate(relPath)) {
            const piece = Buffer.from(row.bytes);
            hash.update(piece);
            writeSync(fd, piece);
          }
        } finally { closeSync(fd); }
        if (hash.digest('hex') !== entry.sha256) {
          rmSync(dest, { force: true });
          throw new Error(`${relPath} is damaged in the export (checksum mismatch)`);
        }
      },
      close() {
        db.close();
        if (temp) rmSync(temp, { force: true });
      },
    };
  } catch (err) {
    db?.close();
    if (temp) rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Plan (and with `apply`, perform) an import into `root`.
 * Applying first backs up every existing database (label `pre-import`) and
 * copies every file it will overwrite into data/backups/pre-import-<stamp>/.
 * Each file is written to a temp name and renamed into place; a database's
 * stale -wal/-shm companions are removed so SQLite cannot replay them.
 */
export async function importBundle(root, file, { passphrase = null, apply = false, latestSchema = Infinity, now = new Date() } = {}) {
  const bundle = await openBundle(file, { passphrase });
  try {
    const newer = Object.entries(bundle.meta.schema_versions).filter(([, v]) => v > latestSchema);
    if (newer.length) {
      throw new Error(`the export's database is newer than this JobAgent (schema ${newer[0][1]} > ${latestSchema}); update JobAgent first`);
    }
    const plan = bundle.files.map((f) => ({ ...f, replaces: existsSync(join(root, f.path)) }));
    if (!apply) return { applied: false, meta: bundle.meta, plan };

    // Verify everything into a staging folder before touching the workspace.
    const staging = join(root, 'data', `.import-staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      for (const f of plan) bundle.extract(f.path, join(staging, f.path));
      const backups = await backupAll(root, { label: 'pre-import', now });
      const keep = join(root, 'data', 'backups', `pre-import-${backupStamp(now)}`);
      for (const f of plan.filter((x) => x.replaces && x.kind === 'file')) {
        mkdirSync(dirname(join(keep, f.path)), { recursive: true });
        copyFileSync(join(root, f.path), join(keep, f.path));
      }
      for (const f of plan) {
        const target = join(root, f.path);
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.importing`;
        renameSync(join(staging, f.path), tmp);
        if (f.kind === 'database') {
          rmSync(`${target}-wal`, { force: true });
          rmSync(`${target}-shm`, { force: true });
        }
        renameSync(tmp, target);
      }
      return { applied: true, meta: bundle.meta, plan, backups: backups.length, keptFilesIn: plan.some((x) => x.replaces && x.kind === 'file') ? keep : null };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    bundle.close();
  }
}

/** Read a passphrase from a file (first line), for scripts. */
export function readPassphraseFile(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/)[0];
}
