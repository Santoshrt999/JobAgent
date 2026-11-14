/**
 * What gets interviews (P2-9): exact counts per source, ATS, score band and
 * tier from recorded outcomes, and no rate for a group too small to mean
 * anything; plus the rendered words in a real browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { conversionBreakdown, scoreBand } from '../../src/domain/applicationOutcome.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const item = (source, score, reached, extra = {}) => ({ appStatus: 'submitted', source, atsPlatform: source, score, tier: score >= 85 ? 'Priority' : 'Apply', reached, ...extra });

describe('conversion breakdown (P2-9)', () => {
  it('counts interviews per group and withholds the rate below five', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item('greenhouse', 88, i < 3 ? 'interviewing' : 'applied')),
      item('lever', 72, 'offer'), item('lever', 75, 'applied'),
      { appStatus: 'scored', source: 'lever', score: 90 }, // not submitted: ignored
    ];
    const c = conversionBreakdown(items);
    expect(c.source).toEqual([
      { key: 'greenhouse', submitted: 6, interviews: 3, offers: 0, tooFew: false, interviewRate: 50 },
      { key: 'lever', submitted: 2, interviews: 1, offers: 1, tooFew: true, interviewRate: null },
    ]);
    expect(c.scoreBand.map((r) => r.key)).toEqual(['80-89', '70-79']);
    expect(c.tier.find((r) => r.key === 'Priority').submitted).toBe(6);
  });

  it('bands scores', () => {
    expect([scoreBand(74), scoreBand(90), scoreBand(100), scoreBand(null), scoreBand(3)]).toEqual(['70-79', '90-100', '90-100', null, '0-9']);
  });
});

describe('What gets interviews, in a real browser', { timeout: 120_000 }, () => {
  let dash; let browser; let available = true;
  beforeAll(async () => {
    try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
    dash = await startTestDashboard();
    for (let i = 0; i < 6; i += 1) {
      dash.db.upsertJob({ id: `c${i}`, company: `Co ${i}`, title: 'Data Engineer', url: `https://x/${i}`, source: 'greenhouse', ats_platform: 'greenhouse', score: 86, tier: 'Priority', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
    }
    dash.db.upsertJob({ id: 'l1', company: 'Lone', title: 'Analyst', url: 'https://x/l', source: 'lever', score: 70, tier: 'Apply', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
    for (const id of ['c0', 'c1']) {
      dash.db.insertEvent({ id: randomUUID(), job_id: id, event_type: 'application_outcome', message: 'outcome: interviewing', metadata: JSON.stringify({ outcome: 'interviewing', on: '2026-11-05' }) });
    }
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); });

  it('shows counts, a rate where there is enough, and "too few to tell" where there is not', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.locator('[data-action="set-view"][data-view="applications"]').first().click();
    await page.getByText('What gets interviews').click();
    const table = page.locator('.ws-conv-table').filter({ has: page.locator('caption', { hasText: 'Where you found it' }) });
    expect(await table.getByRole('row', { name: /greenhouse/ }).textContent()).toContain('2 of 6 reached an interview (33%)');
    expect(await table.getByRole('row', { name: /lever/ }).textContent()).toContain('1 sent; too few to tell (needs 5)');
  });
});

describe('conversion by apply speed (audit Backlog #16)', async () => {
  const { applySpeedBand } = await import('../../src/domain/applicationOutcome.js');
  it('bands the time from posting to applying', () => {
    const p = '2026-11-01T00:00:00Z';
    expect(applySpeedBand(p, '2026-11-01T10:00:00Z')).toBe('within a day');
    expect(applySpeedBand(p, '2026-11-03T00:00:00Z')).toBe('1-3 days');
    expect(applySpeedBand(p, '2026-11-06T00:00:00Z')).toBe('4-7 days');
    expect(applySpeedBand(p, '2026-11-20T00:00:00Z')).toBe('over a week');
    expect(applySpeedBand(null, '2026-11-20T00:00:00Z')).toBeNull();
    expect(applySpeedBand('2026-11-20T00:00:00Z', p)).toBeNull();
  });
  it('is one of the breakdown dimensions', () => {
    const items = [{ appStatus: 'submitted', postedAt: '2026-11-01T00:00:00Z', appliedAt: '2026-11-01T05:00:00Z', reached: null }];
    expect(conversionBreakdown(items).applySpeed[0].key).toBe('within a day');
  });
});
