/**
 * Grounded cover letters (P1-3): each paragraph must be backed by cited
 * resume text; unbacked paragraphs are dropped, too few survivors fall back to
 * the template, and the letter is also written as a real .docx.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { composeGroundedLetter, letterSettings } from '../../src/apply/groundedLetter.js';
import { verifyParagraph } from '../../src/resume/claimVerifier.js';
import { extractDocxText } from '../../src/resume/docxText.js';
import { writeLetterDocx } from '../../src/resume/tailorRunner.js';

const ROLE = 'Data Engineer, Acme Corp | 2021 - Present';
const UNITS = [
  { id: 'u2', kind: 'bullet', role: ROLE, text: 'Built medallion pipelines on Azure Databricks with PySpark, cutting load time by 40%.' },
  { id: 'u3', kind: 'bullet', role: ROLE, text: 'Developed Power BI semantic models for 12 finance teams.' },
];
const unitMap = new Map(UNITS.map((u) => [u.id, u]));
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', COVER_LETTER_MODE: 'grounded' };
const job = { id: 'j1', company: 'Globex', title: 'Senior Data Engineer' };
const config = { root: null, candidate: { technicalStack: { languages: ['Python', 'SQL'] } }, scoring: {} };
const modelSaying = (paragraphs) => ({
  readMasterUnitsFn: async () => UNITS,
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ paragraphs }) } }] }) }),
});

describe('grounded cover letters (P1-3)', () => {
  it('is off by default and needs the LLM', () => {
    expect(letterSettings({}).enabled).toBe(false);
    expect(letterSettings({ COVER_LETTER_MODE: 'grounded' }).reason).toMatch(/LLM assist/);
    expect(letterSettings(ENV).enabled).toBe(true);
  });

  it('keeps backed paragraphs and drops the rest, with reasons', async () => {
    const r = await composeGroundedLetter({ job, config, env: ENV, deps: modelSaying([
      { text: 'At Acme Corp I built Azure Databricks medallion pipelines in PySpark that cut load time by 40%.', evidence: ['u2'] },
      { text: 'I also developed Power BI semantic models that 12 finance teams use, which fits the Senior Data Engineer role at Globex.', evidence: ['u3'] },
      { text: 'I led a Kafka streaming platform serving 50 million events a day.', evidence: ['u2'] },
      { text: 'My background is a strong fit for your team.', evidence: ['u99'] },
    ]) });
    expect(r.ok).toBe(true);
    expect(r.paragraphs).toHaveLength(2);
    expect(r.body.split('\n\n')).toHaveLength(2);
    expect(r.dropped).toHaveLength(2);
    expect(r.dropped[0].reasons.join(' ')).toMatch(/Kafka|50|more ownership/);
    expect(r.dropped[1].reasons.join(' ')).toMatch(/u99/);
    expect(r.provenance.task).toBe('cover-letter@1');
  });

  it('falls back to the template when fewer than two paragraphs are backed', async () => {
    const r = await composeGroundedLetter({ job, config, env: ENV, deps: modelSaying([
      { text: 'I built Azure Databricks pipelines in PySpark at Acme Corp, cutting load time by 40%.', evidence: ['u2'] },
      { text: 'I have 15 years of Snowflake experience.', evidence: ['u3'] },
    ]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only 1 paragraph/);
  });

  it('lets the company and role title through, but not a posting skill', () => {
    const base = { units: unitMap, profile: [], vocabulary: ['snowflake'], literals: ['Globex', 'Senior Data Engineer'] };
    expect(verifyParagraph({ ...base, text: 'The Senior Data Engineer role at Globex fits the Power BI models I developed.', evidenceIds: ['u3'] }).ok).toBe(true);
    expect(verifyParagraph({ ...base, text: 'Globex uses Snowflake, which I developed models in.', evidenceIds: ['u3'] }).ok).toBe(false);
    expect(verifyParagraph({ ...base, text: 'I developed models.', evidenceIds: [] }).reasons).toContain('cites no resume text');
  });

  it('writes the letter as a .docx whose text is the letter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'letter-'));
    try {
      const text = 'Dear Globex team,\n\nFirst paragraph from the resume.\n\nSecond paragraph from the resume.\n\nSincerely,\nTest Person';
      const path = await writeLetterDocx({ text, path: join(dir, 'letter.docx'), root: process.cwd() });
      const extracted = extractDocxText(readFileSync(path)).text;
      for (const line of ['Dear Globex team,', 'First paragraph from the resume.', 'Second paragraph from the resume.', 'Test Person']) {
        expect(extracted).toContain(line);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
