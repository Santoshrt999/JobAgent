/**
 * A human who finishes a stopped application in the window auto-fill left
 * open must be noticed even when the ATS shows no "thank you" text.
 *
 * Regression (Oracle Recruiting Cloud, 2026-11-12): the person ticked the
 * privacy box, completed /apply/section/1 and pressed Submit; Oracle went
 * straight to /my-profile ("My Applications") with no confirmation phrase.
 * The watcher only trusted that phrase, recorded nothing, and the job stayed
 * "Needs your help".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import {
  postSubmitDestination, SUBMIT_CONFIRMATION_RE, watchForHumanSubmission,
} from '../../src/automation/applyRunner.js';

const ORACLE = 'https://acme.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1';

describe('postSubmitDestination', () => {
  it('counts Oracle "My Applications" only when reached from the application form', () => {
    expect(postSubmitDestination([`${ORACLE}/job/9/apply/email`, `${ORACLE}/job/9/apply/section/1`], `${ORACLE}/my-profile`))
      .toBe('Oracle Recruiting "My Applications"');
    // From the email step (no form filled) or from the posting: not evidence.
    expect(postSubmitDestination([`${ORACLE}/job/9/apply/email`], `${ORACLE}/my-profile`)).toBeNull();
    expect(postSubmitDestination([`${ORACLE}/job/9`], `${ORACLE}/my-profile`)).toBeNull();
    expect(postSubmitDestination([], `${ORACLE}/my-profile`)).toBeNull();
  });

  it('knows the Greenhouse and Lever thank-you pages', () => {
    const gh = 'https://job-boards.greenhouse.io/acme/jobs/123';
    expect(postSubmitDestination([gh], `${gh}/confirmation`)).toBe('Greenhouse confirmation');
    const lever = 'https://jobs.lever.co/acme/1f2e';
    expect(postSubmitDestination([`${lever}/apply`], `${lever}/thanks`)).toBe('Lever thank-you page');
    expect(postSubmitDestination([lever], `${lever}/thanks`)).toBeNull();
  });

  it('reads more ways of saying "received"', () => {
    for (const text of ['Thank you for your job application.', 'Your application was successfully submitted',
      "You've successfully applied to Data Engineer"]) {
      expect(SUBMIT_CONFIRMATION_RE.test(text)).toBe(true);
    }
    expect(SUBMIT_CONFIRMATION_RE.test('Apply for this job')).toBe(false);
  });
});

describe('the hand-off watcher on an Oracle-style finish', () => {
  let browser;
  let context;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.route(`${ORACLE}/**`, (route) => route.fulfill({
      status: 200, contentType: 'text/html',
      body: '<title>Example Corp Careers</title><main id="app"><input type="email" id="email"><button>Next</button></main>',
    }));
  }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  async function finish(steps) {
    const page = await context.newPage();
    await page.goto(`${ORACLE}/job/9/apply/email`);
    let seen = null;
    const watch = watchForHumanSubmission({ page, url: `${ORACLE}/job/9`, pollMs: 50, onConfirmed: (v) => { seen = v; } });
    await watch.ready;
    for (const [path, html] of steps) {
      await page.evaluate(([p, h]) => { history.pushState({}, '', p); document.getElementById('app').innerHTML = h; }, [path, html]);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(400);
    watch.stop();
    await page.close();
    return seen;
  }

  it('records it when the form is followed by "My Applications" (no thank-you text)', async () => {
    const seen = await finish([
      [`${ORACLE}/job/9/apply/section/1`, '<h2>Contact Information</h2><input id="fn"><button>Submit</button>'],
      [`${ORACLE}/my-profile`, '<h1>My Applications</h1><p>Lead Data Engineer — Under consideration</p>'],
    ]);
    expect(seen?.signals).toEqual(['post-submit page: Oracle Recruiting "My Applications"']);
  }, 30_000);

  it('does not when the person only visits their profile from the email step', async () => {
    const seen = await finish([[`${ORACLE}/my-profile`, '<h1>My Applications</h1>']]);
    expect(seen).toBeNull();
  }, 30_000);
});
