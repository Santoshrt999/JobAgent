/**
 * Backups from the dashboard (P1-6): the API lists and makes them, and the
 * System health window shows them and backs up on a click (real browser).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, waitUntilConnected } from './helpers/dashboardPage.js';

let root; let db; let dash;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dash-backups-'));
  db = openDatabase({ path: join(root, 'data', 'applied_jobs.db') });
  db.upsertJob({ id: 'j1', company: 'Acme', title: 'Data Engineer', url: 'https://x/1' });
  dash = await startDashboard({
    config: { root }, db, logger: null, port: 0,
    deps: { doctorFn: async () => ({ ok: true, summary: {}, checks: [{ id: 'x', label: 'Config', status: 'pass', detail: 'ok' }] }) },
  });
});
afterAll(async () => {
  await new Promise((r) => dash.server.close(r));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (p) => fetch(`${dash.url}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p) => fetch(`${dash.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' } })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

describe('backups API (P1-6)', () => {
  it('lists none, makes one, then lists it without absolute paths', async () => {
    expect((await get('/api/backups')).body).toMatchObject({ available: true, backups: [] });
    const made = await post('/api/backups');
    expect(made.status).toBe(200);
    expect(made.body.made).toHaveLength(1);
    const list = (await get('/api/backups')).body;
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]).toMatchObject({ label: 'manual', folder: 'data/backups' });
    expect(JSON.stringify(list)).not.toContain(root);
    expect(list.totalBytes).toBeGreaterThan(0);
  });
});

describe('System health shows backups (real browser)', { timeout: 120_000 }, () => {
  it('shows the last backup and backs up on "Back up now"', async (ctx) => {
    let browser;
    try { browser = await launchBrowser(); } catch (err) { browserUnavailable(err); return ctx.skip(); }
    try {
      const page = await (await browser.newContext()).newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(dash.url);
      await waitUntilConnected(page);
      await page.locator('[data-action="toggle-activity-menu"]').click();
      await page.getByRole('menuitem', { name: 'System health' }).click();
      const status = page.locator('#backupStatus');
      await status.waitFor();
      const before = await status.textContent();
      expect(before).toMatch(/^Last backup .+\. \d+ kept, using .+ in data\/backups\.$/);
      const keptBefore = Number(before.match(/(\d+) kept/)[1]);
      await page.getByRole('button', { name: 'Back up now' }).click();
      await page.waitForFunction((n) => {
        const m = document.getElementById('backupStatus')?.textContent.match(/(\d+) kept/);
        return m && Number(m[1]) === n + 1;
      }, keptBefore);
      expect(await status.textContent()).toMatch(/^Last backup just now\./);
    } finally {
      await browser.close();
    }
  });
});
