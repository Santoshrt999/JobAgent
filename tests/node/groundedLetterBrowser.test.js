/**
 * The packet section says how the cover letter was written (P1-3), in a real
 * browser on the real dashboard: grounded paragraphs with their backing, and
 * the paragraphs left out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

let dash; let browser; let available = true;
beforeAll(async () => {
  try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
  dash = await startTestDashboard();
  const packetPath = join(dash.root, 'packet-gl.json');
  writeFileSync(packetPath, JSON.stringify({
    id: 'pk-gl', job: { id: 'gl-1' }, blockers: [], stopBeforeSubmit: true, submitReady: false,
    coverLetterGenerated: true, coverLetterDocxPath: join(dash.root, 'Cover_Letter.docx'),
    coverLetterGrounding: {
      mode: 'grounded', task: 'cover-letter@1',
      paragraphs: [
        { text: 'At Acme Corp I built Azure Databricks pipelines that cut load time by 40%.', evidence: ['u2'] },
        { text: 'I developed Power BI models used by 12 finance teams.', evidence: ['u3'] },
      ],
      dropped: [{ text: 'I led a Kafka platform.', reasons: ['names things not in the cited resume text: Kafka'] }],
    },
  }));
  const now = new Date().toISOString();
  dash.db.upsertJob({
    id: 'gl-1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/9',
    source: 'greenhouse', score: 88, tier: 'Priority', status: 'prepared', posted_at: now, created_at: now,
    application_packet_path: packetPath,
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await dash?.stop(); });

describe('cover letter grounding in the packet (real browser)', { timeout: 120_000 }, () => {
  it('shows the grounded paragraphs, their backing and what was left out', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('row', { name: /Globex.*Senior Data Engineer/ }).click();
    const section = page.locator('.cl-grounding');
    await section.waitFor();
    expect(await section.getByRole('heading', { name: 'Cover letter' }).isVisible()).toBe(true);
    expect(await section.textContent()).toContain('Written from your resume: each of its 2 paragraphs uses only lines it cites.');
    expect(await section.getByText('At Acme Corp I built Azure Databricks pipelines that cut load time by 40%.').isVisible()).toBe(true);
    expect(await section.textContent()).toContain('(backed by 1 resume line(s))');
    expect(await section.textContent()).toContain('1 suggested paragraph(s) were left out because your resume does not back them.');
    expect(await section.textContent()).toContain('Also saved as a Word document: Cover_Letter.docx');
  });
});
