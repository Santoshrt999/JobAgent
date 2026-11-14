/**
 * Regressions from the 2026-11-11 audit (docs/audits/FABLE_AUDIT_2026-11-11.md).
 *
 * Each browser case is a synthetic local page in tests/node/fixtures/audit/
 * that reproduced a defect through the REAL runner and Chromium: a value typed
 * into the wrong field, a sensitive question answered from a loose match, a
 * control clicked outside its scope, a final "Apply" clicked as a way in, a
 * form reported ready with required questions blank, a no-op "Next" counted
 * as progress, a confirmation phrase that was on the page before the click.
 * No network, no submission anywhere: every page is a file:// fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assistApply } from '../../src/automation/applyRunner.js';
import { createBrowserSession } from '../../src/automation/browser.js';
import { scanFields } from '../../src/automation/domScanner.js';
import { uploadFiles } from '../../src/automation/uploadRunner.js';
import { classifyLabel } from '../../src/apply/formPrefill.js';
import {
  answerScreeningQuestion, foreignCountryIn, mainClause, payPeriodOf, sensitiveTopic,
} from '../../src/apply/screeningQA.js';
import { LIFECYCLE } from '../../src/lifecycle.js';
import { browserUnavailable } from './helpers/browser.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const pageUrl = (name) => pathToFileURL(join(FIXTURES, 'audit', name)).href;
const candidate = JSON.parse(readFileSync(join(FIXTURES, 'config', 'candidate.json'), 'utf8'));
const screeningAnswers = JSON.parse(readFileSync(join(FIXTURES, 'config', 'screening_answers.json'), 'utf8'));

/* ─────────────────────────── label classifier (AF-02) ─────────────────────────── */

describe('classifyLabel keeps the candidate\'s details in the candidate\'s fields', () => {
  const NOT_MINE = [
    // "Current employer name" left this list on 2026-11-12: it now takes the
    // employer of the profile's current role (see ripplingApplication20261112),
    // still never the candidate's own name.
    'Middle Name', 'Company name', 'Name of school', 'School name', 'Reference name',
    'Emergency contact name', 'Emergency contact phone', 'Reference email', 'Recruiter email', 'Hiring manager name',
    'Previous name', 'Name pronunciation', 'University name', 'Degree name', 'Manager name and email',
    'Signature (type your full name)', 'Referred by (name)', 'Who referred you? Name', 'Company website',
    'Country of citizenship', 'Citizenship country', 'Country of birth', 'Preferred work location',
    'Desired location', 'Location of school', 'State any certifications',
  ];
  for (const label of NOT_MINE) {
    it(`leaves "${label}" to the human`, () => expect(classifyLabel(label)).toBeNull());
  }

  const MINE = {
    'First Name': 'firstName', 'Last Name': 'lastName', 'Legal name': 'fullName', 'Full name': 'fullName',
    Name: 'fullName', 'First and Last Name': 'fullName', 'Preferred name': 'preferredName', Email: 'email',
    'Email address': 'email', 'E-mail address': 'email', 'Phone number': 'phone', 'Mobile phone': 'phone',
    'Street address': 'addressLine1', 'Address line 2': 'addressLine2', City: 'city', State: 'state',
    'State/Province': 'state', 'Zip code': 'zip', Country: 'country', 'Country of residence': 'country',
    'Current location': 'location', 'LinkedIn profile': 'linkedin', 'Personal website': 'portfolio',
    'Which state are you located in?': 'state', 'What city do you live in?': 'city',
    'Current employer name': 'currentCompany', 'Current company': 'currentCompany',
  };
  for (const [label, field] of Object.entries(MINE)) {
    it(`still fills "${label}" from the profile`, () => expect(classifyLabel(label)).toBe(field));
  }
});

/* ─────────────────────────── screening matcher (AF-03) ─────────────────────────── */

describe('answerScreeningQuestion answers only the question that was asked', () => {
  const sponsor = { workAuthorization: { requiresSponsorship: true }, skillExperience: { python: '8 years' } };
  const ask = (q, choices) => answerScreeningQuestion(q, screeningAnswers, { choices, candidate: sponsor });
  const YN = ['Yes', 'No'];

  it.each([
    ['Have you ever failed a background check or drug screen?', YN],
    ['Have you ever been denied employment due to a background check?', YN],
    ['Will you require any accommodation to perform the essential functions of this job?', YN],
    ['Will you require relocation assistance?', YN],
    ['Will you require relocation assistance?', undefined],
    ['Are you legally authorized to work in Canada?', undefined],
    ['Do you have the right to work in the United Kingdom?', undefined],
    ['How many hours per month are you able to travel?', undefined],
    ['How many years have you lived at your current address?', undefined],
    ['Are you willing to relocate to Germany?', YN],
    ['Are you related to anyone who works here? (subject to background check)', YN],
    ['Have you previously been employed by Acme? If so, what was your start date?', undefined],
    ['Are you at least 18 years of age?', YN],
  ])('leaves "%s" to the human', (question, choices) => {
    expect(ask(question, choices).answered).toBe(false);
  });

  it.each([
    ['Do you consent to a background check?', YN, 'background_check'],
    ['What is your notice period?', undefined, 'start_date'],
    ['Do you now or will you in the future require sponsorship for employment visa status?', YN, 'require_sponsorship'],
    ['Are you legally authorized to work in the United States?', undefined, 'work_authorization'],
    ['How many years of experience do you have?', undefined, 'years_experience'],
    ['How many years of experience do you have with Python?', undefined, 'skill_experience'],
    ['What are your salary expectations?', undefined, 'salary_expectation'],
    ['What is your expected salary per month?', undefined, 'salary_expectation_monthly'],
    ['When can you start?', undefined, 'start_date'],
    ['Are you willing to relocate?', YN, 'relocation'],
  ])('still answers "%s"', (question, choices, id) => {
    const r = ask(question, choices);
    expect(r.answered, r.reason).toBe(true);
    expect(r.matchedId).toBe(id);
  });

  it('uses a saved answer to exactly this sensitive question, and one tagged for its topic', () => {
    const saved = {
      ...screeningAnswers,
      answers: [
        ...screeningAnswers.answers,
        { id: 'adult', patterns: ['are you at least 18 years of age'], answer: 'Yes' },
        { id: 'accommodation', topics: ['accommodation'], patterns: ['reasonable accommodation'], answer: 'No' },
      ],
    };
    expect(answerScreeningQuestion('Are you at least 18 years of age?', saved, { choices: YN }).answer).toBe('Yes');
    expect(answerScreeningQuestion('Are you 18 or older and able to lift 50 lb?', saved, { choices: YN }).answered).toBe(false);
    expect(answerScreeningQuestion('Will you need a reasonable accommodation?', saved, { choices: YN }).answer).toBe('No');
  });

  it('helpers read the main clause, the pay period, the topic and a foreign country', () => {
    expect(mainClause('Worked here before? If so, when did you start?')).toBe('Worked here before?');
    expect(mainClause('Related to staff? (subject to background check)')).toBe('Related to staff?');
    expect(payPeriodOf('Salary (In USD per month)')).toBe('month');
    expect(payPeriodOf('Around $150,000 per year')).toBe('year');
    expect(payPeriodOf('$45 hourly')).toBe('hour');
    expect(sensitiveTopic('Have you ever been convicted of a felony?')).toBe('negative_history');
    expect(sensitiveTopic('Do you consent to a background check?')).toBeNull();
    expect(foreignCountryIn('Are you authorized to work in Canada?')).toBe('canada');
    expect(foreignCountryIn('Are you authorized to work in the United States?')).toBeNull();
  });
});

/* ─────────────────────────── runner on real pages ─────────────────────────── */

describe('assistApply on the audit pages (real Chromium, local files, nothing sent)', () => {
  let session;
  let available = true;

  beforeAll(async () => {
    try { session = await createBrowserSession({ headless: true }); }
    catch (err) { available = browserUnavailable(err); }
  }, 60000);
  afterAll(async () => { await session?.close?.(); }, 30000);

  async function run(name, { options = {}, packet: extra = {}, answers = screeningAnswers } = {}) {
    const packet = {
      job: { id: `audit-${name}`, url: pageUrl(name), title: 'Role', company: 'Example Co' },
      fillPlan: { steps: [], uploads: [] },
      screeningPlan: { answered: [], needsUser: [] },
      blockers: [],
      ...extra,
    };
    const memory = { state: null };
    const result = await assistApply({
      packet,
      config: { candidate, screeningAnswers: answers, runtime: { headless: true } },
      options: { headless: true, userDataDir: false, watchHumanSubmit: false, ...options },
      deps: {
        createSession: async () => ({ page: session.page, close: async () => {} }),
        ownershipCheck: () => ({ ok: true }),
        stateStore: { path: null, load: async () => memory.state, save: async (s) => { memory.state = s; } },
        formWaitMs: 1500,
      },
    });
    return { result, page: session.page, state: memory.state };
  }

  it('AF-04: a phrase already on the page is not proof that Submit worked', async (ctx) => {
    if (!available) return ctx.skip();
    const { result, page } = await run('phrase_before_submit.html', { options: { autoSubmit: true } });
    expect(result.status).toBe(LIFECYCLE.SUBMIT_UNVERIFIED);
    expect(result.submitted).toBe(false);
    expect(await page.locator('#email').count()).toBe(1); // the form is still there
  }, 60000);

  it('AF-06: radio and checkbox groups are named by their question', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = await run('legend_groups.html');
    const labels = (await scanFields(page)).map((f) => `${f.kind}:${f.label}`);
    expect(labels).toEqual(expect.arrayContaining([
      'radio:Are you willing to relocate?', 'radio:Do you consent to a background check?',
      'checkbox:Which shifts can you work?: Day',
    ]));
  }, 60000);

  it('AF-07: an aria-required question that is unknown stops the run instead of reading "ready"', async (ctx) => {
    if (!available) return ctx.skip();
    const { result } = await run('aria_required.html');
    expect(result.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(result.blockers.join(' ')).toMatch(/Why do you want to work at Acme Hospital\?/);
    expect(result.blockers.join(' ')).toMatch(/Nursing license number/);
  }, 60000);

  it('AF-02/AF-03: nothing of the candidate\'s lands in someone else\'s field, and loose matches stay blank', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = await run('third_party_fields.html');
    const read = await page.evaluate(() => {
      const v = (id) => { const el = document.getElementById(id); return el.tagName === 'SELECT' ? el.selectedIndex : el.value; };
      return { mn: v('mn'), co: v('co'), ref: v('ref'), refmail: v('refmail'), ecp: v('ecp'), cit: v('cit'), bg: v('bg'), acc: v('acc'), reloc: v('reloc') };
    });
    // "Current company name" gets the employer of the profile's CURRENT role
    // (2026-11-12), never the candidate's own name (AF-02).
    expect(read).toEqual({ mn: '', co: 'Northwind Analytics', ref: '', refmail: '', ecp: '', cit: 0, bg: 0, acc: 0, reloc: '' });
  }, 60000);

  it('AF-05: a typeahead with no list of its own never clicks another question\'s control', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = await run('option_buttons.html');
    expect(await page.evaluate(() => window.__clicks)).toEqual([]);
  }, 60000);

  it('AF-08: a "Next" that changes nothing is reported, not counted as progress', async (ctx) => {
    if (!available) return ctx.skip();
    const { result, page } = await run('noop_next.html');
    expect(result.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(result.blockers.join(' ')).toMatch(/could not advance/);
    expect(await page.evaluate(() => window.__n)).toBe(1);
  }, 60000);

  it('AF-01: an id-less quick-apply form is filled, and its "Apply now" is never clicked', async (ctx) => {
    if (!available) return ctx.skip();
    const { result, page } = await run('idless_quick_apply.html');
    expect(await page.evaluate(() => window.__submitted === true)).toBe(false);
    expect(result.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(result.filled.map((f) => f.field)).toEqual(expect.arrayContaining(['email', 'phone']));
  }, 60000);

  it('a site display-language picker is page chrome: "Apply now" is still the way in (2026-11-12, Rippling)', async (ctx) => {
    if (!available) return ctx.skip();
    const resume = join(FIXTURES, 'sample_resume.txt');
    const { result, page } = await run('language_picker_posting.html', {
      packet: { fillPlan: { steps: [], uploads: [{ type: 'resume', path: resume, required: true }] } },
    });
    expect(page.url()).toMatch(/language_picker_apply\.html$/);
    expect(result.uploads.uploaded.map((u) => u.type)).toEqual(['resume']);
    expect(result.blockers.join(' ')).not.toMatch(/upload input not found/);
    expect(await page.evaluate(() => window.__submitted === true)).toBe(false);
    // The application's own language question is still a question.
    const labels = (await scanFields(page)).filter((f) => !f.incidental).map((f) => f.label);
    expect(labels).toContain('What languages do you speak?');
    expect(labels).not.toContain('Display language');
  }, 60000);

  it('a display-language COMBOBOX (Rippling\'s real markup) is page chrome; the "Apply now" button is clicked', async (ctx) => {
    if (!available) return ctx.skip();
    const resume = join(FIXTURES, 'sample_resume.txt');
    const { result, page } = await run('language_combobox_posting.html', {
      packet: { fillPlan: { steps: [], uploads: [{ type: 'resume', path: resume, required: true }] } },
    });
    expect(page.url()).toMatch(/language_picker_apply\.html$/);
    expect(result.uploads.uploaded.map((u) => u.type)).toEqual(['resume']);
    expect(result.blockers.join(' ')).not.toMatch(/upload input not found/);
    expect(await page.evaluate(() => window.__submitted === true)).toBe(false);
  }, 60000);

  it('a bare "Language" combobox counts as page chrome only when its value names a display language', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = await run('language_combobox_posting.html');
    await page.setContent(`<form>
      <label for="a">Language</label><input id="a" role="combobox" aria-autocomplete="list" value="English (UK)">
      <label for="b">Language</label><input id="b" role="combobox" aria-autocomplete="list" value="">
      <label for="c">Display language</label><input id="c" type="text" value="English">
    </form>`);
    const byId = Object.fromEntries((await scanFields(page)).map((f) => [f.selector, f.incidental ?? null]));
    expect(byId['#a']).toBe('language-picker');
    expect(byId['#b']).toBeNull(); // an empty "Language" question is a real question
    expect(byId['#c']).toBeNull(); // a plain text box is never a picker
  }, 60000);

  it('Rippling file slots are named through their dropzone label: resume and cover letter each go to their own slot', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = await run('language_combobox_posting.html');
    await page.goto(pageUrl('rippling_upload_slots.html'));
    // Both slots accept only .doc/.docx/.pdf, so .docx documents (a .txt is now
    // refused before it reaches the form; see ripplingApplication20261112).
    const resume = join(FIXTURES, 'audit', 'docs', 'Fixture_Resume_Analytics_Engineer.docx');
    const letter = join(FIXTURES, 'audit', 'docs', 'Fixture_Cover_Letter_Analytics_Engineer.docx');
    // Cover letter listed FIRST, and no selector hints: only the page's own words decide.
    const out = await uploadFiles(page, { uploads: [
      { type: 'coverLetter', path: letter, required: true },
      { type: 'resume', path: resume, required: true },
    ] });
    expect(out.blockers).toEqual([]);
    const slot = Object.fromEntries(out.uploaded.map((u) => [u.type, u.selector]));
    expect(slot).toEqual({ resume: 'input[type="file"] >> nth=0', coverLetter: 'input[type="file"] >> nth=1' });
    expect(out.uploaded.every((u) => u.matchedBy === 'label' && u.verified === true)).toBe(true);
  }, 60000);

  it('a page with no form and no way in says so, instead of "upload input not found"', async (ctx) => {
    if (!available) return ctx.skip();
    const resume = join(FIXTURES, 'sample_resume.txt');
    const { result } = await run('salary_thanks.html', {
      packet: { fillPlan: { steps: [], uploads: [{ type: 'resume', path: resume, required: true }] } },
    });
    expect(result.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(result.blockers.join(' ')).toMatch(/no application form found/);
    expect(result.blockers.join(' ')).not.toMatch(/upload input not found/);
  }, 60000);

  it('AF-09: a yes/no typeahead gets the choice, not the sentence, and the commit counts as filled', async (ctx) => {
    if (!available) return ctx.skip();
    const { result, page } = await run('react_select_yes_no.html');
    expect(await page.evaluate(() => document.getElementById('sv').textContent)).toBe('Yes');
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
  }, 60000);
});
