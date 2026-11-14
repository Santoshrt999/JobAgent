/**
 * The master cover letter: stored beside the master resume, every save keeps
 * the version it replaces, uploads become plain text, and the starter draft
 * states only what the profile says.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  letterTextFromUpload, masterLetterPaths, masterLetterState, readMasterLetterText,
  restoreMasterLetter, saveMasterLetter, starterLetter,
} from '../../src/apply/masterLetter.js';
import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { makeDocx } from './fixtures/docx.js';

const LETTER = `Dear Hiring Team,

I am applying for the {title} role at {company}. I build analytics platforms that finance teams rely on every day, and I enjoy making complicated numbers easy to trust.

At Contoso I rebuilt the month-end close pipeline, cutting close time from five days to two for over two hundred analysts.

I would welcome the chance to talk about how I could help {company}. Thank you for your consideration.

Sincerely,
Jordan Lee`;

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-letter-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('master letter store', () => {
  it('lives beside the master resume of the active workspace', () => {
    expect(masterLetterPaths(root).file).toBe(join(root, 'resumes', 'base', 'MASTER_COVER_LETTER.txt'));
  });

  it('reports a missing letter as a normal state', () => {
    const state = masterLetterState(root);
    expect(state.exists).toBe(false);
    expect(state.text).toBe('');
    expect(state.versions).toEqual([]);
    expect(readMasterLetterText(root)).toBe('');
  });

  it('saves, keeps the replaced version, and restores it', () => {
    const t0 = new Date('2026-11-01T10:00:00Z');
    expect(saveMasterLetter(root, LETTER, { now: t0 }).saved).toBe(true);
    const edited = LETTER.replace('five days to two', 'five days to one');
    const second = saveMasterLetter(root, edited, { now: new Date('2026-11-02T10:00:00Z') });
    expect(second.backup).toMatch(/^MASTER_COVER_LETTER\..+\.txt$/);
    expect(second.state.versions).toHaveLength(1);
    expect(readMasterLetterText(root)).toContain('five days to one');

    const restored = restoreMasterLetter(root, second.backup, { now: new Date('2026-11-03T10:00:00Z') });
    expect(readMasterLetterText(root)).toContain('five days to two');
    // Restoring is a save: the edited text is now a kept version too.
    expect(restored.state.versions).toHaveLength(2);
  });

  it('treats saving identical text as a no-op', () => {
    saveMasterLetter(root, LETTER);
    const again = saveMasterLetter(root, `${LETTER}\n\n`);
    expect(again.saved).toBe(false);
    expect(again.backup).toBeNull();
    expect(masterLetterState(root).versions).toEqual([]);
  });

  it('refuses empty, too-short, oversized and binary text before writing anything', () => {
    expect(() => saveMasterLetter(root, '   ')).toThrow(/empty/);
    expect(() => saveMasterLetter(root, 'Too short to be a letter.')).toThrow(/at least 40/);
    expect(() => saveMasterLetter(root, 'word '.repeat(5000))).toThrow(/limit/);
    expect(() => saveMasterLetter(root, `${LETTER}\u0001`)).toThrow(/unreadable/);
    expect(existsSync(masterLetterPaths(root).file)).toBe(false);
  });

  it('rejects a version name that tries to leave the history folder', () => {
    saveMasterLetter(root, LETTER);
    expect(() => restoreMasterLetter(root, '../../MASTER_RESUME.docx')).toThrow(/not a kept/);
  });
});

describe('uploads', () => {
  it('reads .docx paragraphs as letter paragraphs', () => {
    const text = letterTextFromUpload('letter.docx', makeDocx(['Dear Hiring Team,', 'First paragraph.', 'Second paragraph.']));
    expect(text).toBe('Dear Hiring Team,\n\nFirst paragraph.\n\nSecond paragraph.');
  });
  it('reads .txt and strips light markdown from .md', () => {
    expect(letterTextFromUpload('a.txt', Buffer.from(`${String.fromCharCode(0xFEFF)}Hello\r\n\r\nWorld`))).toBe('Hello\n\nWorld');
    expect(letterTextFromUpload('a.md', Buffer.from('# Letter\n\nI **led** the team.'))).toBe('Letter\n\nI led the team.');
  });
  it('refuses other types and renamed files', () => {
    expect(() => letterTextFromUpload('a.pdf', Buffer.from('x'))).toThrow(/\.docx, \.txt or \.md/);
    expect(() => letterTextFromUpload('a.docx', Buffer.from('not a zip'))).toThrow(/not a Word document/);
  });
});

describe('starter draft', () => {
  it('uses only profile facts and leaves prompts where words are needed', () => {
    const text = starterLetter({
      identity: { fullName: 'Jordan Lee', headline: 'Data Engineer' },
      workHistory: [{ employer: 'Contoso', current: true, highlights: ['Cut close time from five days to two.'] }],
    });
    expect(text).toContain('I am applying for the {title} role at {company}.');
    expect(text).toContain('I am a Data Engineer.');
    expect(text).toContain('At Contoso, I cut close time from five days to two.');
    expect(text).toMatch(/\[[^\]]+\]/);
    expect(text.trim().endsWith('Jordan Lee')).toBe(true);
    // No years are claimed when the profile does not state them.
    expect(text).not.toMatch(/\d+\+ years/);
  });
  it('never turns the example placeholder highlight into a claim', () => {
    const text = starterLetter({ workHistory: [{ employer: 'Example Corp', current: true, highlights: ['One-line, metric-backed achievement bullet'] }] });
    expect(text).not.toContain('metric-backed');
  });
});

describe('master letter API', () => {
  let db; let dash;
  const call = (method, p, body) => fetch(dash.url + p, {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: { root, candidate: { identity: { fullName: 'Jordan Lee' } } }, db, logger: null, port: 0 });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('saves, lists versions, previews for a job, downloads and restores', async () => {
    expect((await call('GET', '/api/master-letter')).body.exists).toBe(false);
    expect((await call('POST', '/api/master-letter', { text: LETTER })).status).toBe(200);
    const second = await call('POST', '/api/master-letter', { text: LETTER.replace('two hundred', 'three hundred') });
    expect(second.body.backup).toBeTruthy();

    const state = (await call('GET', '/api/master-letter')).body;
    expect(state.exists).toBe(true);
    expect(state.quality.label).toBeDefined();
    expect(state.versions).toHaveLength(1);

    const version = await call('GET', `/api/master-letter/version?name=${encodeURIComponent(state.versions[0].name)}`);
    expect(version.body.text).toContain('two hundred');

    db.upsertJob({ id: 'job-1', title: 'Data Engineer', company: 'Northwind', score: 88, matched_keywords: JSON.stringify(['sql']) });
    const preview = await call('POST', '/api/master-letter/preview', { jobId: 'job-1' });
    expect(preview.body.letter.text).toContain('Northwind');
    expect(preview.body.letter.source).toBe('master');

    const file = await call('GET', '/api/master-letter/file');
    expect(file.body).toContain('three hundred');

    await call('POST', '/api/master-letter/restore', { name: state.versions[0].name });
    expect(readMasterLetterText(root)).toContain('two hundred');
  });

  it('uploads a .docx and refuses a bad body', async () => {
    const docx = makeDocx(LETTER.split('\n\n'));
    const ok = await call('POST', '/api/master-letter/upload', { filename: 'Letter.docx', contentBase64: docx.toString('base64') });
    expect(ok.status).toBe(200);
    expect(readFileSync(masterLetterPaths(root).file, 'utf8')).toContain('{company}');
    expect((await call('POST', '/api/master-letter/upload', { filename: 'x.docx', contentBase64: '%%%' })).status).toBe(400);
  });

  it('offers a starter draft without saving it', async () => {
    const starter = await call('GET', '/api/master-letter/starter');
    expect(starter.body.text).toContain('{company}');
    expect(existsSync(masterLetterPaths(root).file)).toBe(false);
  });
});
