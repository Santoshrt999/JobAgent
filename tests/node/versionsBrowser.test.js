/**
 * Document versions and refine requests in a real browser (P2-2): the
 * comparison renders the changed words, Restore adds a version, and a refine
 * request the resume cannot back says so on screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { recordVersion } from '../../src/apply/documentVersions.js';
import { refineRewrites } from '../../src/resume/rewrites.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const ROLE = 'Data Engineer, Acme Corp | 2021 - Present';
const UNITS = [{ id: 'u2', kind: 'bullet', role: ROLE, text: 'Developed Power BI semantic models for 12 finance teams.' }];
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', RESUME_REWRITE: 'suggest' };
const refineDeps = {
  readMasterUnitsFn: async () => UNITS,
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
    edits: [], declined: 'No bullet mentions Kafka, so it was not added.',
  }) } }] }) }),
};

let dash; let browser; let available = true;
beforeAll(async () => {
  try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
  dash = await startTestDashboard({ deps: {
    rewriteEnv: ENV, refineRewritesImpl: (args) => refineRewrites({ ...args, env: ENV, deps: refineDeps }),
  } });
  const folder = join(dash.root, 'applications', 'output', 'Globex');
  mkdirSync(folder, { recursive: true });
  const resume = join(folder, 'Resume.docx');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const write = (lines) => execFileSync(py, ['-c', 'import sys, json\nfrom docx import Document\nd = Document()\nfor l in json.loads(sys.argv[2]): d.add_paragraph(l)\nd.save(sys.argv[1])', resume, JSON.stringify(lines)]);
  write(['Test Person', 'Built pipelines on Azure.']);
  recordVersion(folder, { cause: 'generated', files: { resume } });
  write(['Test Person', 'Built medallion pipelines on Azure Databricks.']);
  recordVersion(folder, { cause: 'generated', files: { resume } });
  const packetPath = join(folder, 'packet.json');
  writeFileSync(packetPath, JSON.stringify({ id: 'pk', job: { id: 'v-1' }, blockers: [], stopBeforeSubmit: true }));
  const now = new Date().toISOString();
  dash.db.upsertJob({
    id: 'v-1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/3',
    source: 'greenhouse', score: 88, tier: 'Priority', status: 'prepared', posted_at: now, created_at: now,
    application_packet_path: packetPath, output_folder_path: folder, resume_docx_path: resume, resume_path: resume,
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await dash?.stop(); });

describe('document versions and refine (real browser)', { timeout: 120_000 }, () => {
  it('compares two versions, restores one, and shows a declined refine request', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('row', { name: /Globex.*Senior Data Engineer/ }).click();

    const versions = page.locator('#verBody');
    await versions.locator('.ver-list li').first().waitFor();
    expect(await versions.locator('.ver-list li').count()).toBe(2);
    await versions.getByRole('button', { name: 'Compare' }).click();
    await versions.locator('#verDiff ins').first().waitFor();
    expect(await versions.locator('#verDiff').textContent()).toMatch(/Changes from v1 to v2:/);
    expect(await versions.locator('#verDiff ins').allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/medallion/)]));

    await versions.getByRole('button', { name: 'Restore v1' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#verBody .ver-list li').length === 3);
    expect(await versions.locator('.ver-list li').first().textContent()).toMatch(/^v3 · Restored/);

    const rewrites = page.locator('#rwBody');
    await rewrites.waitFor();
    await rewrites.getByLabel('Ask for a specific change').fill('Say I used Kafka');
    await rewrites.getByRole('button', { name: 'Ask', exact: true }).click();
    await rewrites.locator('.rw-declined').waitFor();
    expect(await rewrites.locator('.rw-declined').textContent()).toBe('Not changed: No bullet mentions Kafka, so it was not added.');
  });
});
