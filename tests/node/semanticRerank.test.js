/**
 * Rank by meaning (P2-1): the meaning score is computed from embeddings with
 * the closest resume bullets as the reason, the fit score is untouched, and
 * the window orders by either (real browser).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cosine, rerank } from '../../src/scoring/semanticRerank.js';
import { embedSettings } from '../../src/llm/embeddings.js';
import { openDatabase } from '../../src/logging/db.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const BULLETS = [
  { id: 'u1', kind: 'bullet', role: 'R', text: 'Built Spark pipelines' },
  { id: 'u2', kind: 'bullet', role: 'R', text: 'Designed Power BI dashboards' },
];
/** A deterministic fake embedder: "spark" and "dashboard" axes. */
const vecFor = (t) => { const s = t.toLowerCase(); return [s.includes('spark') ? 1 : 0.1, s.includes('dashboard') || s.includes('power bi') ? 1 : 0.1, 0.2]; };
const fetchImpl = async (_url, init) => {
  const { input } = JSON.parse(init.body);
  return { ok: true, json: async () => ({ data: input.map((t) => ({ embedding: vecFor(t) })) }) };
};
const ENV = { RERANK: 'on', RERANK_MODEL: 'test-embed', NVIDIA_API_KEY: 'k' };

function seed(db) {
  const now = new Date().toISOString();
  db.upsertJob({ id: 'bi', company: 'Globex', title: 'BI Developer', url: 'https://x/1', source: 'greenhouse', score: 90, tier: 'Priority', status: 'scored', posted_at: now, created_at: now, jd_text: 'Build Power BI dashboards for finance.' });
  db.upsertJob({ id: 'sp', company: 'Initech', title: 'Data Engineer', url: 'https://x/2', source: 'lever', score: 70, tier: 'Queue', status: 'scored', posted_at: now, created_at: now, jd_text: 'Spark and Delta pipelines.' });
}

describe('semantic rerank (P2-1)', () => {
  it('is off until configured, and cannot use Anthropic', () => {
    expect(embedSettings({}).reason).toMatch(/RERANK=on/);
    expect(embedSettings({ RERANK: 'on', RERANK_MODEL: 'm', LLM_PROVIDER: 'anthropic' }).reason).toMatch(/no embeddings API/);
    expect(embedSettings({ RERANK: 'on', RERANK_MODEL: 'nomic-embed-text', RERANK_PROVIDER: 'ollama' })).toMatchObject({ enabled: true, baseUrl: 'http://localhost:11434' });
  });

  it('scores meaning, keeps the fit score, and names the closest bullets', async () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const r = await rerank({ db, config: {}, env: ENV, deps: { fetchImpl, readMasterUnitsFn: async () => BULLETS } });
    const bi = r.items.find((i) => i.jobId === 'bi');
    const sp = r.items.find((i) => i.jobId === 'sp');
    expect(bi.fitScore).toBe(90);
    expect(bi.closest[0].text).toBe('Designed Power BI dashboards');
    expect(sp.closest[0].text).toBe('Built Spark pipelines');
    expect(db.getJob('bi').score).toBe(90);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    db.close();
  });
});

describe('the window (real browser)', { timeout: 120_000 }, () => {
  let dash; let browser; let available = true;
  beforeAll(async () => {
    try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
    dash = await startTestDashboard({ deps: {
      rerankEnv: ENV,
      rerankImpl: async (args) => rerank({ ...args, env: ENV, deps: { fetchImpl, readMasterUnitsFn: async () => BULLETS } }),
    } });
    seed(dash.db);
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); });

  it('shows both scores and reorders by either', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.locator('[data-action="toggle-activity-menu"]').click();
    await page.getByRole('menuitem', { name: 'Rank by meaning' }).click();
    await page.getByRole('button', { name: 'Rank top 50' }).click();
    const rows = page.locator('.rerank-table tbody tr');
    await rows.first().waitFor();
    const order = async () => rows.evaluateAll((trs) => trs.map((tr) => tr.dataset.job));
    await page.getByRole('button', { name: 'Order by fit score' }).click();
    expect(await order()).toEqual(['bi', 'sp']);
    expect(await rows.first().locator('td').nth(1).textContent()).toBe('90 (Priority)');
    await page.getByRole('button', { name: 'Order by meaning' }).click();
    const byMeaning = await order();
    expect(byMeaning).toHaveLength(2);
    expect(await page.locator('.rerank-table').textContent()).toContain('Designed Power BI dashboards');
  });
});
