/**
 * Backups and one-file export/import (P1-6), on a throwaway workspace with a
 * real SQLite store: copies are consistent and checked, rotation keeps the
 * right set, export -> import round-trips every job, file and profile, and a
 * crafted or tampered bundle is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { backupAll, listBackups, maybeAutoBackup, parseBackupName, planRotation } from '../../src/logging/backup.js';
import { exportBundle, importBundle, isAllowedBundlePath, isEncryptedBundle, openBundle } from '../../src/logging/bundle.js';
import { MIGRATIONS, openDatabase } from '../../src/logging/db.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

let root;
function seedWorkspace(dir) {
  mkdirSync(join(dir, 'config', 'profiles'), { recursive: true });
  mkdirSync(join(dir, 'resumes', 'base', 'history'), { recursive: true });
  writeFileSync(join(dir, 'config', 'candidate.json'), JSON.stringify({ fullName: 'Test Person' }));
  writeFileSync(join(dir, 'config', 'profiles', 'alex.json'), JSON.stringify({ id: 'alex' }));
  writeFileSync(join(dir, 'resumes', 'base', 'MASTER_RESUME.docx'), Buffer.from('PK fake docx'));
  writeFileSync(join(dir, 'resumes', 'base', 'history', 'MASTER_RESUME-2026-01-01.docx'), Buffer.from('PK old'));
  writeFileSync(join(dir, '.env'), 'NVIDIA_API_KEY=secret');
  const main = openDatabase({ path: join(dir, 'data', 'applied_jobs.db') });
  for (let i = 0; i < 25; i += 1) main.upsertJob({ id: `j${i}`, company: `Co ${i}`, title: 'Data Engineer', url: `https://x/${i}` });
  main.close();
  const other = openDatabase({ path: join(dir, 'data', 'profiles', 'alex', 'applied_jobs.db') });
  other.upsertJob({ id: 'a1', company: 'Alex Co', title: 'Analyst', url: 'https://y/1' });
  other.close();
}
const countJobs = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n; } finally { db.close(); }
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bundle-')); seedWorkspace(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('backups', () => {
  it('copies every job list, consistent and checked, next to it', async () => {
    const made = await backupAll(root, { label: 'manual', now: new Date('2026-11-11T05:00:00Z') });
    expect(made.map((m) => m.workspaceId)).toEqual(['', 'alex']);
    expect(countJobs(made[0].path)).toBe(25);
    expect(countJobs(made[1].path)).toBe(1);
    expect(made[0].path).toMatch(/data[\\/]backups[\\/]applied_jobs-manual-2026-11-11T05-00-00Z\.db$/);
    expect(listBackups(root)).toHaveLength(2);
  });

  it('takes the daily backup only when the last is a day old', async () => {
    const t0 = new Date('2026-11-11T05:00:00Z');
    expect((await maybeAutoBackup(root, { now: t0 })).skipped).toBe(false);
    expect((await maybeAutoBackup(root, { now: new Date('2026-11-11T20:00:00Z') })).skipped).toBe(true);
    expect((await maybeAutoBackup(root, { now: new Date('2026-11-12T06:00:00Z') })).skipped).toBe(false);
  });

  it('rotates auto copies by day and week, and keeps 5 of every other label', () => {
    const now = new Date('2026-11-30T12:00:00Z');
    const auto = Array.from({ length: 30 }, (_, i) => ({
      name: `a${i}`, label: 'auto', createdAt: new Date(now - i * 86_400_000).toISOString(),
    }));
    const manual = Array.from({ length: 8 }, (_, i) => ({ name: `m${i}`, label: 'manual', createdAt: new Date(now - i * 3_600_000).toISOString() }));
    const doomed = new Set(planRotation([...auto, ...manual], { keepDaily: 3, keepWeekly: 2, now }).map((b) => b.name));
    const keptAuto = auto.filter((b) => !doomed.has(b.name)).map((b) => b.name);
    expect(keptAuto.slice(0, 3)).toEqual(['a0', 'a1', 'a2']); // three daily
    expect(keptAuto.length).toBeGreaterThanOrEqual(4);
    expect(keptAuto.length).toBeLessThanOrEqual(5); // plus at most two weekly
    expect(manual.filter((b) => !doomed.has(b.name))).toHaveLength(5);
  });

  it('parses only its own file names', () => {
    expect(parseBackupName('applied_jobs-pre-migration-2026-11-11T05-00-00Z.db')).toMatchObject({ label: 'pre-migration' });
    expect(parseBackupName('applied_jobs.pre-upgrade-2026-09-23.db')).toBeNull();
  });

  it('copies a store before migrating it (pre-migration backup)', () => {
    const path = join(root, 'data', 'applied_jobs.db');
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${LATEST - 1}`);
    raw.close();
    openDatabase({ path }).close();
    const pre = listBackups(root).filter((b) => b.label === 'pre-migration');
    expect(pre).toHaveLength(1);
    expect(countJobs(pre[0].file)).toBe(25);
    // Already current: no second copy.
    openDatabase({ path }).close();
    expect(listBackups(root).filter((b) => b.label === 'pre-migration')).toHaveLength(1);
  });
});

describe('one-file export and import', () => {
  it('round-trips every job list and personal file, and never includes .env', async () => {
    const file = join(root, 'exports', 'me.jobagent');
    const r = await exportBundle(root, file, { appVersion: '0.2.0' });
    expect(r).toMatchObject({ databases: 2, encrypted: false });
    const b = await openBundle(file);
    try {
      const paths = b.files.map((f) => f.path);
      expect(paths).toEqual(expect.arrayContaining([
        'data/applied_jobs.db', 'data/profiles/alex/applied_jobs.db', 'config/candidate.json',
        'config/profiles/alex.json', 'resumes/base/MASTER_RESUME.docx', 'resumes/base/history/MASTER_RESUME-2026-01-01.docx',
      ]));
      expect(paths.some((p) => p.includes('.env'))).toBe(false);
    } finally { b.close(); }

    const target = mkdtempSync(join(tmpdir(), 'bundle-target-'));
    try {
      const dry = await importBundle(target, file, { latestSchema: LATEST });
      expect(dry.applied).toBe(false);
      expect(existsSync(join(target, 'data', 'applied_jobs.db'))).toBe(false);
      const done = await importBundle(target, file, { apply: true, latestSchema: LATEST });
      expect(done.applied).toBe(true);
      expect(countJobs(join(target, 'data', 'applied_jobs.db'))).toBe(25);
      expect(countJobs(join(target, 'data', 'profiles', 'alex', 'applied_jobs.db'))).toBe(1);
      expect(readFileSync(join(target, 'config', 'candidate.json'), 'utf8')).toContain('Test Person');
      expect(readFileSync(join(target, 'resumes', 'base', 'MASTER_RESUME.docx')).toString()).toBe('PK fake docx');
    } finally { rmSync(target, { recursive: true, force: true }); }
  });

  it('backs up what it replaces before importing over an existing workspace', async () => {
    const file = join(root, 'exports', 'me.jobagent');
    await exportBundle(root, file);
    writeFileSync(join(root, 'config', 'candidate.json'), JSON.stringify({ fullName: 'Changed Later' }));
    const done = await importBundle(root, file, { apply: true, latestSchema: LATEST, now: new Date('2026-11-11T06:00:00Z') });
    expect(done.backups).toBe(2);
    expect(readFileSync(join(done.keptFilesIn, 'config', 'candidate.json'), 'utf8')).toContain('Changed Later');
    expect(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).toContain('Test Person');
  });

  it('encrypts with a passphrase and refuses the wrong one', async () => {
    const file = join(root, 'exports', 'secret.jobagent');
    await exportBundle(root, file, { passphrase: 'correct horse battery staple' });
    expect(isEncryptedBundle(file)).toBe(true);
    expect(readFileSync(file).includes(Buffer.from('Test Person'))).toBe(false);
    await expect(openBundle(file)).rejects.toThrow(/encrypted/);
    await expect(openBundle(file, { passphrase: 'wrong' })).rejects.toThrow(/wrong passphrase/);
    const b = await openBundle(file, { passphrase: 'correct horse battery staple' });
    expect(b.files.length).toBeGreaterThan(3);
    b.close();
  });

  it('refuses a bundle whose database is newer than this JobAgent', async () => {
    const file = join(root, 'exports', 'me.jobagent');
    await exportBundle(root, file);
    await expect(importBundle(root, file, { apply: true, latestSchema: LATEST - 1 })).rejects.toThrow(/newer than this JobAgent/);
  });

  it('refuses a crafted bundle that writes outside the allowed places, or a damaged one', async () => {
    for (const bad of ['../outside.json', '/etc/passwd', 'config/../.env', '.env', 'data/.dashboard-token', 'src/index.js', 'config\\candidate.json']) {
      expect(isAllowedBundlePath(bad), bad).toBe(false);
    }
    const file = join(root, 'exports', 'me.jobagent');
    await exportBundle(root, file);
    const db = new DatabaseSync(file);
    db.prepare("UPDATE bundle_files SET path = '../evil.json' WHERE path = 'config/candidate.json'").run();
    db.close();
    await expect(openBundle(file)).rejects.toThrow(/will not write/);

    await exportBundle(root, file);
    const db2 = new DatabaseSync(file);
    db2.prepare("UPDATE bundle_chunks SET bytes = X'00' WHERE path = 'config/candidate.json'").run();
    db2.close();
    await expect(importBundle(mkdtempSync(join(tmpdir(), 't-')), file, { apply: true, latestSchema: LATEST })).rejects.toThrow(/checksum/);
  });
});
