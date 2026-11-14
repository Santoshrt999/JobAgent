/**
 * "Use my template for this job instead" (cover-letter choice): the pipeline
 * honours it the next time the application is prepared, and the packet
 * section offers it and shows it (real browser).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { preparePacket } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { normalizeJob } from '../../src/search/normalize.js';
import { letterModeFor, setLetterMode } from '../../src/apply/letterMode.js';
import { loadTestConfig } from './helpers/testConfig.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', COVER_LETTER_MODE: 'grounded' };

async function tailorFn({ job, options = {} }) {
  mkdirSync(options.outputDir, { recursive: true });
  const path = join(options.outputDir, options.outputFilename ?? 'tailored.docx');
  writeFileSync(path, `tailored resume for ${job.company}`, 'utf8');
  return { tailored: true, output_path: path, pdf_path: null, validation: { ok: true, issues: [] }, warning: null, usedFallback: false };
}

describe('per-job cover-letter choice', () => {
  let root; let db; let logger; let config;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'letter-mode-'));
    db = openDatabase({ path: ':memory:' });
    logger = new JobLogger({ db, logger: createPinoLogger({ toFile: false }).logger });
    config = { ...base, root, coverLetter: { ...base.coverLetter, enabled: true, minScoreToGenerate: 0 } };
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  async function prepare(job) {
    let grounded = 0;
    const deps = {
      tailorFn, now: F.NOW, skipResumeIdentityCheck: true, env: ENV,
      composeGroundedLetterFn: async () => {
        grounded += 1;
        return { ok: true, body: 'First paragraph from the resume.\n\nSecond paragraph from the resume.', paragraphs: [{ text: 'a', evidence: ['u1'] }, { text: 'b', evidence: ['u2'] }], dropped: [], provenance: { task: 'cover-letter@1' } };
      },
      writeLetterDocxFn: async () => null, recordVersionFn: () => null,
    };
    const score = { total: 90, matchedKeywords: [], missingKeywords: [], breakdown: {} };
    const path = await preparePacket({ config, db, logger, job, score, tier: 'Apply', deps, counters: { jobs_prepared: 0 } });
    return { packet: JSON.parse(readFileSync(path, 'utf8')), grounded };
  }

  it('writes the grounded letter by default, and the template once chosen', async () => {
    const job = normalizeJob({ company: 'Globex', title: 'Data Engineer', postedAt: F.azureFabricSenior.postedAt, source: 'greenhouse', jdText: F.azureFabricSenior.jdText, sourceJobId: 'G1', url: 'https://boards.greenhouse.io/globex/jobs/1' });
    db.upsertJob({ id: job.id, company: job.company, title: job.title, url: job.url });

    const first = await prepare(job);
    expect(first.grounded).toBe(1);
    expect(first.packet.coverLetterGrounding.mode).toBe('grounded');

    setLetterMode(db, job.id, 'template');
    expect(letterModeFor(db, job.id)).toBe('template');
    const second = await prepare(job);
    expect(second.grounded).toBe(0); // no model call at all
    expect(second.packet.coverLetterGrounding).toMatchObject({ mode: 'template', fallbackReason: 'you chose your template for this job' });

    setLetterMode(db, job.id, 'default');
    expect((await prepare(job)).packet.coverLetterGrounding.mode).toBe('grounded');
  });

  it('refuses an unknown choice or job', () => {
    db.upsertJob({ id: 'j1', company: 'A', title: 'B', url: 'https://x/1' });
    expect(() => setLetterMode(db, 'j1', 'llm')).toThrow(/template or default/);
    expect(() => setLetterMode(db, 'nope', 'template')).toThrow(/unknown job/);
  });
});

describe('the switch in a real browser', { timeout: 120_000 }, () => {
  let dash; let browser; let available = true;
  beforeAll(async () => {
    try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
    dash = await startTestDashboard();
    const packetPath = join(dash.root, 'packet-lm.json');
    writeFileSync(packetPath, JSON.stringify({
      id: 'pk', job: { id: 'lm-1' }, blockers: [], stopBeforeSubmit: true, coverLetterGenerated: true,
      coverLetterGrounding: { mode: 'grounded', paragraphs: [{ text: 'From the resume.', evidence: ['u1'] }], dropped: [] },
    }));
    const now = new Date().toISOString();
    dash.db.upsertJob({ id: 'lm-1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/5', source: 'greenhouse', score: 88, tier: 'Priority', status: 'prepared', posted_at: now, created_at: now, application_packet_path: packetPath });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); });

  it('offers "Use my template", then shows the choice and the way back', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('row', { name: /Globex.*Senior Data Engineer/ }).click();
    const section = page.locator('.cl-grounding');
    await section.getByRole('button', { name: 'Use my template for this job instead' }).click();
    await section.locator('.cl-choice').waitFor();
    expect(await section.locator('.cl-choice').textContent()).toBe('You chose your own template for this job. Prepare this application again to rebuild the letter.');
    expect(await section.getByRole('button', { name: 'Write it from my resume again' }).isVisible()).toBe(true);
    expect(letterModeFor(dash.db, 'lm-1')).toBe('template');
  });
});
