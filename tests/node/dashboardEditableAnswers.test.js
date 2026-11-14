import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const app = ['dom.js', 'profile.js'].map((file) =>
  readFileSync(new URL(`../../src/dashboard/public/assets/js/${file}`, import.meta.url), 'utf8')
).join('\n').replace(/^export /gm, '');
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

it('preserves user-written answer punctuation through rendering and Save all answers', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="profileBody"></div>');
    // Run the real renderer and save handler against a real DOM, with only the
    // surrounding app/API replaced. No personal profile or database is read.
    await page.addScriptTag({ content: `
      const $ = (id) => document.getElementById(id);
      const fmt = String;
      const state = { profile: { screening: { answers: [] } } };
      const profileMessage = () => {};
      const toast = () => {};
      const renderProfile = async () => {};
      // The field rules and the Saving… label are the dialog's own concern
      // (profileDialogStability.test.js); here they stay out of the way.
      const ANSWER_HINTS = {};
      const answerProblems = () => [];
      const setAnswerError = () => {};
      const refreshAnswersSave = () => {};
      const parseAnswerError = () => null;
      const cssEscape = String;
      const withLabel = (button, label, fn) => fn();
      const postJson = async (path, body) => {
        window.savedAnswers = body.answers;
        return { count: body.answers.length };
      };
      ${between('const SVG_TAGS', 'function relTime')}
      ${between('function renderSavedAnswers', 'async function saveProfileDetails')}
      ${between('async function saveAllAnswers', 'function renderHealthProfileFlag')}
      window.renderSavedAnswers = renderSavedAnswers;
      window.saveAllAnswers = saveAllAnswers;
    ` });
    const answer = 'Yes — I can relocate. Available in 2–3 weeks.';
    await page.evaluate((text) => {
      document.getElementById('profileBody').append(window.renderSavedAnswers({
        answers: [{ id: 'relocation', patterns: ['relocate'], answer: text }],
      }));
    }, answer);
    expect(await page.locator('[data-a-answer]').inputValue()).toBe(answer);
    await page.evaluate(() => window.saveAllAnswers());
    expect(await page.evaluate(() => window.savedAnswers[0].answer)).toBe(answer);
  } finally {
    await page.close();
  }
});
