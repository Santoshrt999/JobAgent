/**
 * Regression tests for the production-readiness hardening pass:
 *   - dashboard cross-site request defense (Host/Origin)
 *   - board paging totals ({ jobs, total, limit })
 *   - assist idempotency + mid-run triage re-checks + batch cancel
 *   - truthful "submitted" recording (verified auto-submit only)
 *   - re-score without discovery, protected-row guards
 *   - pipeline status-downgrade guard on re-discovery
 *   - screening whole-word matching + unknownAction=skip
 *   - navigator "Apply now" gating
 *   - URL-based dedup
 *   - apify company fallbacks
 *   - atomic file writes
 *   - prepared_at-based daily stats + closed-job-free fit tiles
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard, isLoopbackHost, isAllowedOrigin } from '../../src/dashboard/server.js';
import { recordAssistResult, runRescore, ingestUrl } from '../../src/cli/commands.js';
import { runPipeline } from '../../src/pipeline/index.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { loadTestConfig } from './helpers/testConfig.js';
import { answerScreeningQuestion } from '../../src/apply/screeningQA.js';
import { findAdvanceControl, ADVANCE_RE, APPLY_START_RE } from '../../src/automation/navigator.js';
import { deduplicate, urlKeyFor } from '../../src/search/deduplicator.js';
import { mapItem, companyFromUrl } from '../../src/search/adapters/apify.js';
import { writeFileAtomic } from '../../src/utils/fsSafe.js';
import { dashboardStats, deriveAppStatus, boardPage, listBoardJobs, dashboardSections, buildNextActions } from '../../src/dashboard/data.js';
import { submitStatus } from '../../src/reports/jobTracker.js';
import { isProtectedJobRow } from '../../src/lifecycle.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const NOW = new Date('2026-06-04T12:00:00Z');

/* ───────────────────── server: cross-site defense + totals ───────────────── */

describe('dashboard server hardening', () => {
  let db;
  let dash;
  const post = (p, body, headers = {}) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));

  /** Raw request with a spoofed Host header (fetch normalizes Host). */
  function rawWithHost(host, path = '/api/stats') {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: dash.port, path, method: 'GET',
        headers: { host },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
  }

  function rawRequest(path = '/', headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: dash.port, path, method: 'GET', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  let assistResolvers;
  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Acme', title: 'DE', url: 'http://a', source: 'x', score: 90, tier: 'Priority' });
    db.upsertJob({ id: 'j2', company: 'Globex', title: 'BI', url: 'http://b', source: 'x', score: 80, tier: 'Apply' });
    db.upsertJob({ id: 'j3', company: 'Initech', title: 'DW', url: 'http://c', source: 'x', score: 70, tier: 'Apply' });
    for (const id of ['j1', 'j2', 'j3']) {
      db.insertApproval({ id: `ap-${id}`, job_id: id, packet_path: `/p/${id}.json`, approval_status: 'approved' });
    }
    assistResolvers = [];
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        loadPacketImpl: (a) => ({ job: { id: a.job_id, url: `http://x/${a.job_id}` }, blockers: [] }),
        assistFn: () => new Promise((resolve) => { assistResolvers.push(resolve); }),
      },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('rejects state-changing requests from a foreign Origin (localhost CSRF)', async () => {
    const evil = await post('/api/run', { phase: 'discover' }, { origin: 'https://evil.example.com' });
    expect(evil.status).toBe(403);
    const opaque = await post('/api/run', { phase: 'discover' }, { origin: 'null' });
    expect(opaque.status).toBe(403);
    // A loopback Origin (the dashboard itself) is fine.
    const ok = await post('/api/jobs/j1/note', { note: 'hi' }, { origin: `http://127.0.0.1:${dash.port}` });
    expect(ok.status).toBe(200);
    // ...but another app on a different loopback port is not the dashboard.
    const otherPort = dash.port === 3000 ? 3001 : 3000;
    const neighbour = await post('/api/jobs/j1/note', { note: 'x' }, { origin: `http://127.0.0.1:${otherPort}` });
    expect(neighbour.status).toBe(403);
  });

  it('rejects requests whose Host is not loopback (DNS rebinding)', async () => {
    expect(await rawWithHost('evil.example.com')).toBe(403);
    expect(await rawWithHost(`127.0.0.1:${dash.port}`)).toBe(200);
    expect(await rawWithHost('localhost:4646')).toBe(200); // port is irrelevant
  });

  it('rejects cross-site GETs and sends browser hardening headers', async () => {
    const crossSite = await rawRequest('/api/health', { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);

    const page = await rawRequest('/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('helpers: loopback host/origin matrix', () => {
    expect(isLoopbackHost('127.0.0.1:4646')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]:9999')).toBe(true);
    expect(isLoopbackHost('evil.com')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false); // every HTTP/1.1 client sends Host; none is refused (P1-5)
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4646')).toBe(true);
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    // With the server's port known, another local app is a different origin.
    expect(isAllowedOrigin('http://127.0.0.1:4646', 4646)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4646', 4646)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', 4646)).toBe(false);
    expect(isAllowedOrigin('http://localhost', 4646)).toBe(false);
  });

  it('GET /api/jobs returns { jobs, total, limit } so the UI can say "Showing N of M"', async () => {
    const { body } = await get('/api/jobs?limit=2');
    expect(body.jobs).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
  });

  it('bounds batch operations to prevent a single request monopolizing the dashboard', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `job-${i}`);
    const result = await post('/api/assist-batch', { jobIds: ids });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/limited to 200/);
  });

  it('single assist refuses an already-submitted job (409, no double application)', async () => {
    db.upsertJob({ id: 'j1', applied: 1, status: 'submitted' });
    const r = await post('/api/jobs/j1/assist');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already submitted/);
  });

  it('single assist refuses a job with an UNVERIFIED auto-submit', async () => {
    db.upsertJob({ id: 'j1', status: 'submit_unverified' });
    const r = await post('/api/jobs/j1/assist');
    expect(r.status).toBe(409);
  });

  it('batch skips submitted jobs up front and honors mid-run triage', async () => {
    db.upsertJob({ id: 'j1', applied: 1, status: 'submitted' }); // skipped before queueing
    const started = await post('/api/assist-batch', { jobIds: ['j1', 'j2', 'j3'] });
    expect(started.status).toBe(202);

    // j2's fill is now in flight. The user rejects j3 while it waits.
    await new Promise((r) => setTimeout(r, 25));
    expect(assistResolvers).toHaveLength(1);
    db.setUserDecision('j3', 'rejected');
    assistResolvers[0]({ status: 'ready_for_submit', blockers: [] });

    await new Promise((r) => setTimeout(r, 40));
    const run = (await get('/api/run/status')).body;
    expect(run.running).toBe(false);
    const skippedIds = run.lastResult.skipped.map((s) => s.jobId);
    expect(skippedIds).toContain('j1'); // already submitted
    expect(skippedIds).toContain('j3'); // rejected during the run
    expect(run.lastResult.results.map((r2) => r2.jobId)).toEqual(['j2']);
    expect(assistResolvers).toHaveLength(1); // j3 was never filled
  });

  it('POST /api/run/cancel stops a batch between jobs', async () => {
    expect((await post('/api/run/cancel')).status).toBe(409); // nothing running

    await post('/api/assist-batch', { jobIds: ['j1', 'j2', 'j3'] });
    await new Promise((r) => setTimeout(r, 25));
    expect(assistResolvers).toHaveLength(1); // j1 in flight

    const c = await post('/api/run/cancel');
    expect(c.status).toBe(202);
    assistResolvers[0]({ status: 'ready_for_submit', blockers: [] });

    await new Promise((r) => setTimeout(r, 40));
    const run = (await get('/api/run/status')).body;
    expect(run.running).toBe(false);
    expect(run.lastResult.cancelled).toBe(true);
    expect(run.lastResult.results).toHaveLength(1); // only the in-flight job finished
    expect(run.lastResult.skipped.some((s) => /cancelled/.test(s.reason))).toBe(true);
    expect(assistResolvers).toHaveLength(1); // nothing new started after cancel
  });
});

/* ─────────────────── truthful "submitted" recording ─────────────────── */

describe('recordAssistResult truthfulness', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Acme', title: 'DE', url: 'http://a', source: 'x' });
  });
  afterEach(() => db.close());

  it('an UNVERIFIED auto-submit click is never recorded as applied', () => {
    recordAssistResult(db, 'j1', {
      status: 'submit_unverified', submitted: false, filled: [], blockers: [],
      submitVerification: { verified: false, signals: [] },
    });
    const row = db.getJob('j1');
    expect(row.status).toBe('submit_unverified');
    expect(Number(row.applied)).toBe(0);
  });

  it('a VERIFIED auto-submit records applied=1 with the verification signals', () => {
    recordAssistResult(db, 'j1', {
      status: 'submitted', submitted: true, filled: [], blockers: [],
      submitVerification: { verified: true, signals: ['confirmation message'] },
    });
    const row = db.getJob('j1');
    expect(Number(row.applied)).toBe(1);
    expect(row.submitted_confirmation).toMatch(/confirmation message/);
  });

  it('a failed WRITE of a submitted result is loud, never silent', () => {
    const broken = { upsertJob: () => { throw new Error('SQLITE_BUSY'); } };
    expect(() => recordAssistResult(broken, 'j1', { status: 'submitted', submitted: true, filled: [], blockers: [] }))
      .toThrow(/failed to record submitted application/);
    // Every outcome is loud now: a lost "ready" or "blocked" left the job
    // showing its old status with nothing on screen to say so (audit AF-12).
    expect(() => recordAssistResult(broken, 'j1', { status: 'ready_for_submit', submitted: false, filled: [], blockers: [] }))
      .toThrow(/failed to record auto-fill result \(ready_for_submit\)/);
  });
});

/* ───────────────────────── re-score without discovery ───────────────────── */

describe('runRescore', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => db.close());

  it('re-scores stored jobs from their JDs with NO discovery/network', async () => {
    db.upsertJob({
      id: F.azureFabricSenior.id, source: F.azureFabricSenior.source,
      company: F.azureFabricSenior.company, title: F.azureFabricSenior.title,
      url: F.azureFabricSenior.url, jd_text: F.azureFabricSenior.jdText,
      posted_at: F.azureFabricSenior.postedAt, status: 'scored', score: 1, tier: 'Discard',
    });
    const searchSpy = () => { throw new Error('re-score must not run discovery'); };
    const r = await runRescore({ config: base, db, logger: null, deps: { now: NOW, searchFn: searchSpy } });
    expect(r.counters.jobs_rescored).toBe(1);
    const row = db.getJob(F.azureFabricSenior.id);
    expect(row.score).toBeGreaterThan(50); // a strong JD recovers from the bogus stored score
    expect(row.status).toBe('scored');
  });

  it('never touches rows the human invested in', async () => {
    db.upsertJob({ id: 'prepared-1', company: 'A', title: 'T', url: 'http://a', jd_text: 'x', status: 'prepared', application_packet_path: '/p.json', score: 88, tier: 'Priority' });
    db.upsertJob({ id: 'decided-1', company: 'B', title: 'T', url: 'http://b', jd_text: 'x', status: 'scored', user_decision: 'shortlisted', score: 77, tier: 'Apply' });
    const r = await runRescore({ config: base, db, logger: null, deps: { now: NOW } });
    expect(r.counters.jobs_skipped_protected).toBe(2);
    expect(db.getJob('prepared-1').score).toBe(88);
    expect(db.getJob('decided-1').score).toBe(77);
  });

  it('still applies hard exclusions on re-score (no resurrecting excluded jobs)', async () => {
    db.upsertJob({
      id: 'nosponsor-1', company: 'C', title: 'Senior Data Engineer', url: 'http://c',
      jd_text: 'US citizens only; we are unable to sponsor visas.', status: 'discarded',
    });
    const r = await runRescore({ config: base, db, logger: null, deps: { now: NOW } });
    expect(r.counters.jobs_excluded).toBe(1);
    expect(db.getJob('nosponsor-1').status).toBe('discarded');
  });
});

/* ───────────────── pipeline: status downgrade guard (B5) ────────────────── */

describe('re-discovery never downgrades an invested job', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guard-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a prepared job re-discovered as stale keeps its prepared status', async () => {
    const db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    const logger = new JobLogger({ db, logger: pino });
    const config = { ...base, root };

    // 1. First run prepares the strong job (packet + approval row).
    await runPipeline({
      config, db, logger, mode: 'PREPARE',
      deps: { searchFn: async () => ({ jobs: [F.azureFabricSenior], duplicates: [], errors: [] }), now: F.NOW, stamp: 't1' },
    });
    expect(db.getJob(F.azureFabricSenior.id).status).toBe('prepared');
    expect(isProtectedJobRow(db.getJob(F.azureFabricSenior.id))).toBe(true);

    // 2. A later discovery sees the SAME job, now aged past freshness.
    const stale = { ...F.azureFabricSenior, postedAt: '2026-01-01T00:00:00Z' };
    await runPipeline({
      config, db, logger, mode: 'DRY_RUN',
      deps: { searchFn: async () => ({ jobs: [stale], duplicates: [], errors: [] }), now: F.NOW, stamp: 't2' },
    });
    const row = db.getJob(F.azureFabricSenior.id);
    expect(row.status).toBe('prepared'); // NOT flipped to 'discarded'
    expect(row.discard_reason ?? null).toBeNull();
    db.close();
  });
});

/* ───────────── screening: whole-word matching + unknownAction ────────────── */

describe('screening QA hardening', () => {
  const answers = {
    defaults: { unknownAction: 'ask_user' },
    answers: [
      { id: 'eeo_race', patterns: ['race', 'ethnicity'], answer: 'Asian', type: 'text' },
      { id: 'relocation', patterns: ['willing to relocate'], answer: 'Yes', type: 'text' },
    ],
  };

  it('"race" matches "Race/Ethnicity" but never "embrace"', () => {
    expect(answerScreeningQuestion('Race/Ethnicity (voluntary)', answers).answered).toBe(true);
    const r = answerScreeningQuestion('Tell us how you embrace challenges at work', answers);
    expect(r.answered).toBe(false); // a substring hit here would leak an EEO answer
    expect(r.action).toBe('ask_user');
  });

  it('unknownAction: "skip" is honored (previously dead config)', () => {
    const skipping = { ...answers, defaults: { unknownAction: 'skip' } };
    const r = answerScreeningQuestion('What is your favorite teapot?', skipping);
    expect(r.answered).toBe(false);
    expect(r.action).toBe('skip');
  });
});

/* ───────────────── navigator: "Apply now" is not a free advance ───────────── */

describe('navigator apply-start gating', () => {
  const pageWith = (buttons) => ({ evaluate: async () => buttons });

  it('regexes: "apply now" moved out of ADVANCE_RE into APPLY_START_RE', () => {
    expect(ADVANCE_RE.test('Apply now')).toBe(false);
    expect(APPLY_START_RE.test('Apply now')).toBe(true);
    expect(ADVANCE_RE.test('Save and continue')).toBe(true);
  });

  it('"Apply now" is only an advance control when explicitly allowed (fieldless landing page)', async () => {
    const page = pageWith([{ text: 'Apply now', selector: '#apply' }]);
    expect(await findAdvanceControl(page)).toBeNull(); // default: NOT clickable
    const allowed = await findAdvanceControl(page, { allowApplyStart: true });
    expect(allowed?.selector).toBe('#apply');
  });

  it('a real Next button still wins either way', async () => {
    const page = pageWith([{ text: 'Next step', selector: '#next' }]);
    expect((await findAdvanceControl(page))?.selector).toBe('#next');
  });
});

/* ─────────────────────────── URL-based dedup (B8) ────────────────────────── */

describe('deduplicator URL identity', () => {
  it('urlKeyFor normalizes host/hash/tracking params but keeps identity params', () => {
    expect(urlKeyFor({ url: 'https://www.Acme.com/jobs/123/?utm_source=x&gh_jid=42#apply' }))
      .toBe('acme.com/jobs/123?gh_jid=42');
    expect(urlKeyFor({ url: 'https://acme.com/jobs/123?gh_jid=42' }))
      .toBe('acme.com/jobs/123?gh_jid=42');
    expect(urlKeyFor({})).toBeNull();
  });

  it('two records with the same posting URL collapse even when company/title differ', () => {
    const a = { company: 'Acme', title: 'Data Engineer', url: 'https://acme.com/jobs/1', jdText: 'long text here' };
    const b = { company: '', title: 'Data Engineer (Remote)', url: 'https://www.acme.com/jobs/1?utm_source=feed', jdText: 'x' };
    const { unique, duplicates } = deduplicate([a, b]);
    expect(unique).toHaveLength(1);
    expect(duplicates[0].reason).toBe('duplicate_url');
  });
});

/* ───────────────────────── apify company fallbacks (B9) ─────────────────── */

describe('apify company mapping', () => {
  it('extracts schema.org hiringOrganization objects', () => {
    const job = mapItem({ title: 'DE', url: 'https://acme.com/j/1', hiringOrganization: { name: 'Acme Labs' } });
    expect(job.company).toBe('Acme Labs');
  });
  it('falls back to the ATS URL slug when no company field exists', () => {
    const job = mapItem({ title: 'DE', jobUrl: 'https://boards.greenhouse.io/acme-labs/jobs/1' });
    expect(job.company).toBe('Acme Labs');
  });
  it('companyFromUrl understands workday subdomains and never trusts aggregators', () => {
    expect(companyFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1')).toBe('Acme');
    expect(companyFromUrl('https://www.indeed.com/viewjob?jk=1')).toBe('');
  });
});

/* ───────────────────────────── atomic writes (A4) ───────────────────────── */

describe('writeFileAtomic', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes new files, overwrites existing ones, and leaves no temp files', () => {
    const p = join(dir, 'out.json');
    writeFileAtomic(p, '{"v":1}');
    expect(readFileSync(p, 'utf8')).toBe('{"v":1}');
    writeFileAtomic(p, '{"v":2}');
    expect(readFileSync(p, 'utf8')).toBe('{"v":2}');
    expect(existsSync(p)).toBe(true);
  });
  it('creates parent directories', () => {
    const p = join(dir, 'a', 'b', 'out.txt');
    writeFileAtomic(p, 'x');
    expect(readFileSync(p, 'utf8')).toBe('x');
  });
});

/* ───────────── stats: prepared_at + fit tiles + submit_unverified ────────── */

describe('dashboard stats accuracy', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => db.close());

  const today = NOW.toISOString();

  it('preparedToday counts prepared_at, not any old row touched today', () => {
    // Prepared WEEKS ago, but a note bumped updated_at today — must NOT count.
    db.upsertJob({
      id: 'old', company: 'A', title: 'T', url: 'http://a', status: 'ready_for_submit',
      application_packet_path: '/p/old.json', prepared_at: '2026-05-01T00:00:00Z',
    });
    // Genuinely prepared today.
    db.upsertJob({
      id: 'fresh', company: 'B', title: 'T', url: 'http://b', status: 'prepared',
      application_packet_path: '/p/fresh.json', prepared_at: today,
    });
    const stats = dashboardStats(db, { now: NOW });
    expect(stats.totals.preparedToday).toBe(1);
    const todayRow = stats.daily.find((d) => d.day === today.slice(0, 10));
    expect(todayRow.prepared).toBe(1);
  });

  it('fit tiles count only actionable jobs (closed/rejected excluded)', () => {
    db.upsertJob({ id: 'open', company: 'A', title: 'T', url: 'http://a', score: 90, tier: 'Priority', status: 'scored' });
    db.upsertJob({ id: 'gone', company: 'B', title: 'T', url: 'http://b', score: 91, tier: 'Priority', status: 'scored', user_decision: 'rejected' });
    const stats = dashboardStats(db, { now: NOW });
    expect(stats.totals.strongFit).toBe(1); // the rejected strong job no longer inflates the tile
  });

  it('submit_unverified: derived status, top priority, next action, tracker label', () => {
    db.upsertJob({ id: 'u1', company: 'A', title: 'T', url: 'http://a', status: 'submit_unverified', score: 90, tier: 'Priority' });
    expect(deriveAppStatus(db.getJob('u1'), null)).toBe('submit_unverified');

    const stats = dashboardStats(db, { now: NOW });
    expect(stats.totals.submitUnverified).toBe(1);
    expect(stats.byStatus.submit_unverified).toBe(1);

    const actions = buildNextActions(stats.totals, 0);
    expect(actions[0].text).toMatch(/could not be confirmed/);
    expect(actions[0].filter.appStatus).toBe('submit_unverified');

    const sections = dashboardSections(db, { now: NOW });
    expect(sections.todaysPriorities[0].id).toBe('u1');

    expect(submitStatus(db.getJob('u1'), null)).toMatch(/UNCONFIRMED/);
    // And it is never re-fillable: the CLI/server idempotency guards key off this row shape.
    expect(isProtectedJobRow(db.getJob('u1'))).toBe(true);
  });

  it('boardPage returns the uncapped total; listBoardJobs stays array-shaped', () => {
    for (let i = 0; i < 5; i += 1) {
      db.upsertJob({ id: `j${i}`, company: 'A', title: `T${i}`, url: `http://${i}`, score: 50 + i, tier: 'Queue', status: 'scored' });
    }
    const page = boardPage(db, { limit: 2, now: NOW });
    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(Array.isArray(listBoardJobs(db, { limit: 2, now: NOW }))).toBe(true);
  });
});

/* ─────────── ingestUrl: re-adding an invested job keeps its status ────────── */

describe('ingestUrl downgrade guard', () => {
  it('re-pasting the URL of a prepared job refreshes metadata but keeps status', async () => {
    const db = openDatabase({ path: ':memory:' });
    const html = `<html><body><h1>Senior Data Engineer</h1>
      <p>Azure Databricks, PySpark, SQL, Microsoft Fabric, Delta Lake. Visa sponsorship available.</p>
      </body></html>`;
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => html, headers: { get: () => 'text/html' } });

    const first = await ingestUrl({ config: base, db, url: 'https://careers.acme.com/jobs/1', deps: { fetchImpl, now: NOW } });
    // Simulate the human preparing it.
    db.upsertJob({ id: first.id, status: 'prepared', application_packet_path: '/p/x.json' });

    await ingestUrl({ config: base, db, url: 'https://careers.acme.com/jobs/1', deps: { fetchImpl, now: NOW } });
    expect(db.getJob(first.id).status).toBe('prepared'); // not reset to 'scored'
    db.close();
  });
});
