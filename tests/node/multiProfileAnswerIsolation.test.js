/**
 * Screening answers never cross from one candidate to another (audit BUG-01).
 *
 * Found by the 2026-11-13 audit: activation writes `profileOwnedAnswerIds` and
 * `profileId` into config/screening_answers.json so a profile that does not
 * state its salary or experience is not answered with the previous person's.
 * Every later save (the answers editor and "answer it once") rebuilt the file
 * WITHOUT those keys, and the editor also dropped each answer's own
 * `profileId` stamp, so one save re-exposed the first candidate's facts on the
 * second candidate's applications. All people here are fictional.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerScreeningQuestion, effectiveAnswers } from '../../src/apply/screeningQA.js';
import { readScreeningAnswers, stampOwnership, upsertScreeningAnswer, writeScreeningAnswers } from '../../src/config/profileStore.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { saveProfile, activateProfile } from '../../src/profile/store.js';
import { loadConfig } from '../../src/config/loadConfig.js';

const REPO = process.cwd();

const STATES_SALARY = normalizeProfile({
  id: 'alex-data', label: 'Alex — Data Engineer',
  identity: { fullName: 'Alex Rivera', headline: 'Data Engineer' },
  contact: { email: 'alex@example.com' },
  location: { city: 'Springfield', state: 'Illinois', country: 'United States' },
  background: { currentRoles: ['Data Engineer'], yearsExperience: 9, skills: ['SQL', 'Python'] },
  searchIntent: {
    targetRoles: ['Data Engineer'], seniority: 'senior',
    compensation: { minAnnual: 180000, currency: 'USD' },
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

/** States neither salary nor experience: those questions must go to the human. */
const SILENT = normalizeProfile({
  id: 'sam-nurse', label: 'Sam — Registered Nurse',
  identity: { fullName: 'Sam Okafor', headline: 'Registered Nurse' },
  contact: { email: 'sam@example.com' },
  location: { city: 'Tulsa', state: 'Oklahoma', country: 'United States' },
  background: { currentRoles: ['Registered Nurse'], skills: ['BLS'] },
  searchIntent: {
    targetRoles: ['Registered Nurse'], seniority: 'mid',
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

describe('screening answers stay with the candidate who gave them', () => {
  let root;
  const file = () => join(root, 'config', 'screening_answers.json');
  const read = () => JSON.parse(readFileSync(file(), 'utf8'));
  const ask = (question) => answerScreeningQuestion(question, read(), {}).answer ?? null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-answers-'));
    mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
    for (const name of ['scoring.json', 'exclusions.json', 'role_families.json', 'jobboards.json', 'humanizer_patterns.json', 'ats_resume.json']) {
      copyFileSync(join(REPO, 'config', name), join(root, 'config', name));
    }
    copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
    copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
    for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'ats_resume']) {
      copyFileSync(join(REPO, 'config', 'schemas', `${schema}.schema.json`), join(root, 'config', 'schemas', `${schema}.schema.json`));
    }
    writeFileSync(file(), `${JSON.stringify({ defaults: { unknownAction: 'ask_user' }, answers: [] }, null, 2)}\n`);
    saveProfile(root, STATES_SALARY);
    saveProfile(root, SILENT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('answering a queued question under profile B keeps the ownership guard', () => {
    activateProfile(root, STATES_SALARY.id);
    upsertScreeningAnswer(root, { id: 'highest_education', patterns: ['highest level of education'], answer: "Master's degree", type: 'text' });
    expect(ask('What is your desired salary?')).toMatch(/180,000/);

    activateProfile(root, SILENT.id);
    expect(ask('What is your desired salary?')).toBeNull();

    // The write that used to strip the guard.
    upsertScreeningAnswer(root, { id: 'commute', patterns: ['willing to commute'], answer: 'Yes', type: 'text' });

    const doc = read();
    expect(doc.profileId).toBe(SILENT.id);
    expect(doc.profileOwnedAnswerIds).toContain('salary_expectation');
    expect(ask('What is your desired salary?')).toBeNull();
    expect(ask('How many years of experience do you have?')).toBeNull();
    // A custom answer Alex gave is Alex's, not Sam's.
    expect(ask('What is your highest level of education?')).toBeNull();
    // Sam's own answer is used.
    expect(ask('Are you willing to commute?')).toBe('Yes');
  });

  it('a whole-list save from the editor keeps each answer\'s owner', () => {
    activateProfile(root, STATES_SALARY.id);
    upsertScreeningAnswer(root, { id: 'highest_education', patterns: ['highest level of education'], answer: "Master's degree", type: 'text' });
    activateProfile(root, SILENT.id);

    // The editor sends every row back without the stamp.
    const rows = readScreeningAnswers(root).answers.map(({ profileId: _p, ...rest }) => rest);
    rows.push({ id: 'shift', patterns: ['night shifts'], answer: 'Yes', type: 'text' });
    writeScreeningAnswers(root, { defaults: {}, answers: rows });

    const doc = read();
    expect(doc.profileId).toBe(SILENT.id);
    expect(doc.profileOwnedAnswerIds?.length).toBeGreaterThan(0);
    expect(doc.answers.find((a) => a.id === 'highest_education').profileId).toBe(STATES_SALARY.id);
    expect(doc.answers.find((a) => a.id === 'shift').profileId).toBe(SILENT.id);
    expect(ask('What is your highest level of education?')).toBeNull();
    expect(ask('Can you work night shifts?')).toBe('Yes');
  });

  it('editing another candidate\'s answer makes it the active candidate\'s', () => {
    const stored = [{ id: 'x', answer: 'old', profileId: 'a' }, { id: 'y', answer: 'same', profileId: 'a' }];
    const out = stampOwnership([{ id: 'x', answer: 'new' }, { id: 'y', answer: 'same' }, { id: 'z', answer: 'n' }], stored, 'b');
    expect(out.map((e) => e.profileId)).toEqual(['b', 'a', 'b']);
    // No active profile (single-user setup): nothing is invented.
    expect(stampOwnership([{ id: 'z', answer: 'n' }], [], null)[0]).not.toHaveProperty('profileId');
  });

  it('loadConfig restores the guard when an older build already stripped it', () => {
    activateProfile(root, STATES_SALARY.id);
    upsertScreeningAnswer(root, { id: 'highest_education', patterns: ['highest level of education'], answer: "Master's degree", type: 'text' });
    activateProfile(root, SILENT.id);
    const stripped = read();
    delete stripped.profileId;
    delete stripped.profileOwnedAnswerIds;
    writeFileSync(file(), JSON.stringify(stripped));

    const config = loadConfig({ root, loadEnv: false });
    expect(config.screeningAnswers.profileId).toBe(SILENT.id);
    const ids = effectiveAnswers(config.screeningAnswers).map((a) => a.id);
    expect(ids).not.toContain('highest_education');
    expect(answerScreeningQuestion('What is your desired salary?', config.screeningAnswers, {}).answer ?? null).toBeNull();
  });

  it('an answer saved with no profiles at all keeps working (single-user setup)', () => {
    writeScreeningAnswers(root, { defaults: {}, answers: [{ id: 'commute', patterns: ['willing to commute'], answer: 'Yes', type: 'text' }] });
    expect(read().answers[0]).not.toHaveProperty('profileId');
    expect(ask('Are you willing to commute?')).toBe('Yes');
  });
});
