/**
 * "I submitted it myself" on a stopped application, then settling it.
 *
 * Regression (2026-11-12, Oracle Recruiting): recording without a confirmation
 * number moved the job to submit_unverified, but
 *   1. "Do this next" kept showing the OLD blocked step (the rail kept the
 *      section because the dialog handed focus back to its button);
 *   2. the only way out offered was "I submitted it myself" again, which
 *      without a number changed nothing — a loop;
 *   3. the reason said "Auto-submit clicked Submit" to a person who had
 *      pressed Submit themselves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser, startTestDashboard } from './helpers/dashboardPage.js';
import { canTransition, LIFECYCLE } from '../../src/lifecycle.js';
import { openDatabase } from '../../src/logging/db.js';
import { retractSubmissionReport } from '../../src/dashboard/data.js';

const BLOCKER = 'form validation: You need to agree to the terms and conditions.';

describe('settling an unconfirmed submission in the dashboard', () => {
  let dash;
  let browser;
  beforeAll(async () => {
    dash = await startTestDashboard({ deps: { codeFreshness: () => null } });
    for (const id of ['yes', 'no']) {
      dash.db.upsertJob({
        id, company: id === 'yes' ? 'Northwind' : 'Contoso', title: 'Lead Data Engineer', location: 'Atlanta, GA',
        url: `https://careers.${id}.test/job/1`, source: 'oracleRecruiting', score: 88, tier: 'Queue',
        sponsorship: 'Unconfirmed', status: 'assist_blocked', jd_text: 'Build pipelines. '.repeat(40),
        assist_blockers: JSON.stringify([BLOCKER]),
      });
    }
    browser = await launchBrowser();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); }, 30_000);

  const panel = (page) => page.evaluate(() => ({
    attention: document.querySelector('[data-section="attention"]')?.innerText ?? '',
    next: document.querySelector('[data-section="next"]')?.innerText ?? '',
    focused: document.activeElement?.textContent?.trim() ?? '',
  }));

  async function openAndReport(page, company) {
    await page.goto(dash.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('row', { name: new RegExp(`${company}.*Lead Data Engineer`) }).click();
    await page.locator('[data-section="next"]').getByRole('button', { name: /I submitted it myself/ }).click();
    await page.locator('#dlgSubmit[open]').waitFor();
    await page.locator('#dlgSubmit').getByRole('button', { name: /I submitted this myself/ }).click();
  }

  it('shows the new step at once, says it was YOU, and confirms with "Yes"', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openAndReport(page, 'Northwind');
    await expect.poll(() => dash.db.getJob('yes').status).toBe('submit_unverified');
    // 1. "Do this next" is redrawn for the new state, not left on the old step.
    await expect.poll(async () => (await panel(page)).next).toContain('Yes, it went through');
    const after = await panel(page);
    expect(after.next).not.toContain('Retry auto-fill');
    expect(after.next).toContain("No, it didn't");
    expect(after.next).toContain('Add confirmation number');
    // 3. The reason names who reported it.
    expect(after.attention).toContain('You reported submitting this yourself');
    expect(after.attention).not.toMatch(/Auto-submit clicked/);
    // Focus was handed on, but never onto a statement of fact.
    expect(after.focused).not.toMatch(/Yes, it went through|No, it didn't/);

    // 2. One click finishes it — no number required.
    await page.getByRole('button', { name: '✓ Yes, it went through' }).click();
    await expect.poll(() => dash.db.getJob('yes').status).toBe('submitted');
    expect(Number(dash.db.getJob('yes').applied)).toBe(1);
    await expect.poll(async () => (await panel(page)).next).toMatch(/^Do this next\s+Submitted/);
    await page.close();
  }, 60_000);

  it('"No, it didn\'t" takes it back to finishing it, with the original reason', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openAndReport(page, 'Contoso');
    await expect.poll(() => dash.db.getJob('no').status).toBe('submit_unverified');
    await page.getByRole('button', { name: "No, it didn't" }).click();
    await expect.poll(() => dash.db.getJob('no').status).toBe('assist_blocked');
    expect(Number(dash.db.getJob('no').applied)).toBe(0);
    await expect.poll(async () => (await panel(page)).next).toContain('Retry auto-fill');
    expect((await panel(page)).attention).toContain('You need to agree to the terms and conditions.');
    await page.close();
  }, 60_000);
});

describe('who may take an unconfirmed submission back', () => {
  it('only the person, only to finishing it, never from a confirmed one', () => {
    const { SUBMIT_UNVERIFIED, ASSIST_BLOCKED, READY_FOR_SUBMIT, SUBMITTED } = LIFECYCLE;
    expect(canTransition(SUBMIT_UNVERIFIED, ASSIST_BLOCKED, { actor: 'human' })).toBe(true);
    expect(canTransition(SUBMIT_UNVERIFIED, READY_FOR_SUBMIT, { actor: 'human' })).toBe(true);
    expect(canTransition(SUBMIT_UNVERIFIED, ASSIST_BLOCKED)).toBe(false);
    expect(canTransition(SUBMITTED, ASSIST_BLOCKED, { actor: 'human' })).toBe(false);
  });

  it('refuses a job that is not an unconfirmed submission', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'done', title: 'A', status: 'submitted', applied: 1, score: 70, tier: 'Apply' });
    expect(() => retractSubmissionReport(db, 'done')).toThrow(/only an unconfirmed submission/);
    db.close();
  });

  it('goes back to "ready for your Submit" when that is where it came from', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'r', title: 'A', status: 'ready_for_submit', score: 70, tier: 'Apply' });
    db.setJobStatus('r', 'submit_unverified', { reason: 'marked by the user', actor: 'human' });
    expect(retractSubmissionReport(db, 'r')).toMatchObject({ to: 'ready_for_submit' });
    expect(db.getJob('r').status).toBe('ready_for_submit');
    db.close();
  });
});
