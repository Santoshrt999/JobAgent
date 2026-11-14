/**
 * One job's materials over HTTP: read and edit its letter (frozen once sent,
 * back to review once approved), draft one when none was written, compare the
 * tailored resume with the master, and pin left-out lines for next time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { freezeVersions, readManifest } from '../../src/apply/documentVersions.js';
import { keptBulletsFor } from '../../src/resume/keepBullets.js';
import { pageBudget, tailorResumeForJob } from '../../src/resume/tailorRunner.js';
import { makeDocx } from './fixtures/docx.js';

const LETTER = 'Dear Hiring Team,\n\nI am applying for the Data Engineer role at Northwind. I rebuilt the close pipeline at Contoso.\n\nThank you for your consideration.\n\nSincerely,\nJordan Lee';

let root; let db; let dash; let folder;
const call = (method, p, body) => fetch(dash.url + p, {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jobagent-materials-'));
  folder = join(root, 'applications', 'output', 'Northwind', 'Data Engineer');
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
  writeFileSync(join(folder, 'Cover_Letter.txt'), `${LETTER}\n`);
  db = openDatabase({ path: ':memory:' });
  db.upsertJob({
    id: 'job-1', title: 'Data Engineer', company: 'Northwind', status: 'prepared', score: 82,
    matched_keywords: JSON.stringify(['sql']), cover_letter_path: join(folder, 'Cover_Letter.txt'), output_folder_path: folder,
  });
  db.upsertJob({ id: 'job-2', title: 'Analyst', company: 'Fabrikam', status: 'prepared', score: 60 });
  dash = await startDashboard({ config: { root, candidate: { identity: { fullName: 'Jordan Lee' } } }, db, logger: null, port: 0, deps: { writeLetterDocxFn: false } });
});
afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

describe("a job's cover letter", () => {
  it('reads the letter with a quality check', async () => {
    const { body } = await call('GET', '/api/jobs/job-1/cover-letter');
    expect(body.exists).toBe(true);
    expect(body.text).toContain('Northwind');
    expect(body.quality.issues.some((i) => i.code === 'short')).toBe(true);
    expect(body.frozen).toBe(false);
  });

  it('saves an edit, records it as a version, and sends an approved packet back to review', async () => {
    db.insertApproval({ id: 'ap-1', job_id: 'job-1', approval_status: 'approved', approved_by_user: 1 });
    const edited = LETTER.replace('rebuilt the close pipeline', 'rebuilt the month-end close pipeline');
    const { status, body } = await call('POST', '/api/jobs/job-1/cover-letter', { text: edited });
    expect(status).toBe(200);
    expect(body.needsReapproval).toBe(true);
    expect(readFileSync(join(folder, 'Cover_Letter.txt'), 'utf8')).toContain('month-end');
    expect(readManifest(folder).versions.at(-1).cause).toBe('edited');
    expect(db.getApprovalByJob('job-1').approval_status).not.toBe('approved');
  });

  it('refuses a letter with a placeholder or prompt, and any edit once submitted', async () => {
    expect((await call('POST', '/api/jobs/job-1/cover-letter', { text: 'Dear {company} team, hello.' })).status).toBe(400);
    expect((await call('POST', '/api/jobs/job-1/cover-letter', { text: 'Dear team,\n\n[Add a result]' })).status).toBe(400);
    await call('POST', '/api/jobs/job-1/cover-letter', { text: `${LETTER} ` }); // records a first version
    freezeVersions(folder);
    const frozen = await call('POST', '/api/jobs/job-1/cover-letter', { text: LETTER.replace('Contoso', 'Contoso Ltd') });
    expect(frozen.status).toBe(409);
    expect(readFileSync(join(folder, 'Cover_Letter.txt'), 'utf8')).not.toContain('Contoso Ltd');
  });

  it('drafts a letter for a job that has none, without saving it', async () => {
    expect((await call('GET', '/api/jobs/job-2/cover-letter')).body.exists).toBe(false);
    const draft = await call('POST', '/api/jobs/job-2/letter-draft', {});
    expect(draft.body.text).toContain('Fabrikam');
    expect((await call('POST', '/api/jobs/job-2/cover-letter', { text: draft.body.text })).status).toBe(409);
  });
});

describe('resume comparison and pinned lines', () => {
  it('compares the tailored resume with the master and pins left-out lines', async () => {
    const master = ['Jordan Lee', 'PROFESSIONAL EXPERIENCE', 'Engineer | Contoso | 2020 - Present', 'Built SQL pipelines.', 'Cut close time from 5 days to 2.'];
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(master));
    const tailoredPath = join(folder, 'Resume.docx');
    writeFileSync(tailoredPath, makeDocx(master.filter((l) => !l.startsWith('Cut close'))));
    db.upsertJob({ id: 'job-1', resume_docx_path: tailoredPath });

    const diff = await call('GET', '/api/jobs/job-1/resume-diff');
    expect(diff.status).toBe(200);
    expect(diff.body.summary.omitted).toBe(1);
    expect(diff.body.flagged[0].flags).toContain('measured result');

    const keep = await call('POST', '/api/jobs/job-1/keep-bullets', { bullets: ['Cut close time from 5 days to 2.', 'Cut close time from 5 days to 2.', 42] });
    expect(keep.body.bullets).toEqual(['Cut close time from 5 days to 2.']);
    expect(keptBulletsFor(db, 'job-1')).toEqual(['Cut close time from 5 days to 2.']);
    expect((await call('GET', '/api/jobs/job-1/resume-diff')).body.rows.find((r) => r.status === 'omitted').kept).toBe(true);
  });

  it('explains when there is nothing to compare yet', async () => {
    expect((await call('GET', '/api/jobs/job-2/resume-diff')).status).toBe(409);
    expect((await call('POST', '/api/jobs/job-2/keep-bullets', { bullets: 'nope' })).status).toBe(400);
  });
});

describe('tailor runner', () => {
  it('reads the page budget: default 2, 0 means never trim, clamped otherwise', () => {
    expect(pageBudget(undefined)).toBe(2);
    expect(pageBudget(0)).toBe(0);
    expect(pageBudget('3')).toBe(3);
    expect(pageBudget(40)).toBe(6);
    expect(pageBudget('x')).toBe(2);
  });

  it('sends pinned bullets and the page budget to the Python tailor', async () => {
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(['Jordan Lee', 'Built SQL pipelines.']));
    let request = null;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { write: (chunk) => { request = JSON.parse(String(chunk)); }, end: () => setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: 'stubbed' })));
        child.emit('close', 0);
      }), on: () => {} };
      child.kill = () => {};
      return child;
    };
    await tailorResumeForJob({
      job: { company: 'Northwind', title: 'Data Engineer', jdText: 'SQL' }, score: { matchedKeywords: ['sql'] },
      config: { root, scoring: {}, candidate: {} },
      options: { keepBullets: ['Built SQL pipelines.'], maxPages: 0, llmAssist: false },
      deps: { spawnImpl, env: { ...process.env, JOB_AGENT_LLM: 'off' } },
    });
    expect(request.keep_bullets).toEqual(['Built SQL pipelines.']);
    expect(request.max_pages).toBe(0);
  });
});
