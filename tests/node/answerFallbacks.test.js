/**
 * Facts no screen edits take the person's own Saved answers.
 *
 * Measured 2026-11-12: "work_authorization", "years_experience" and
 * "require_sponsorship" were answered under Application profile → Saved
 * answers, yet Prepare refused every job because a SECOND copy of the same
 * facts (the profile's work authorization, cover_letter.json) was still the
 * shipped template and no screen edits it. See src/config/answerFallbacks.js.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { answerFor, applyAnswerFallbacks, sponsorshipSentenceFor } from '../../src/config/answerFallbacks.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { findPlaceholders } from '../../src/config/placeholders.js';
import { buildTestRoot } from './globalSetup.js';

const TEMPLATE = {
  status: 'US Citizen | Green Card | H-1B | OPT | ...',
  details: 'Describe your authorization truthfully — this is used verbatim in screening answers.',
  years: "YOUR total years of experience (e.g. '8 years')",
  note: 'YOUR truthful sponsorship sentence, or set includeSponsorshipNote to false.',
  answer: 'YOUR truthful authorization status.',
};

const answers = (entries) => ({ answers: Object.entries(entries).map(([id, answer]) => ({ id, answer, patterns: [id] })) });

function templated({ requiresSponsorship = true } = {}) {
  return {
    candidate: { workAuthorization: { status: TEMPLATE.status, details: TEMPLATE.details, requiresSponsorship } },
    coverLetter: { enabled: true, includeSponsorshipNote: true, yearsOfExperience: TEMPLATE.years, template: { sponsorshipNote: TEMPLATE.note } },
  };
}

describe('applyAnswerFallbacks', () => {
  it('fills work authorization, years and the sponsorship sentence from the answers', () => {
    const out = applyAnswerFallbacks({
      ...templated(),
      screeningAnswers: answers({ work_authorization: 'H-1B visa', years_experience: '10 years' }),
    });
    expect(out.candidate.workAuthorization).toMatchObject({ status: 'H-1B visa', details: 'H-1B visa', requiresSponsorship: true });
    expect(out.coverLetter.yearsOfExperience).toBe('10 years');
    expect(out.coverLetter.template.sponsorshipNote).toBe(sponsorshipSentenceFor('H-1B visa'));
    expect(out.filled.map((f) => f.path)).toEqual([
      'candidate.workAuthorization.status', 'candidate.workAuthorization.details',
      'coverLetter.yearsOfExperience', 'coverLetter.template.sponsorshipNote',
    ]);
    expect(findPlaceholders({ candidate: out.candidate, coverLetter: out.coverLetter }).ok).toBe(true);
  });

  it('never replaces a real value the person wrote', () => {
    const bundle = {
      candidate: { workAuthorization: { status: 'Green Card', details: 'Permanent resident.', requiresSponsorship: false } },
      coverLetter: { enabled: true, includeSponsorshipNote: true, yearsOfExperience: '7 years', template: { sponsorshipNote: 'My own sentence.' } },
      screeningAnswers: answers({ work_authorization: 'H-1B visa', years_experience: '10 years' }),
    };
    const out = applyAnswerFallbacks(bundle);
    expect(out.candidate.workAuthorization).toEqual(bundle.candidate.workAuthorization);
    expect(out.coverLetter).toEqual(bundle.coverLetter);
    expect(out.filled).toEqual([]);
  });

  it('never copies an answer that is itself template text, so the guard still refuses', () => {
    const out = applyAnswerFallbacks({ ...templated(), screeningAnswers: answers({ work_authorization: TEMPLATE.answer }) });
    expect(answerFor(answers({ work_authorization: TEMPLATE.answer }), 'work_authorization')).toBeNull();
    expect(out.candidate.workAuthorization.status).toBe(TEMPLATE.status);
    // Sponsorship is required and the status is unknown: no sentence is invented.
    expect(out.coverLetter.template.sponsorshipNote).toBe(TEMPLATE.note);
    const left = findPlaceholders({ candidate: out.candidate, coverLetter: out.coverLetter }).placeholders.map((p) => p.label);
    expect(left).toEqual(expect.arrayContaining(['work authorization status', 'cover-letter sponsorship sentence']));
  });

  it('takes years from the resume when there is no answer, and leaves them alone when neither exists', () => {
    const fromResume = applyAnswerFallbacks({ ...templated(), screeningAnswers: answers({}), profile: { background: { yearsExperience: 10 } } });
    expect(fromResume.coverLetter.yearsOfExperience).toBe('10 years');
    expect(fromResume.filled).toContainEqual({ path: 'coverLetter.yearsOfExperience', from: 'the years your resume states' });
    const neither = applyAnswerFallbacks({ ...templated(), screeningAnswers: answers({}) });
    expect(neither.coverLetter.yearsOfExperience).toBe(TEMPLATE.years);
  });

  it('turns the sponsorship sentence off when the profile does not require sponsorship', () => {
    // The letter only includes it when sponsorship is required, so template
    // text in it reaches no one; that must not block Prepare.
    for (const requiresSponsorship of [false, null]) {
      const out = applyAnswerFallbacks({ ...templated({ requiresSponsorship }), screeningAnswers: answers({}) });
      expect(out.coverLetter.includeSponsorshipNote).toBe(false);
      expect(findPlaceholders({ coverLetter: out.coverLetter }).placeholders.map((p) => p.label))
        .not.toContain('cover-letter sponsorship sentence');
    }
  });

  it('writes a sponsorship sentence that reads right for a label and for a full sentence', () => {
    expect(sponsorshipSentenceFor('H-1B visa'))
      .toBe('My current work authorization is H-1B visa, and I am seeking an employer able to support continued sponsorship.');
    expect(sponsorshipSentenceFor('OPT.'))
      .toBe('My current work authorization is OPT, and I am seeking an employer able to support continued sponsorship.');
    expect(sponsorshipSentenceFor('Authorized to work in the United States on an H-1B visa.'))
      .toBe('Authorized to work in the United States on an H-1B visa. I am seeking an employer able to support continued sponsorship.');
  });

  it('treats the profile\'s "Unspecified" as unstated', () => {
    const out = applyAnswerFallbacks({
      candidate: { workAuthorization: { status: 'Unspecified', details: '' } },
      screeningAnswers: answers({ work_authorization: 'H-1B visa' }),
    });
    expect(out.candidate.workAuthorization).toMatchObject({ status: 'H-1B visa', details: 'H-1B visa' });
  });
});

describe('loadConfig fills from Saved answers, in memory only', () => {
  let root;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

  function editJson(rel, mutate) {
    const file = join(root, rel);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    mutate(doc);
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  }

  it('clears the guard, writes nothing, and the letter states the person\'s own status', () => {
    root = buildTestRoot();
    editJson('config/candidate.json', (doc) => {
      doc.workAuthorization = { ...doc.workAuthorization, status: TEMPLATE.status, details: TEMPLATE.details, requiresSponsorship: true };
    });
    editJson('config/cover_letter.json', (doc) => {
      doc.yearsOfExperience = TEMPLATE.years;
      doc.includeSponsorshipNote = true;
      doc.template.sponsorshipNote = TEMPLATE.note;
    });
    editJson('config/screening_answers.json', (doc) => {
      doc.answers.find((a) => a.id === 'work_authorization').answer = 'H-1B visa';
    });
    const before = ['candidate.json', 'cover_letter.json', 'screening_answers.json']
      .map((f) => readFileSync(join(root, 'config', f), 'utf8'));

    const config = loadConfig({ root, loadEnv: false });

    expect(findPlaceholders(config).ok).toBe(true);
    expect(config.filledFromAnswers.length).toBeGreaterThan(0);
    expect(['candidate.json', 'cover_letter.json', 'screening_answers.json']
      .map((f) => readFileSync(join(root, 'config', f), 'utf8'))).toEqual(before);

    const letter = generateCoverLetter(
      { title: 'Senior Software Engineer', company: 'Acme' },
      { total: 90, matchedKeywords: [] },
      { coverLetter: config.coverLetter, candidate: config.candidate, humanizerPatterns: config.humanizerPatterns, required: true },
    );
    expect(letter.text).toContain(sponsorshipSentenceFor('H-1B visa'));
    expect(letter.text).toContain('My current work authorization is H-1B visa, and I am seeking');
    expect(letter.text).not.toMatch(/YOUR |US Citizen \| Green Card/);
  });
});

describe('answerFor and whose answer it is (audit 2026-11-13, BUG-01)', () => {
  it('never takes an answer stamped as another person\'s, and keeps unstamped ones', () => {
    const doc = {
      profileId: 'sam',
      answers: [
        { id: 'work_authorization', answer: 'Authorized; requires H-1B transfer.', profileId: 'alex' },
        { id: 'years_experience', answer: '9+ years' },
      ],
    };
    expect(answerFor(doc, 'work_authorization')).toBeNull();
    expect(answerFor(doc, 'years_experience')).toBe('9+ years');
    expect(answerFor({ ...doc, profileId: 'alex' }, 'work_authorization')).toMatch(/H-1B/);
  });
});
