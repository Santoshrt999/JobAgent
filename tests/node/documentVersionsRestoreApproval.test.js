/**
 * Restoring an earlier document version (audit BUG-05).
 *
 * The restore route left an approved packet approved (so Auto-fill aborted
 * later on a digest mismatch nobody could explain), rolled back the letter's
 * .txt but not its .docx, and copied files to and from paths read from the
 * database without checking they were inside the workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { readManifest, recordVersion } from '../../src/apply/documentVersions.js';

const V1 = 'Dear Hiring Team,\n\nVersion one of the letter.\n\nSincerely,\nJordan Lee\n';
const V2 = 'Dear Hiring Team,\n\nVersion two of the letter.\n\nSincerely,\nJordan Lee\n';

let root; let db; let dash; let folder; let txt; let docx; let rebuilt;
const call = (method, p, body) => fetch(dash.url + p, {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jobagent-restore-'));
  folder = join(root, 'applications', 'output', 'Northwind', 'Data Engineer');
  mkdirSync(folder, { recursive: true });
  txt = join(folder, 'Cover_Letter.txt');
  docx = join(folder, 'Cover_Letter.docx');
  writeFileSync(txt, V1);
  recordVersion(folder, { cause: 'prepared', files: { letter: txt } }); // v1: text only (no Word copy yet)
  writeFileSync(txt, V2);
  writeFileSync(docx, 'DOCX OF V2');
  recordVersion(folder, { cause: 'edited', files: { letter: txt, letterDocx: docx } }); // v2
  db = openDatabase({ path: ':memory:' });
  db.upsertJob({ id: 'job-1', title: 'Data Engineer', company: 'Northwind', status: 'prepared', score: 82, cover_letter_path: txt, output_folder_path: folder });
  db.insertApproval({ id: 'ap-1', job_id: 'job-1', approval_status: 'approved', approved_by_user: 1 });
  rebuilt = [];
  dash = await startDashboard({
    config: { root }, db, logger: null, port: 0,
    deps: { writeLetterDocxFn: async ({ text, path }) => { rebuilt.push(text); writeFileSync(path, `DOCX OF ${text.includes('one') ? 'V1' : 'V2'}`); return path; } },
  });
});
afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

describe('restoring a document version', () => {
  it('sends an approved packet back to review', async () => {
    const r = await call('POST', '/api/jobs/job-1/restore-version', { n: 1 });
    expect(r.status).toBe(200);
    expect(r.body.needsReapproval).toBe(true);
    expect(db.getApprovalByJob('job-1').approval_status).toBe('pending_review');
    expect(readFileSync(txt, 'utf8')).toBe(V1);
    expect(readManifest(folder).versions.at(-1).cause).toBe('restored');
  });

  it('keeps the Word letter in step with the restored text', async () => {
    await call('POST', '/api/jobs/job-1/restore-version', { n: 1 });
    // v1 had no Word copy: the newer one is rebuilt from the restored text,
    // never left saying something else.
    expect(rebuilt).toHaveLength(1);
    expect(readFileSync(docx, 'utf8')).toBe('DOCX OF V1');
    // Back to v2: its Word copy is restored with it.
    await call('POST', '/api/jobs/job-1/restore-version', { n: 2 });
    expect(readFileSync(txt, 'utf8')).toBe(V2);
    expect(readFileSync(docx, 'utf8')).toBe('DOCX OF V2');
  });

  it('removes a Word letter it cannot rebuild rather than leave a mismatched one', async () => {
    await dash.close();
    dash = await startDashboard({ config: { root }, db, logger: null, port: 0, deps: { writeLetterDocxFn: false } });
    await call('POST', '/api/jobs/job-1/restore-version', { n: 1 });
    expect(existsSync(docx)).toBe(false);
  });

  it('refuses document paths outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'jobagent-outside-'));
    try {
      db.upsertJob({ id: 'job-1', output_folder_path: outside });
      expect((await call('GET', '/api/jobs/job-1/versions')).status).toBe(403);
      expect((await call('POST', '/api/jobs/job-1/restore-version', { n: 1 })).status).toBe(403);
      db.upsertJob({ id: 'job-1', output_folder_path: folder, cover_letter_path: join(outside, 'x.txt') });
      expect((await call('POST', '/api/jobs/job-1/restore-version', { n: 1 })).status).toBe(403);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
