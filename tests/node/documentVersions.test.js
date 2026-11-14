/**
 * Document versions (P2-2): recorded on change only, restorable as a new
 * version, frozen on submission, comparable by text. Plus refine requests:
 * a plain-language change goes through the same claim checker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { freezeVersions, listVersions, recordVersion, restoreVersion, versionText } from '../../src/apply/documentVersions.js';
import { openDatabase } from '../../src/logging/db.js';
import { refineRewrites } from '../../src/resume/rewrites.js';

let folder;
const py = process.platform === 'win32' ? 'python' : 'python3';
function docx(path, lines) {
  execFileSync(py, ['-c', 'import sys, json\nfrom docx import Document\nd = Document()\nfor l in json.loads(sys.argv[2]): d.add_paragraph(l)\nd.save(sys.argv[1])', path, JSON.stringify(lines)]);
}
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'ver-')); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('document versions (P2-2)', () => {
  it('records a version only when the documents change', () => {
    const resume = join(folder, 'Resume.docx'); const letter = join(folder, 'Letter.txt');
    docx(resume, ['Test Person', 'Built pipelines.']);
    writeFileSync(letter, 'Dear team, one.');
    const v1 = recordVersion(folder, { cause: 'generated', files: { resume, letter } });
    expect(v1).toMatchObject({ n: 1, cause: 'generated', files: { resume: 'Resume.docx', letter: 'Letter.txt' }, frozen: false });
    expect(recordVersion(folder, { cause: 'generated', files: { resume, letter } }).n).toBe(1);
    writeFileSync(letter, 'Dear team, two.');
    expect(recordVersion(folder, { cause: 'generated', files: { resume, letter } }).n).toBe(2);
    expect(listVersions(folder)).toHaveLength(2);
    expect(existsSync(join(folder, 'versions', '1-generated', 'Letter.txt'))).toBe(true);
  });

  it('restores as a new version and gives each version its resume text', () => {
    const resume = join(folder, 'Resume.docx');
    docx(resume, ['Test Person', 'Built pipelines.']);
    recordVersion(folder, { cause: 'generated', files: { resume } });
    docx(resume, ['Test Person', 'Built Azure pipelines.']);
    recordVersion(folder, { cause: 'generated', files: { resume } });
    expect(versionText(folder, 1).paragraphs).toEqual(['Test Person', 'Built pipelines.']);
    const restored = restoreVersion(folder, 1, { resume });
    expect(restored).toMatchObject({ n: 3, cause: 'restored' });
    expect(versionText(folder, 3).paragraphs).toEqual(['Test Person', 'Built pipelines.']);
  });

  it('freezes on submission and then refuses to restore', () => {
    const letter = join(folder, 'Letter.txt');
    writeFileSync(letter, 'one');
    recordVersion(folder, { cause: 'generated', files: { letter } });
    writeFileSync(letter, 'two');
    recordVersion(folder, { cause: 'generated', files: { letter } });
    expect(freezeVersions(folder, { reason: 'submitted by you' })).toBe(true);
    expect(listVersions(folder).every((v) => v.frozen)).toBe(true);
    expect(() => restoreVersion(folder, 1, { letter })).toThrow(/frozen as sent/);
    expect(readFileSync(letter, 'utf8')).toBe('two');
  });

  it('reports unknown versions', () => {
    expect(() => versionText(folder, 9)).toThrow(/no version 9/);
  });
});

describe('refine requests (P2-2)', () => {
  const ROLE = 'Data Engineer, Acme Corp | 2021 - Present';
  const UNITS = [
    { id: 'u2', kind: 'bullet', role: ROLE, text: 'Developed Power BI semantic models for 12 finance teams.' },
    { id: 'u3', kind: 'bullet', role: ROLE, text: 'Built medallion pipelines on Azure Databricks with PySpark.' },
  ];
  const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', RESUME_REWRITE: 'suggest' };
  const answer = (data) => ({
    readMasterUnitsFn: async () => UNITS,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) }),
  });

  it('turns a request into verified suggestions, and reports what it declined', async () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Globex', title: 'DE', url: 'https://x/1' });
    const r = await refineRewrites({
      db, job: db.getJob('j1'), config: {}, env: ENV, instruction: 'Lead with the outcome, and say I used Kafka',
      deps: answer({
        edits: [
          { unitId: 'u2', rewrite: 'For 12 finance teams, developed Power BI semantic models.', evidence: ['u2'] },
          { unitId: 'u3', rewrite: 'Built medallion pipelines on Azure Databricks with PySpark and Kafka.', evidence: ['u3'] },
        ],
        declined: 'No bullet mentions Kafka, so it was not added.',
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.declined).toMatch(/Kafka/);
    expect(r.record.items.map((i) => [i.unitId, i.status])).toEqual([['u2', 'verified'], ['u3', 'refused']]);
    expect(r.record.refinements[0]).toMatchObject({ request: 'Lead with the outcome, and say I used Kafka', task: 'refine@1', edits: 2 });
    db.close();
  });

  it('needs a request', async () => {
    const r = await refineRewrites({ db: null, job: {}, config: {}, env: ENV, instruction: '  ' });
    expect(r).toMatchObject({ ok: false });
  });
});
