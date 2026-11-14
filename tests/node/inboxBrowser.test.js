/**
 * The Email replies window in a real browser (P1-7): checking the inbox shows
 * each suggestion with the sentence that shows it, and Record writes the
 * outcome on the application, only on that click.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';
import { startFakeImap } from './helpers/fakeImap.js';

let dash; let browser; let imap; let available = true;
beforeAll(async () => {
  try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
  imap = await startFakeImap([{
    uid: 21,
    header: 'From: Globex Talent <no-reply@us.greenhouse-mail.io>\nSubject: Your application to Globex\nMessage-ID: <m21@x>',
    body: 'Thank you for applying to Globex. Unfortunately, we will not be moving forward with your application.',
  }]);
  dash = await startTestDashboard({ deps: {
    inboxSettings: { enabled: true, reason: null, host: '127.0.0.1', port: imap.port, secure: false, user: 'me@example.com', password: 'p', lookbackDays: 30 },
    llmEnv: { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k' },
    draftReplyImpl: async () => ({
      to: 'no-reply@us.greenhouse-mail.io', subject: 'Re: Your application to Globex',
      text: 'Hello,\n\nThank you for letting me know.\n\nBest regards,\nTest Person', paragraphs: [], dropped: [], gaps: [],
    }),
  } });
  dash.db.upsertJob({
    id: 'ib-1', company: 'Globex', title: 'Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/1',
    source: 'greenhouse', status: 'submitted', applied: 1, applied_at: '2026-11-01T00:00:00Z',
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await dash?.stop(); await imap?.close(); });

describe('Email replies (real browser)', { timeout: 120_000 }, () => {
  it('shows the evidence and records the outcome only on Record', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.locator('[data-action="toggle-activity-menu"]').click();
    await page.getByRole('menuitem', { name: 'Email replies' }).click();
    const dialog = page.locator('#dlgInbox');
    await dialog.getByRole('button', { name: 'Check for replies' }).click();
    const card = dialog.locator('.inbox-item');
    await card.waitFor();
    expect(await card.locator('b').textContent()).toBe('Rejection');
    expect(await card.locator('blockquote').textContent()).toMatch(/Unfortunately, we will not be moving forward with your application/);
    expect(await dialog.locator('#inboxStatus').textContent()).toBe('Read 1 message(s); 1 matched an application; 1 new suggestion(s).');
    expect(dash.db.listEvents('ib-1').some((e) => e.event_type === 'application_outcome')).toBe(false);

    await card.getByRole('button', { name: 'Draft a reply' }).click();
    const draftBox = card.getByLabel(/Draft reply to no-reply@us.greenhouse-mail.io/);
    await draftBox.waitFor();
    expect(await draftBox.inputValue()).toContain('Thank you for letting me know.');
    expect(await card.getByRole('link', { name: 'Open in email app' }).getAttribute('href')).toMatch(/^mailto:no-reply(%40|@)us\.greenhouse-mail\.io\?/);

    await card.getByRole('button', { name: 'Record as Rejected' }).click();
    await dialog.getByText('No replies waiting for you.').waitFor();
    const outcome = dash.db.listEvents('ib-1').find((e) => e.event_type === 'application_outcome');
    expect(JSON.parse(outcome.metadata).outcome).toBe('rejected');
  });
});
