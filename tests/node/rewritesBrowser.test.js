/**
 * Rewrite suggestions in the real dashboard and a real browser (P1-2): the
 * diff renders visible insert/delete marks, a refused suggestion shows why and
 * has no Accept, and accepting is reflected on screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proposeRewrites } from '../../src/resume/rewrites.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const ROLE = 'Data Engineer, Acme Corp | 2021 - Present';
const UNITS = [
  { id: 'u1', kind: 'role', role: ROLE, text: ROLE },
  { id: 'u2', kind: 'bullet', role: ROLE, text: 'Built medallion pipelines on Azure Databricks with PySpark, cutting load time by 40%.' },
  { id: 'u3', kind: 'bullet', role: ROLE, text: 'Contributed to the migration of 3 legacy SSIS packages to Azure Data Factory.' },
];
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', RESUME_REWRITE: 'suggest' };
const deps = {
  readMasterUnitsFn: async () => UNITS,
  extractJdRequirementsFn: async () => ({ phrases: ['Databricks'] }),
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ rewrites: [
    { unitId: 'u2', rewrite: 'Cut load time by 40% with Azure Databricks medallion pipelines built in PySpark.', evidence: ['u2'] },
    { unitId: 'u3', rewrite: 'Led the migration of 3 legacy SSIS packages to Azure Data Factory.', evidence: ['u3'] },
  ] }) } }] }) }),
};

let dash; let db; let browser; let available = true;
beforeAll(async () => {
  try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
  dash = await startTestDashboard({
    deps: { rewriteEnv: ENV, proposeRewritesImpl: (args) => proposeRewrites({ ...args, env: ENV, deps }) },
  });
  db = dash.db;
  const now = new Date().toISOString();
  db.upsertJob({
    id: 'rw-1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/1',
    source: 'greenhouse', score: 86, tier: 'Priority', status: 'scored', posted_at: now, created_at: now, jd_text: 'Databricks.',
  });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await dash?.stop();
});

describe('rewrite suggestions (real browser)', { timeout: 120_000 }, () => {
  it('shows a marked diff, refuses what the resume cannot back, and records Accept', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('row', { name: /Globex.*Senior Data Engineer/ }).click();

    const section = page.locator('#rwBody');
    await section.getByRole('button', { name: 'Suggest rewrites' }).click();
    await section.locator('.rw-item').first().waitFor();

    const verified = section.locator('.rw-item.verified');
    await expect(verified.locator('ins').first().isVisible()).resolves.toBe(true);
    await expect(verified.locator('del').first().isVisible()).resolves.toBe(true);
    const insStyle = await verified.locator('ins').first().evaluate((n) => getComputedStyle(n).textDecorationLine);
    expect(insStyle).toContain('underline');

    const refused = section.locator('.rw-item.refused');
    expect(await refused.locator('.rw-refused').textContent()).toMatch(/^Not used: .*more ownership/);
    expect(await refused.getByRole('button', { name: 'Accept' }).count()).toBe(0);

    await verified.getByRole('button', { name: 'Accept' }).click();
    await page.waitForFunction(() => document.querySelector('.rw-item.verified [data-action="rewrite-accept"]')?.getAttribute('aria-pressed') === 'true');
    expect(await verified.locator('.rw-decision').textContent()).toMatch(/^Accepted\./);
    expect(await section.locator('#rwSummary').textContent()).toMatch(/1 accepted/);
  });
});
