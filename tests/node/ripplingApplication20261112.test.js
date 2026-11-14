/**
 * Rippling application step (2026-11-12, a Rippling posting): the run reached the form
 * and left most of it blank.
 *
 * Causes, each confirmed on the live form before fixing:
 *   1. Yes/No and EEO questions are <div role="combobox">, never scanned.
 *   2. Custom questions are named only by a <p> above the field; their label
 *      became the random field key, so saved answers (salary) never matched.
 *   3. aria-label "textbox"/"Select"/"Search" beat aria-labelledby; Location
 *      was asked as "textbox", the phone code as "Search".
 *   4. The upload widget clears its input after reading the file, so a
 *      resume on the form was reported "did not remain attached".
 *   5. The .txt cover letter went to a slot that takes only .doc/.docx/.pdf.
 *   6. A saved work-authorization SENTENCE could not answer a Yes/No question.
 *   7. "Current company" was never filled from the profile's current role.
 *
 * The page under test is a local copy of that step's markup and widget
 * behaviour (tests/node/fixtures/audit/rippling_application.html). Nothing is
 * sent anywhere; the disabled Apply button is never clicked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assistApply } from '../../src/automation/applyRunner.js';
import { createBrowserSession } from '../../src/automation/browser.js';
import { unfilledRequiredControls } from '../../src/automation/domScanner.js';
import {
  acceptedExtensions, fileForInput, slotShowsFile,
} from '../../src/automation/uploadRunner.js';
import { documentFormats } from '../../src/apply/fileUpload.js';
import { classifyLabel, valueForField } from '../../src/apply/formPrefill.js';
import { answerScreeningQuestion, authorizationChoice, statusGrantsWork } from '../../src/apply/screeningQA.js';
import { LIFECYCLE } from '../../src/lifecycle.js';
import { browserUnavailable } from './helpers/browser.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const DOCS = join(FIXTURES, 'audit', 'docs');
const RESUME = join(DOCS, 'Fixture_Resume_Analytics_Engineer.docx');
const LETTER_TXT = join(DOCS, 'Fixture_Cover_Letter_Analytics_Engineer.txt');
const LETTER_DOCX = join(DOCS, 'Fixture_Cover_Letter_Analytics_Engineer.docx');
const candidate = JSON.parse(readFileSync(join(FIXTURES, 'config', 'candidate.json'), 'utf8'));
const screeningAnswers = JSON.parse(readFileSync(join(FIXTURES, 'config', 'screening_answers.json'), 'utf8'));
const YN = ['Yes', 'No'];

describe('work authorization: a saved sentence answers a Yes/No question only when it states it', () => {
  it('answers "Yes" to a Rippling posting\'s wording from a saved answer that states authorization', () => {
    const r = answerScreeningQuestion('If hired, are you legally authorized to work in the United States', screeningAnswers, { choices: YN, candidate });
    expect(r).toMatchObject({ answered: true, answer: 'Yes', matchedId: 'work_authorization' });
  });

  it('answers "Yes" from a person\'s own wording when their stated status grants work authorization', () => {
    // A person's own wording, which never says "authorized to work".
    const own = { ...screeningAnswers, answers: screeningAnswers.answers.map((a) => (a.id === 'work_authorization'
      ? { ...a, answer: candidate.workAuthorization.details } : a)) };
    const q = 'If hired, are you legally authorized to work in the United States';
    expect(answerScreeningQuestion(q, own, { choices: YN, candidate }).answer).toBe('Yes');
    const pending = { ...candidate, workAuthorization: { ...candidate.workAuthorization, status: 'H-1B pending' } };
    expect(answerScreeningQuestion(q, own, { choices: YN, candidate: pending }).answered).toBe(false);
    const f1 = { ...candidate, workAuthorization: { ...candidate.workAuthorization, status: 'F-1 student' } };
    expect(answerScreeningQuestion(q, own, { choices: YN, candidate: f1 }).answered).toBe(false);
  });

  it('knows which stated statuses grant work authorization', () => {
    for (const s of ['H-1B', 'US Citizen', 'Green Card holder', 'Permanent Resident', 'STEM OPT', 'OPT EAD', 'TN', 'L-1B', 'H-4 EAD']) {
      expect(statusGrantsWork(s), s).toBe(true);
    }
    for (const s of ['', 'F-1 student', 'J-1', 'CPT', 'B-2 visitor', 'H-1B pending', 'OPT expired', 'Will need H-1B', 'Applied for green card', 'Not authorized']) {
      expect(statusGrantsWork(s), s).toBe(false);
    }
  });

  it('never infers "No", and never answers a narrower or compound question', () => {
    const states = 'H-1B — authorized to work in the United States, and will need continued visa sponsorship.';
    expect(authorizationChoice('Are you legally authorized to work in the United States?', states, YN)).toBe('Yes');
    expect(authorizationChoice('Are you authorized to work in the US for any employer?', states, YN)).toBeNull();
    expect(authorizationChoice('Are you authorized to work in the US without restriction?', states, YN)).toBeNull();
    expect(authorizationChoice('Are you a US citizen or authorized to work?', states, YN)).toBeNull();
    expect(authorizationChoice('Are you authorized to work in the US without visa sponsorship?', states, YN)).toBeNull();
    expect(authorizationChoice('Are you legally authorized to work in the US?', 'I am not authorized to work in the US yet.', YN)).toBeNull();
    expect(authorizationChoice('Are you legally authorized to work in the US?', 'H-1B holder', YN)).toBeNull();
    expect(authorizationChoice('Are you legally authorized to work in the US?', states, ['Agree', 'Disagree'])).toBeNull();
  });
});

describe('current company comes from the profile role marked current, on exact labels only', () => {
  it('fills "Current company" with the current employer', () => {
    expect(classifyLabel('Current company')).toBe('currentCompany');
    expect(classifyLabel('Current employer')).toBe('currentCompany');
    expect(valueForField('currentCompany', candidate)).toBe('Northwind Analytics');
  });

  it('never fills someone else\'s company, or guesses when no role is current', () => {
    for (const label of ['Previous employer', 'Reference company', 'Company name of your reference', 'Company']) {
      expect(classifyLabel(label)).not.toBe('currentCompany');
    }
    const none = { workHistory: [{ employer: 'Old Co', current: false }] };
    expect(valueForField('currentCompany', none)).toBeNull();
    const two = { workHistory: [{ employer: 'A', current: true }, { employer: 'B', current: true }] };
    expect(valueForField('currentCompany', two)).toBeNull();
  });
});

describe('uploads: accepted formats and widgets that clear their input', () => {
  it('reads accept lists by extension and MIME type', () => {
    expect([...acceptedExtensions('.doc,.docx,.pdf')]).toEqual(['.doc', '.docx', '.pdf']);
    expect([...acceptedExtensions('application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document')]).toEqual(['.pdf', '.docx']);
    expect(acceptedExtensions('')).toBeNull();
    expect(acceptedExtensions('*/*')).toBeNull();
  });

  it('sends the same document in an accepted format, never a different document', () => {
    expect(documentFormats(LETTER_TXT)).toEqual([LETTER_TXT, LETTER_DOCX]);
    expect(fileForInput(LETTER_TXT, '.doc,.docx,.pdf')).toEqual({ path: LETTER_DOCX, substituted: true });
    expect(fileForInput(LETTER_TXT, '')).toEqual({ path: LETTER_TXT, substituted: false });
    expect(fileForInput(RESUME, '.pdf').path).toBeNull(); // no PDF of this resume exists
  });

  it('counts a file as attached when the slot shows it, and an error as a rejection', () => {
    const path = '/x/Priya_Raghunathan_Resume_Senior.docx';
    const before = 'Total 0 file selected Drop or select (.doc / .docx / .pdf)';
    expect(slotShowsFile(before, 'Total 1 file selected Priya_Raghunatha...docx', path)).toMatchObject({ shown: true });
    expect(slotShowsFile(before, 'Priya_Raghunatha…docx', path)).toMatchObject({ shown: true });
    expect(slotShowsFile(before, 'Priya_Raghunathan_Resume_Senior.docx', path)).toMatchObject({ shown: true });
    expect(slotShowsFile(before, before, path)).toMatchObject({ shown: false });
    expect(slotShowsFile(before, "The type of the file x.txt isn't supported.", path)).toMatchObject({ shown: false, rejected: true });
  });
});

describe('assistApply on a copy of the Rippling application step (real Chromium, local file)', () => {
  let session;
  let available = true;

  beforeAll(async () => {
    try { session = await createBrowserSession({ headless: true }); }
    catch (err) { available = browserUnavailable(err); }
  }, 60000);
  afterAll(async () => { await session?.close?.(); }, 30000);

  async function run(answers) {
    const memory = { state: null };
    const packet = {
      job: { id: 'rippling-fixture', url: pathToFileURL(join(FIXTURES, 'audit', 'rippling_application.html')).href, title: 'Senior Analytics Engineer', company: 'Example Co' },
      fillPlan: {
        steps: [],
        uploads: [
          { type: 'resume', path: RESUME, required: true, selector: 'input[type="file"]' },
          { type: 'coverLetter', path: LETTER_TXT, required: false },
        ],
      },
      screeningPlan: { answered: [], needsUser: [] },
      blockers: [],
    };
    const result = await assistApply({
      packet,
      config: { candidate, screeningAnswers: answers, runtime: { headless: true } },
      options: { headless: true, userDataDir: false, watchHumanSubmit: false },
      deps: {
        createSession: async () => ({ page: session.page, close: async () => {} }),
        ownershipCheck: () => ({ ok: true }),
        stateStore: { path: null, load: async () => memory.state, save: async (s) => { memory.state = s; } },
        formWaitMs: 1500,
      },
    });
    const page = session.page;
    const dom = await page.evaluate(() => {
      const v = (id) => { const el = document.getElementById(id); return el.tagName === 'INPUT' ? el.value : el.textContent.trim(); };
      return {
        first: v('field-8'), last: v('field-12'), email: v('field-16'), company: v('field-20'), code: v('field-27'),
        phone: v('field-24'), location: v('field-35'), sponsorship: v('field-48'), authorized: v('field-54'),
        stemOpt: v('field-60'), employedBefore: v('field-72'), fit: v('field-90'), salary: v('field-94'),
        gender: v('field-98'), race: v('field-104'),
        openLists: document.querySelectorAll('[role="listbox"]').length,
        attached: window.__attached || [], submitted: window.__submitted === true,
      };
    });
    return { result, state: memory.state, dom, page };
  }

  it('fills everything it has an answer for, and asks the rest by their real questions', async (ctx) => {
    if (!available) return ctx.skip();
    const { result, dom } = await run(screeningAnswers);

    // Profile fields, including the current employer and the location typeahead.
    expect(dom).toMatchObject({
      first: 'Priya', last: 'Raghunathan', email: candidate.contact.email, company: 'Northwind Analytics',
      code: '+1 US', location: 'Durham, NC, USA',
    });
    expect(dom.phone).not.toBe('');
    // Saved answers on custom dropdowns and on a field named only by a <p>.
    expect(dom.sponsorship).toBe('Yes'); // the candidate requires sponsorship
    expect(dom.authorized).toBe('Yes');
    expect(dom.salary).toBe(screeningAnswers.answers.find((a) => a.id === 'salary_expectation').answer);
    // Nothing invented for questions with no saved answer.
    expect(dom).toMatchObject({ stemOpt: 'Select', employedBefore: 'Select', fit: '', gender: 'Select...', race: '' });

    // The person is asked by the real question, with the form's own choices.
    const asked = Object.fromEntries(result.needsUser.map((n) => [n.label, n]));
    expect(asked['Do you currently have an active STEM OPT?']).toMatchObject({ required: true, options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] });
    expect(asked['Have you ever been employed by this company before?']).toMatchObject({ required: true });
    expect(asked['Why do you feel you are a good fit for this role?']).toMatchObject({ required: true });
    expect(asked.Gender).toMatchObject({ required: false });
    expect(asked.Gender.options.map((o) => o.label)).toEqual(['Male', 'Female', 'Non-binary', 'Choose not to disclose']);
    expect(asked['Please identify your race'].options.map((o) => o.label)).toContain('Decline to self-identify');
    for (const label of Object.keys(asked)) {
      expect(label).not.toMatch(/^(?:Search|textbox|Select(?:\.\.\.)?)$/);
      expect(label).not.toMatch(/^[\w-]{8,12}$/); // a random field key
    }

    // Uploads: the resume, and the cover letter as .docx (the slot refuses .txt).
    const up = Object.fromEntries(result.uploads.uploaded.map((u) => [u.type, u]));
    expect(up.resume).toMatchObject({ verified: true, path: RESUME });
    expect(up.coverLetter).toMatchObject({ verified: true, path: LETTER_DOCX, plannedPath: LETTER_TXT });
    expect(dom.attached.sort()).toEqual(['Fixture_Cover_Letter_Analytics_Engineer.docx', 'Fixture_Resume_Analytics_Engineer.docx']);
    expect(result.blockers.join(' ')).not.toMatch(/did not remain attached|isn't supported|upload input not found/);

    // Required questions without an answer stop the run; nothing is submitted.
    expect(result.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(dom.openLists).toBe(0);
    expect(dom.submitted).toBe(false);
  }, 90000);

  it('with every required question answered, the form is complete and ready for the person', async (ctx) => {
    if (!available) return ctx.skip();
    const answers = {
      ...screeningAnswers,
      answers: [
        ...screeningAnswers.answers,
        { id: 'stem_opt', patterns: ['active stem opt'], answer: 'No' },
        { id: 'employed_before', patterns: ['employed by this company before'], answer: 'No' },
        { id: 'why_fit', patterns: ['good fit for this role'], answer: 'I build the semantic models and pipelines this team runs on.' },
        { id: 'gender', patterns: ['gender'], answer: 'Choose not to disclose' },
      ],
    };
    const { result, dom, page } = await run(answers);
    expect(dom).toMatchObject({
      sponsorship: 'Yes', authorized: 'Yes', stemOpt: 'No', employedBefore: 'No', gender: 'Choose not to disclose',
      fit: 'I build the semantic models and pipelines this team runs on.',
    });
    expect(await unfilledRequiredControls(page)).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(dom.openLists).toBe(0);
    expect(dom.submitted).toBe(false);
  }, 90000);
});
