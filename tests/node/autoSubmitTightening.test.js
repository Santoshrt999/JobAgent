/**
 * Final Auto-submit only ever submits what a human reviewed, on a form the
 * live DOM says is complete, on a fixture-tested ATS.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { approve } from '../../src/apply/approvalQueue.js';
import {
  autoSubmitReviewProblem, evaluateAutoApplyEligibility, FIXTURE_VERIFIED_AUTO_APPLY_ATS,
} from '../../src/apply/autoApplyEligibility.js';
import { detectAts } from '../../src/apply/atsDetector.js';
import { requiredFieldsSatisfied } from '../../src/automation/fieldResolver.js';
import { unfilledRequiredControls } from '../../src/automation/domScanner.js';
import { unreviewedSensitiveAnswers } from '../../src/automation/applyRunner.js';

describe('ATS allowlist and detection', () => {
  it('never auto-submits on an unrecognised (generic) ATS, but still offers assisted fill', () => {
    expect(FIXTURE_VERIFIED_AUTO_APPLY_ATS).not.toContain('generic');
    const job = { id: 'j', url: 'https://careers.x.test/1', sponsorship: 'Confirmed', score: 90, applied: 0 };
    const packet = { ats: { platform: 'generic' }, resumePath: '/r.docx', blockers: [] };
    expect(evaluateAutoApplyEligibility({ job, packet, autoSubmitAuthorized: true }).eligible).toBe(false);
    expect(evaluateAutoApplyEligibility({ job, packet, autoSubmitAuthorized: false }).eligible).toBe(true);
  });

  it('detects a gh_jid embed on a company host as Greenhouse', () => {
    expect(detectAts({ url: 'https://careers.acme.test/jobs?gh_jid=4412' })).toMatchObject({ platform: 'greenhouse' });
    expect(detectAts({ url: 'https://careers.acme.test/jobs?id=4412' }).platform).toBe('generic');
  });
});

describe('review timing', () => {
  const start = '2026-09-22T10:00:00.000Z';
  const approval = { approval_status: 'approved', approved_by_user: 1, approved_at: '2026-09-22T09:00:00Z', packet_path: '/p1' };
  it('accepts a packet approved before the run and unchanged since', () => {
    expect(autoSubmitReviewProblem({ job: {}, approval, batchStartedAt: start, snapshotPacketPath: '/p1' })).toBeNull();
  });
  it('rejects late approvals, (re)preparation and replaced packets', () => {
    expect(autoSubmitReviewProblem({ job: {}, approval: { ...approval, approved_at: '2026-09-22T10:00:01Z' }, batchStartedAt: start }))
      .toMatch(/approved after/);
    expect(autoSubmitReviewProblem({ job: { prepared_at: '2026-09-22T10:05:00Z' }, approval, batchStartedAt: start }))
      .toMatch(/prepared after/);
    expect(autoSubmitReviewProblem({ job: {}, approval, batchStartedAt: start, snapshotPacketPath: '/p0' }))
      .toMatch(/replaced/);
    expect(autoSubmitReviewProblem({ job: {}, approval: { ...approval, approval_status: 'pending_review' }, batchStartedAt: start }))
      .toMatch(/not approved/);
  });
});

describe('live answers vs the reviewed packet', () => {
  const reviewed = [{ label: 'Will you require sponsorship?', answer: 'Yes, I require H-1B sponsorship.' }];
  it('passes a reviewed sponsorship answer and ignores non-sensitive ones', () => {
    expect(unreviewedSensitiveAnswers([
      { label: 'Will you require sponsorship?', value: 'Yes' },
      { label: 'Notice period', value: 'Two weeks' },
    ], reviewed)).toEqual([]);
  });
  it('flags an unreviewed or contradicting legal answer', () => {
    expect(unreviewedSensitiveAnswers([{ label: 'Will you require sponsorship?', value: 'No' }], reviewed)).toHaveLength(1);
    expect(unreviewedSensitiveAnswers([{ label: 'I certify the information is accurate', value: 'Yes' }], reviewed))
      .toHaveLength(1);
  });
});

describe('required fields', () => {
  it('strict mode is not vacuously satisfied by an empty plan', () => {
    expect(requiredFieldsSatisfied([], { steps: [] }).ok).toBe(true);
    expect(requiredFieldsSatisfied([], { steps: [] }, undefined, { strict: true }).ok).toBe(false);
    expect(requiredFieldsSatisfied([{ field: 'email' }], { steps: [] }, undefined, { strict: true }).ok).toBe(true);
  });

  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('reads blank required controls from the live DOM', async () => {
    const page = await browser.newPage();
    await page.setContent(`<style>input,select{display:block;width:200px;height:24px}</style>
      <label for="e">Email</label><input id="e" required value="a@b.test">
      <label for="w">Why us?</label><textarea id="w" aria-required="true"></textarea>
      <label for="s">Start date</label><select id="s" required><option value=""></option><option>Now</option></select>
      <input type="radio" name="r" value="y" required aria-label="Relocate"><input type="radio" name="r" value="n">
      <input id="hidden" required style="display:none">`);
    expect(await unfilledRequiredControls(page)).toEqual(['Why us?', 'Start date', 'Relocate']);
    await page.fill('#w', 'Because');
    await page.selectOption('#s', 'Now');
    await page.check('input[value="y"]');
    expect(await unfilledRequiredControls(page)).toEqual([]);
    expect(await unfilledRequiredControls({})).toBeNull();
    await page.close();
  }, 30_000);
});

describe('auto-submit batch route', () => {
  let db; let dash; let calls;
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const waitIdle = async () => {
    for (let i = 0; i < 100; i += 1) {
      const s = await fetch(dash.url + '/api/run/status').then((r) => r.json());
      if (!s.running) return s;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('batch never finished');
  };

  async function boot(extraDeps = {}) {
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        liveVerifiedAts: ['greenhouse'], // a supervised live run is on record (P1-11)
        loadPacketImpl: () => ({
          id: 'pk', job: { id: 'j1', url: 'https://boards.greenhouse.io/acme/jobs/1' }, ats: { platform: 'greenhouse' },
          blockers: [], resumePath: '/r.docx', prefill: { plan: [], needsUser: [] },
          screeningPlan: { answered: [], needsUser: [] }, uploads: { blockers: [] },
        }),
        assistFn: async ({ options }) => {
          calls.push(options);
          return {
            status: 'ready_for_submit', submitted: false, blockers: [],
            liveAnswers: [{ label: 'Notice period', value: 'Two weeks', step: 1 }],
          };
        },
        ...extraDeps,
      },
    });
  }

  beforeEach(() => {
    calls = [];
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'j1', company: 'Acme', title: 'DE', url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse',
      score: 90, tier: 'Priority', sponsorship: 'Confirmed', status: 'prepared', application_packet_path: '/p/j1.json',
    });
    db.insertApproval({ id: 'ap1', job_id: 'j1', packet_path: '/p/j1.json', approval_status: 'pending_review' });
  });
  afterEach(async () => { await dash?.close(); db.close(); });

  it('does not approve-and-submit a packet nobody approved before the run', async () => {
    await boot();
    expect((await post('/api/auto-submit-batch', { jobIds: ['j1'], confirmed: true })).status).toBe(202);
    const run = await waitIdle();
    expect(calls).toHaveLength(0);
    expect(run.lastResult.skipped[0].reason).toMatch(/not auto-submitted: .*not approved before/);
    expect(db.getApprovalByJob('j1').approval_status).toBe('pending_review');
  });

  it('runs a pre-approved packet and records the live answers', async () => {
    approve(db, 'ap1');
    await new Promise((r) => setTimeout(r, 5));
    await boot();
    await post('/api/auto-submit-batch', { jobIds: ['j1'], confirmed: true });
    const run = await waitIdle();
    expect(calls).toEqual([{ autoSubmit: true }]);
    expect(run.lastResult.results[0].liveAnswers).toEqual([{ label: 'Notice period', value: 'Two weeks', step: 1 }]);
  });

  it('fails the whole batch once, with one line, when the browser is not installed', async () => {
    await boot({ browserPreflight: async () => ({ ok: false, code: 'browser_unavailable', message: 'Browser not installed — run: npx playwright install chromium' }) });
    await post('/api/assist-batch', { jobIds: ['j1'] });
    const run = await waitIdle();
    expect(calls).toHaveLength(0);
    expect(run.lastResult.environment).toBe('browser_unavailable');
    expect(run.lastResult.skipped[0].reason).toBe('browser_unavailable: Browser not installed — run: npx playwright install chromium');
    expect(db.getApprovalByJob('j1').approval_status).toBe('pending_review');
  });
});
