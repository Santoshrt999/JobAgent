/** Requirement -> resume evidence, quoted, never invented (audit Backlog #6). Fictional resume. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceFor, masterResumeLines } from '../../src/resume/evidenceMap.js';
import { openDatabase } from '../../src/logging/db.js';
import { jobDetail } from '../../src/dashboard/data.js';
import { makeDocx } from './fixtures/docx.js';

const RESUME = [
  'Jordan Lee',
  'Senior Data Engineer',
  'Built Spark and Airflow pipelines moving 2 TB a day into Snowflake for finance reporting.',
  'Rewrote the C++ pricing service, cutting p99 latency by 40%.',
  'Skills: Python, SQL, Spark',
];

describe('evidenceFor', () => {
  it('quotes the specific line for each skill, bullets before skill lists', () => {
    const out = evidenceFor(['Spark', 'C++', 'Kubernetes', 'spark'], RESUME);
    expect(out.map((e) => e.term)).toEqual(['Spark', 'C++', 'Kubernetes']);
    expect(out[0].lines[0]).toMatch(/^Built Spark and Airflow pipelines/);
    expect(out[1].lines).toEqual(['Rewrote the C++ pricing service, cutting p99 latency by 40%.']);
    expect(out[2].lines).toEqual([]); // unproven, not guessed
  });

  it('matches whole words only', () => {
    expect(evidenceFor(['SQL'], ['Designed NoSQLish caches for the service layer.'])[0].lines).toEqual([]);
    expect(evidenceFor(['Go'], ['Good communication across teams and partners.'])[0].lines).toEqual([]);
  });
});

describe('job detail evidence', () => {
  it('reads the active master resume and maps the posting\'s skills to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-evidence-'));
    try {
      mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
      writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(RESUME));
      expect(masterResumeLines(root).length).toBe(RESUME.length);
      const db = openDatabase({ path: ':memory:' });
      db.upsertJob({ id: 'j', title: 'Data Engineer', company: 'Northwind', status: 'scored', score: 80,
        matched_keywords: JSON.stringify(['Spark']), missing_keywords: JSON.stringify(['Kubernetes']) });
      const detail = jobDetail(db, 'j', { root });
      expect(detail.evidence.map((e) => [e.term, e.lines.length > 0])).toEqual([['Spark', true], ['Kubernetes', false]]);
      expect(jobDetail(db, 'j', {}).evidence).toBeNull();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
