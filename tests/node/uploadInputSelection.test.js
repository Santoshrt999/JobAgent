/**
 * File inputs are chosen by what they are labelled for, not by DOM order.
 *
 * Regressions: a generic `input[type="file"]` + `.first()` put the RESUME into
 * a cover-letter slot that came first in the DOM, and the current
 * job-boards.greenhouse.io markup matched none of the classic Greenhouse
 * selectors, so the resume could not be attached at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chooseFileInput, classifyFileInput, uploadFiles } from '../../src/automation/uploadRunner.js';
import { descriptor as greenhouse } from '../../src/apply/platforms/greenhouse.js';
import { descriptor as generic } from '../../src/apply/platforms/generic.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const RESUME = join(FIXTURES, 'sample_resume.txt');
const COVER = join(FIXTURES, 'sample_cover.txt');
const uploads = { uploads: { uploads: [{ type: 'resume', path: RESUME }, { type: 'coverLetter', path: COVER }] } };

describe('classifyFileInput', () => {
  it('reads the purpose from label text', () => {
    expect(classifyFileInput('Resume/CV *')).toBe('resume');
    expect(classifyFileInput('Cover Letter | cover_letter')).toBe('coverLetter');
    expect(classifyFileInput('Unofficial transcript')).toBe('transcript');
    expect(classifyFileInput('Resume or cover letter')).toBeNull();
    expect(classifyFileInput('')).toBeNull();
  });

  it('never gives the resume an input labelled for something else', () => {
    const inputs = [
      { index: 0, kind: 'coverLetter', hintFor: ['resume'] },
      { index: 1, kind: 'transcript', hintFor: [] },
    ];
    expect(chooseFileInput(inputs, 'resume')).toBeNull();
    expect(chooseFileInput([{ index: 0, kind: null, hintFor: [] }], 'resume')).toMatchObject({ index: 0 });
    expect(chooseFileInput([{ index: 0, kind: null, hintFor: [] }], 'coverLetter')).toBeNull();
  });
});

describe('uploads against real markup', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  async function attached(page) {
    return page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('input[type="file"]')]
        .map((el) => [el.id || el.closest('[id]')?.id, el.files?.[0]?.name ?? null]),
    ));
  }

  it('current job-boards.greenhouse.io form: resume and cover letter land in their own slots', async () => {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'greenhouse_job_boards_form.html')).href);
    const up = await uploadFiles(page, greenhouse.prepare(uploads));
    expect(up.blockers).toEqual([]);
    expect(await attached(page)).toEqual({
      cover_letter: 'sample_cover.txt', resume: 'sample_resume.txt', question_778: null,
    });
    expect(up.uploaded.every((u) => u.verified === true && u.matchedBy === 'label')).toBe(true);
    await page.close();
  }, 30_000);

  it('classic boards.greenhouse.io fieldset form still works', async () => {
    const page = await browser.newPage();
    await page.setContent(`<form>
      <fieldset id="resume_fieldset"><legend>Resume</legend><input type="file"></fieldset>
      <fieldset id="cover_letter_fieldset"><legend>Cover Letter</legend><input type="file"></fieldset></form>`);
    const up = await uploadFiles(page, greenhouse.prepare(uploads));
    expect(up.blockers).toEqual([]);
    expect(await attached(page)).toEqual({ resume_fieldset: 'sample_resume.txt', cover_letter_fieldset: 'sample_cover.txt' });
    await page.close();
  }, 30_000);

  it('generic `input[type=file]` hint never puts the resume into a cover-letter slot', async () => {
    const page = await browser.newPage();
    await page.setContent(`<form>
      <label for="cl">Cover letter</label><input id="cl" type="file">
      <label for="cv">CV</label><input id="cv" type="file"></form>`);
    const up = await uploadFiles(page, generic.prepare({ uploads: { uploads: [{ type: 'resume', path: RESUME }] } }));
    expect(up.blockers).toEqual([]);
    expect(await attached(page)).toEqual({ cl: null, cv: 'sample_resume.txt' });
    await page.close();
  }, 30_000);

  // Measured 2026-11-13 (Oracle Recruiting): the email step's ONLY file input is the
  // chat assistant's hidden "Attachment" button. With nothing saying what it was
  // for, the "only file input on the page" rule put the resume in it; the widget
  // cleared it and the run reported "upload did not remain attached".
  it('never offers a chat assistant\'s attachment input as a resume slot', async () => {
    const page = await browser.newPage();
    await page.setContent(`<main><h1>Authentication screen</h1></main>
      <div class="oda-chat-footer"><div class="oda-chat-footer-actions">
        <button>Attachment</button><input id="chat-file" type="file" style="display:none"></div></div>`);
    const up = await uploadFiles(page, generic.prepare({ uploads: { uploads: [{ type: 'resume', path: RESUME }] } }));
    expect(await attached(page)).toEqual({ 'chat-file': null });
    expect(up.uploaded).toEqual([]);
    expect(up.blockers.join(' ')).toMatch(/resume/);
    await page.close();
  }, 30_000);

  it('still uses the real resume slot when a chat widget sits beside it', async () => {
    const page = await browser.newPage();
    await page.setContent(`<form><label for="cv">Resume</label><input id="cv" type="file"></form>
      <div class="oda-chat-footer"><input id="chat-file" type="file"></div>`);
    const up = await uploadFiles(page, generic.prepare({ uploads: { uploads: [{ type: 'resume', path: RESUME }] } }));
    expect(up.blockers).toEqual([]);
    expect(await attached(page)).toEqual({ cv: 'sample_resume.txt', 'chat-file': null });
    await page.close();
  }, 30_000);
});
