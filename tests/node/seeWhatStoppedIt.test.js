/**
 * "See what stopped it" on a blocked application card.
 *
 * Regression: the button only reselected the job. The board had usually
 * selected it already and the rail beside it showed it, so a click changed
 * nothing on screen and read as broken. It must bring "Needs attention" into
 * view inside the rail (not by scrolling the window under the sticky header),
 * mark it, and hand focus to the way out ("Retry auto-fill") — every click.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser, startTestDashboard } from './helpers/dashboardPage.js';

describe('See what stopped it', () => {
  let dash;
  let browser;
  beforeAll(async () => {
    dash = await startTestDashboard();
    dash.db.upsertJob({
      id: 'blk', company: 'Northwind', title: 'Lead Data Engineer', location: 'Atlanta, GA',
      url: 'https://careers.northwind.test/job/1', source: 'greenhouse', score: 88, tier: 'Queue',
      sponsorship: 'Unconfirmed', status: 'assist_blocked', jd_text: 'Build pipelines. '.repeat(40),
      assist_blockers: JSON.stringify(['resume: upload input not found (input[type="file"])']),
    });
    browser = await launchBrowser();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); }, 30_000);

  for (const [label, viewport] of [['desktop rail', { width: 1440, height: 900 }], ['phone sheet', { width: 390, height: 844 }]]) {
    it(`reveals the reason and focuses the retry (${label})`, async () => {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(dash.url, { waitUntil: 'networkidle' });
      await page.locator('button').filter({ hasText: /^\s*Applications/ }).first().click();
      const go = page.locator('.ws-go', { hasText: 'See what stopped it' });
      await go.first().click();
      // On the desktop the job is now open beside the board: the SECOND click
      // is the one that used to do nothing.
      if (viewport.width > 900) await go.first().click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('↻ Retry auto-fill');
      const state = await page.evaluate(() => ({
        spot: [...document.querySelectorAll('.rail-sec.is-spotlit')].map((n) => n.dataset.section),
        windowScrolled: window.scrollY,
        offramp: document.querySelector('.offramp')?.textContent ?? null,
      }));
      expect(state.spot).toEqual(['attention']);
      expect(state.windowScrolled).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    }, 60_000);
  }

  it('lets you record a stopped application you finished and submitted yourself', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(dash.url, { waitUntil: 'networkidle' });
    await page.locator('button').filter({ hasText: /^\s*Applications/ }).first().click();
    await page.locator('.ws-go', { hasText: 'See what stopped it' }).first().click();
    await page.locator('[data-section="next"]').getByRole('button', { name: '✓ I submitted it myself' }).click();
    await expect.poll(() => page.locator('#dlgSubmit').evaluate((d) => d.open)).toBe(true);
    await page.locator('#dlgSubmit').getByRole('button', { name: /I submitted this myself/ }).click();
    // Reported, pending your confirmation — never silently counted as applied.
    await expect.poll(() => dash.db.getJob('blk').status).toBe('submit_unverified');
    expect(Number(dash.db.getJob('blk').applied)).toBe(0);
    await expect.poll(() => page.locator('.ws-go', { hasText: 'Confirm it went through' }).count()).toBe(1);
    expect(await page.locator('.ws-go', { hasText: 'See what stopped it' }).count()).toBe(0);
    await page.close();
  }, 60_000);
});
