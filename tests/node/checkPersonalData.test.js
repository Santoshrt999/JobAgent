import { describe, expect, it } from 'vitest';

import { denylistHits, personalPaths } from '../../scripts/checkPersonalData.mjs';

describe('personal-data CI check (P0-1)', () => {
  it('flags the real personal-data paths and nothing else', () => {
    const paths = [
      'config/candidate.json', 'config/candidate.example.json', 'config/screening_answers.json',
      'config/screening_answers.example.json', 'config/cover_letter.json', 'resumes/base/MASTER_RESUME.docx',
      'resumes/base/MASTER_RESUME.example.docx', 'config/profiles/alex.json', 'config/profiles/README.md',
      '.env', '.env.example', 'data/applied_jobs.db', 'data/applied_jobs.db-wal', 'data/jobs_input/manual_jobs.csv.example',
      'tests/node/fixtures/config/candidate.json',
    ];
    expect(personalPaths(paths)).toEqual([
      '.env', 'config/candidate.json', 'config/cover_letter.json', 'config/profiles/alex.json',
      'config/screening_answers.json', 'data/applied_jobs.db', 'data/applied_jobs.db-wal', 'resumes/base/MASTER_RESUME.docx',
    ]);
  });

  it('reports denylist hits by line number, case-insensitive, ignoring very short values', () => {
    const text = 'Contact: Jordan Example, 555-0100, lives on Elm Street';
    expect(denylistHits(text, ['jordan example', 'abc', 'Elm Street', 'not present'])).toEqual([1, 3]);
    expect(denylistHits(text, ['555'])).toEqual([]);
  });
});
