/**
 * Archived jobs have a tab, and every decision has a named way back.
 *
 * Reported 2026-11-12: "I am able to archive jobs, how to unarchive them? I see
 * them in the Any status drop down, but not in the labels at the top. How do I
 * remove from shortlist, is that the Reject button?" Archived jobs had no tab,
 * and undoing a decision was a generic "Clear" under More actions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDecision, boardPage, dashboardStats, OPEN_ONLY_VIEWS } from '../../src/dashboard/data.js';
import { openDatabase } from '../../src/logging/db.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, openDashboard, startTestDashboard } from './helpers/dashboardPage.js';

function seed(db) {
  const now = new Date().toISOString();
  const job = (id, title) => db.upsertJob({
    id, company: 'Acme', title, url: `https://boards.greenhouse.io/acme/jobs/${id}`, source: 'greenhouse',
    score: 80, tier: 'Apply', status: 'scored', location: 'Remote, US', posted_at: now, created_at: now,
    jd_text: 'Build services and APIs.',
  });
  job('kept', 'Backend Engineer');
  job('gone', 'Archived Platform Engineer');
  job('star', 'Shortlisted Backend Developer');
  applyDecision(db, 'gone', 'archived');
  applyDecision(db, 'star', 'shortlisted');
}

describe('the Archived view (data)', () => {
  it('lists archived jobs, counts them, and is the one view that may show closed rows', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    expect(boardPage(db, { view: 'archived' }).jobs.map((j) => j.id)).toEqual(['gone']);
    expect(dashboardStats(db).views.archived).toBe(1);
    // The default board still hides it.
    expect(boardPage(db, {}).jobs.map((j) => j.id)).not.toContain('gone');
    expect(OPEN_ONLY_VIEWS.has('archived')).toBe(false);
    db.close();
  });
});

describe('Archived tab and named undo, in the dashboard', { timeout: 60_000 }, () => {
  let browser;
  let dash;
  let available = true;
  beforeAll(async () => {
    try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
    dash = await startTestDashboard();
    seed(dash.db);
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); }, 60_000);

  /** Open a job's detail. The title itself is a link to the posting, so click the company cell. */
  async function openRow(page, id) {
    await page.locator(`tr.job[data-id="${id}"] td`).last().click();
    await page.locator('.resume-card').first().waitFor();
  }

  async function withPage(fn) {
    const { page, context } = await openDashboard(browser, dash.url);
    try { return await fn(page); } finally { await context.close(); }
  }

  it('an archived job is found under the Archived tab and Unarchive brings it back', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      // The dashboard opens on Today; the tabs belong to the Jobs view.
      await page.locator('[data-action="set-view"][data-view="board"]').first().click();
      const tab = page.locator('#tabs [role="tab"]', { hasText: 'Archived' });
      await tab.waitFor();
      expect(await tab.innerText()).toMatch(/1/);
      await tab.click();
      await openRow(page, 'gone');

      const undo = page.locator('[data-action="decide"][data-decision="clear"]', { hasText: 'Unarchive' });
      await undo.waitFor();
      expect(await undo.isVisible()).toBe(true);
      // The decision it already has is not offered again.
      expect(await page.locator('[data-action="decide"][data-decision="archived"]').count()).toBe(0);
      await undo.click();
      await page.locator('.toast', { hasText: 'Unarchived' }).first().waitFor();
    });
    expect(dash.db.getJob('gone').user_decision ?? null).toBeNull();
  });

  it('a shortlisted job offers "Remove from shortlist", not only Reject', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await page.locator('[data-action="set-view"][data-view="board"]').first().click();
      await page.locator('#tabs [role="tab"]', { hasText: 'Shortlisted' }).click();
      await openRow(page, 'star');
      const undo = page.locator('[data-action="decide"][data-decision="clear"]', { hasText: 'Remove from shortlist' });
      await undo.waitFor();
      expect(await undo.isVisible()).toBe(true);
      expect(await page.locator('[data-action="decide"][data-decision="shortlisted"]').count()).toBe(0);
      await undo.click();
      await page.locator('.toast', { hasText: 'Removed from your shortlist' }).first().waitFor();
    });
    expect(dash.db.getJob('star').user_decision ?? null).toBeNull();
  });
});
