/**
 * Dashboard HTTP server tests — boot on an ephemeral 127.0.0.1 port, exercise
 * the JSON API end to end against an in-memory db. No network beyond loopback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard, installProcessSafetyNet } from '../../src/dashboard/server.js';

const NOW = new Date('2026-06-04T12:00:00Z');

function seed(db) {
  db.upsertJob({
    id: 'j1', company: 'Acme', title: 'Senior Data Engineer', url: 'http://a',
    source: 'greenhouse', score: 90, tier: 'Priority', sponsorship: 'Confirmed',
    status: 'prepared', posted_at: '2026-06-04T01:00:00Z',
    application_packet_path: '/p/j1.json', created_at: '2026-06-04T02:00:00Z',
  });
  db.insertApproval({ id: 'ap1', job_id: 'j1', packet_path: '/p/j1.json', approval_status: 'pending_review' });
  db.upsertJob({ id: 'j2', company: 'Globex', title: 'BI Engineer', url: 'http://b', source: 'ashby', score: 60, tier: 'Queue' });
}

function eligiblePacket(url = 'http://a') {
  return {
    id: 'pk-j1',
    job: { id: 'j1', url },
    ats: { platform: 'greenhouse' },
    blockers: [],
    resumePath: '/docs/tailored-resume.docx',
    prefill: { plan: [], needsUser: [] },
    screeningPlan: { answered: [], needsUser: [] },
    uploads: { blockers: [] },
    stopBeforeSubmit: true,
  };
}

describe('dashboard server API', () => {
  let db;
  let dash;
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    seed(db);
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        extensionKey: 'k'.repeat(32),
        now: () => NOW,
        readFileImpl: () => JSON.stringify({
          id: 'pk', ats: { platform: 'greenhouse' }, blockers: [],
          prefill: { plan: [], needsUser: [] }, stopBeforeSubmit: true, submitReady: false,
        }),
        // Runner stubs: no real search/scoring in server tests.
        discoverFn: async () => ({ counters: { jobs_found: 5 } }),
        scoreFn: async () => ({ counters: { jobs_scored: 3 } }),
        prepareFn: async () => ({ counters: { jobs_prepared: 1 } }),
        assistFn: async ({ options }) => (options?.autoSubmit
          // Mirrors the real runner contract: submitted:true is ONLY ever
          // reported together with a positive post-submit verification.
          ? { status: 'submitted', submitted: true, blockers: [],
              submitVerification: { verified: true, signals: ['confirmation message'] } }
          : { status: 'ready_for_submit', blockers: [] }),
        loadPacketImpl: () => eligiblePacket(),
      },
    });
  });
  afterEach(async () => {
    await dash.close();
    db.close();
  });

  it('serves the UI shell at /', async () => {
    const res = await fetch(dash.url + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('JobAgent Dashboard');
  });

  it('carries the full attribution and serves its self-hosted signature font', async () => {
    const html = await (await fetch(dash.url + '/')).text();
    expect(html).toContain('Designed and Engineered by');
    expect(html).toContain('<span class="sig-name">Atresh Somayajula</span>');

    const css = await (await fetch(dash.url + '/assets/css/app.css')).text();
    expect(css).toMatch(/\.sig-name\s*\{[^}]*font-family:\s*"Playfair Display"/);

    const font = await fetch(dash.url + '/assets/fonts/PlayfairDisplay-BoldItalic.woff2');
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString('latin1')).toBe('wOF2');
  });

  it('lets the browser revalidate unchanged assets with a 304', async () => {
    const first = await fetch(dash.url + '/assets/css/app.css');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const again = await fetch(dash.url + '/assets/css/app.css', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    // A wrong validator still gets the full file.
    expect((await fetch(dash.url + '/assets/css/app.css', { headers: { 'if-none-match': '"stale"' } })).status).toBe(200);
  });

  it('binds to 127.0.0.1 only', () => {
    expect(dash.server.address().address).toBe('127.0.0.1');
  });

  it('gates extension payloads by Chromium origin, shared key, and packet approval', async () => {
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    const call = (headers) => fetch(dash.url + '/api/extension/jobs/j1/payload', { headers });
    expect((await call({ origin: 'https://evil.test', 'x-job-agent-key': 'k'.repeat(32) })).status).toBe(403);
    expect((await call({ origin, 'x-job-agent-key': 'x'.repeat(32) })).status).toBe(401);
    expect((await call({ origin, 'x-job-agent-key': 'k'.repeat(32) })).status).toBe(403);
    await post('/api/jobs/j1/approve');
    const approved = await call({ origin, 'x-job-agent-key': 'k'.repeat(32) });
    expect(approved.status).toBe(200);
    expect(approved.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await approved.json()).approval.stopBeforeSubmit).toBe(true);
  });

  it('supports Edge originless privileged fetches only with the shared key', async () => {
    await post('/api/jobs/j1/approve');
    const url = dash.url + '/api/extension/jobs/j1/payload';
    expect((await fetch(url, { headers: { 'x-job-agent-key': 'x'.repeat(32) } })).status).toBe(401);
    expect((await fetch(url, { headers: { 'x-job-agent-key': 'k'.repeat(32) } })).status).toBe(200);
    expect((await fetch(url, { headers: {
      origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', 'x-job-agent-key': 'k'.repeat(32),
    } })).status).toBe(403);
  });

  it('records extension progress truthfully and never marks a zero-field page ready', async () => {
    await post('/api/jobs/j1/approve');
    const endpoint = dash.url + '/api/extension/jobs/j1/result';
    const headers = {
      origin: `chrome-extension://${'a'.repeat(32)}`,
      'content-type': 'application/json', 'x-job-agent-key': 'k'.repeat(32),
    };
    const noForm = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ stage: 'application_started', startedApplication: true, formDetected: false, filled: [], blockers: [] }),
    });
    expect((await noForm.json()).status).toBe('assist_started');
    expect(db.getJob('j1').status).toBe('assist_started');

    const filled = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ formDetected: true, readyForReview: true, filled: [{ field: 'email', label: 'Email', source: 'candidate_profile' }], blockers: [] }),
    });
    expect((await filled.json()).status).toBe('ready_for_submit');
    expect(db.getJob('j1').status).toBe('ready_for_submit');
  });

  it('a late extension result never lifts the submit_unverified lock or invents a job', async () => {
    await post('/api/jobs/j1/approve');
    db.upsertJob({ id: 'j1', status: 'submit_unverified' });
    const headers = {
      origin: `chrome-extension://${'a'.repeat(32)}`,
      'content-type': 'application/json', 'x-job-agent-key': 'k'.repeat(32),
    };
    const body = JSON.stringify({ formDetected: true, readyForReview: true, filled: [{ field: 'email' }], blockers: [] });

    const late = await fetch(dash.url + '/api/extension/jobs/j1/result', { method: 'POST', headers, body });
    expect(late.status).toBe(409);
    expect(db.getJob('j1').status).toBe('submit_unverified');

    const phantom = await fetch(dash.url + '/api/extension/jobs/nope/result', { method: 'POST', headers, body });
    expect(phantom.status).toBe(404);
    expect(db.getJob('nope')).toBeFalsy();
  });

  it.each([
    ['submission', 409],
    ['revoked approval', 409],
  ])('rechecks %s after receiving an extension result body', async (change, expectedStatus) => {
    await post('/api/jobs/j1/approve');
    // The request starts while approved; another action changes its state
    // while the asynchronous body reader is still receiving the report.
    dash.server.once('request', (req) => {
      req.once('data', () => {
        if (change === 'submission') db.upsertJob({ id: 'j1', status: 'submit_unverified' });
        else db.updateApprovalStatus('ap1', { approval_status: 'rejected', approved_by_user: 0 });
      });
    });
    const response = await fetch(dash.url + '/api/extension/jobs/j1/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-job-agent-key': 'k'.repeat(32) },
      body: JSON.stringify({ formDetected: true, readyForReview: true, filled: [{ field: 'email' }], blockers: [] }),
    });
    expect(response.status).toBe(expectedStatus);
    expect(db.getJob('j1').status).toBe(change === 'submission' ? 'submit_unverified' : 'prepared');
  });

  it('GET /api/stats returns tiles and breakdowns', async () => {
    const { status, body } = await get('/api/stats');
    expect(status).toBe(200);
    expect(body.totals.jobsTracked).toBe(2);
    expect(body.totals.pendingReview).toBe(1);
    expect(body.bySource.greenhouse.found).toBe(1);
  });

  it('GET /api/jobs filters and GET /api/jobs/:id returns detail with packet', async () => {
    const { body } = await get('/api/jobs?fit=strong');
    expect(body.jobs.map((j) => j.id)).toEqual(['j1']);
    const detail = await get('/api/jobs/j1');
    expect(detail.status).toBe(200);
    expect(detail.body.packet.ats.platform).toBe('greenhouse');
    expect(detail.body.packet.submitReady).toBe(false);
    expect((await get('/api/jobs/ghost')).status).toBe(404);
  });

  it('serves generated resume previews only from inside the configured workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-resume-preview-'));
    const outside = mkdtempSync(join(tmpdir(), 'jobagent-resume-outside-'));
    try {
      const docs = join(root, 'applications', 'output', 'Acme');
      mkdirSync(docs, { recursive: true });
      const pdf = join(docs, 'resume.pdf');
      const docx = join(docs, 'resume.docx');
      const escaped = join(outside, 'private.pdf');
      writeFileSync(pdf, '%PDF-1.4\n% local preview');
      writeFileSync(docx, 'docx-bytes');
      const newer = new Date(Date.now() + 10_000);
      utimesSync(pdf, newer, newer);
      writeFileSync(escaped, '%PDF-1.4\n% outside');
      db.upsertJob({ id: 'j1', resume_pdf_path: pdf, resume_docx_path: docx, resume_path: docx });

      await dash.close();
      dash = await startDashboard({ config: { root }, db, logger: null, port: 0, deps: { now: () => NOW } });

      const preview = await fetch(dash.url + '/api/jobs/j1/resume?format=pdf');
      expect(preview.status).toBe(200);
      expect(preview.headers.get('content-type')).toBe('application/pdf');
      expect(preview.headers.get('content-disposition')).toContain('inline');
      expect(preview.headers.get('x-frame-options')).toBe('SAMEORIGIN');

      const download = await fetch(dash.url + '/api/jobs/j1/resume?format=docx');
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('attachment');

      db.upsertJob({ id: 'j1', resume_pdf_path: escaped });
      expect((await fetch(dash.url + '/api/jobs/j1/resume?format=pdf')).status).toBe(403);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('creates a missing PDF preview on demand and persists the recovered path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-resume-generate-'));
    try {
      const docs = join(root, 'applications', 'output', 'Acme');
      mkdirSync(docs, { recursive: true });
      const docx = join(docs, 'tailored.docx');
      const pdf = join(docs, 'tailored.pdf');
      writeFileSync(docx, 'docx-bytes');
      writeFileSync(pdf, '%PDF-1.4\n% stale preview');
      utimesSync(pdf, new Date(0), new Date(0));
      // A minute in the past, not "now": the regenerated PDF below is stamped by
      // the filesystem, whose clock ticks coarser than Date (~15.6 ms on NTFS),
      // so a DOCX stamped with Date.now() could look NEWER than a PDF written
      // after it — and the preview would be rejected as stale.
      const docxTime = new Date(Date.now() - 60_000);
      utimesSync(docx, docxTime, docxTime);
      db.upsertJob({ id: 'j1', resume_docx_path: docx, resume_path: docx, resume_pdf_path: null });
      await dash.close();
      dash = await startDashboard({
        config: { root }, db, logger: null, port: 0,
        deps: {
          now: () => NOW,
          ensureResumePdfFn: async (path) => {
            // Compare REALPATHS. The server hands the converter the resolved
            // path, and on macOS mkdtemp returns /var/... while realpath returns
            // /private/var/... — so a literal comparison threw inside the mock,
            // surfaced as a bare 500, and read as "the graceful 422 branch is
            // broken" when the route was fine all along.
            expect(realpathSync(path)).toBe(realpathSync(docx));
            writeFileSync(pdf, '%PDF-1.4\n% generated preview');
            return { exported: true, pdfPath: pdf, reason: 'ok' };
          },
        },
      });
      const generated = await post('/api/jobs/j1/resume-preview');
      expect(generated.status).toBe(200);
      expect(generated.body).toMatchObject({ ready: true, generated: true });
      // Realpath again: the server persists the resolved path (see above).
      expect(realpathSync(db.getJob('j1').resume_pdf_path)).toBe(realpathSync(pdf));
      expect((await fetch(dash.url + generated.body.url)).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks link health and lets the user replace an aggregator URL with a direct application URL', async () => {
    await dash.close();
    db.upsertJob({ id: 'j1', url: 'https://www.linkedin.com/jobs/view/123' });
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        checkLinkFn: async () => ({ kind: 'aggregator', status: 'restricted', httpStatus: 403,
          finalUrl: 'https://www.linkedin.com/jobs/view/123', message: 'Aggregator restricts automated access.' }),
      },
    });
    const health = await post('/api/jobs/j1/check-link');
    expect(health.body).toMatchObject({ kind: 'aggregator', status: 'restricted', httpStatus: 403 });
    expect((await post('/api/jobs/j1/link', { url: 'https://www.indeed.com/viewjob?jk=x' })).status).toBe(400);
    const updated = await post('/api/jobs/j1/link', { url: 'https://company.wd5.myworkdayjobs.com/job/123' });
    expect(updated.status).toBe(200);
    expect(db.getJob('j1').url).toBe('https://company.wd5.myworkdayjobs.com/job/123');
  });

  it('decision endpoint validates and persists', async () => {
    expect((await post('/api/jobs/j2/decision', { decision: 'shortlisted' })).body.appStatus).toBe('shortlisted');
    expect((await post('/api/jobs/j2/decision', { decision: 'nope' })).status).toBe(400);
    expect((await post('/api/jobs/ghost/decision', { decision: 'shortlisted' })).status).toBe(404);
    expect((await post('/api/jobs/j2/decision', 'not json{{')).status).toBe(400);
  });

  it('approve -> assist stops before submit; submission needs positive evidence', async () => {
    expect((await post('/api/jobs/j2/approve')).status).toBe(409); // no packet
    expect((await post('/api/jobs/j1/assist')).status).toBe(400);  // not approved yet
    expect((await post('/api/jobs/j1/approve')).body.status).toBe('approved');

    const assist = await post('/api/jobs/j1/assist');
    expect(assist.status).toBe(202);
    expect(assist.body.note).toContain('stop before submit');
    await new Promise((r) => setTimeout(r, 20)); // let the async assist settle
    const run = (await get('/api/run/status')).body;
    expect(run.running).toBe(false);
    expect(run.lastResult).toMatchObject({ phase: 'assist', jobId: 'j1', status: 'ready_for_submit' });
    expect(db.getJob('j1').status).toBe('ready_for_submit');
    expect(Number(db.getJob('j1').applied)).toBe(0); // assist NEVER submits

    const pending = await post('/api/jobs/j1/mark-submitted');
    expect(pending.body.appStatus).toBe('submit_unverified');
    expect(Number(db.getJob('j1').applied)).toBe(0);

    const done = await post('/api/jobs/j1/mark-submitted', {
      verified: true, confirmationNumber: 'confirmation page shown',
    });
    expect(done.body.appStatus).toBe('submitted');
    expect(Number(db.getJob('j1').applied)).toBe(1);
  });

  it('POST /api/run validates phase, runs async, and rejects concurrent runs', async () => {
    expect((await post('/api/run', { phase: 'submit' })).status).toBe(400);
    const started = await post('/api/run', { phase: 'discover' });
    expect(started.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const s = (await get('/api/run/status')).body;
    expect(s.running).toBe(false);
    expect(s.lastResult).toMatchObject({ phase: 'discover', counters: { jobs_found: 5 } });
  });

  it('reports live per-source discovery progress and preserves source timings', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await dash.close();
    dash = await startDashboard({
      config: {
        jobboards: { sources: [
          { id: 'greenhouse-boards', adapter: 'greenhouse', enabled: true, priority: 1 },
          { id: 'workday-public', adapter: 'workday', enabled: true, priority: 2 },
        ] },
      },
      db, logger: null, port: 0,
      deps: {
        discoverFn: async ({ searchHooks }) => {
          searchHooks.onSource({ phase: 'start', source: 'greenhouse-boards', adapter: 'greenhouse' });
          await gate;
          searchHooks.onSource({ phase: 'end', source: 'greenhouse-boards', adapter: 'greenhouse', found: 3, errors: 0, durationMs: 12 });
          searchHooks.onSource({ phase: 'cancelled', source: 'workday-public', adapter: 'workday', found: 0, errors: 0, durationMs: 0 });
          return { counters: { jobs_found: 3 }, perSource: [
            { source: 'greenhouse-boards', adapter: 'greenhouse', found: 3, errors: 0, durationMs: 12 },
            { source: 'workday-public', adapter: 'workday', found: 0, errors: 0, durationMs: 0, cancelled: true },
          ], cancelled: true };
        },
      },
    });
    await post('/api/run', { phase: 'discover' });
    const live = (await get('/api/run/status')).body;
    expect(live.progress).toMatchObject({ kind: 'sources', total: 2, completed: 0, currentSource: 'greenhouse-boards' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const done = (await get('/api/run/status')).body;
    expect(done.progress).toMatchObject({ total: 2, completed: 2, currentSource: null });
    expect(done.lastResult.cancelled).toBe(true);
    expect(done.lastResult.perSource[0]).toMatchObject({ source: 'greenhouse-boards', durationMs: 12 });
  });

  it('409s when a run is already in progress', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await dash.close();
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: { now: () => NOW, scoreFn: () => gate.then(() => ({ counters: {} })) },
    });
    expect((await post('/api/run', { phase: 'score' })).status).toBe(202);
    expect((await post('/api/run', { phase: 'score' })).status).toBe(409);
    expect((await post('/api/jobs/j1/assist')).status).toBe(409); // assist also gated
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect((await get('/api/run/status')).body.running).toBe(false);
  });

  it('unknown routes 404 with JSON', async () => {
    const r = await get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('no route');
  });

  it('answers malformed client input with 4xx, never 500', async () => {
    expect((await get('/api/jobs/%E0%A4%A')).status).toBe(400);
    expect((await fetch(dash.url + '/assets/a%00.js')).status).toBe(400);
    const nullBody = await fetch(dash.url + '/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
    });
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toMatch(/must be an object/);
  });

  it('a crashing pipeline run is captured, not fatal', async () => {
    await dash.close();
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: { now: () => NOW, prepareFn: async () => { throw new Error('boom'); } },
    });
    await post('/api/run', { phase: 'prepare' });
    await new Promise((r) => setTimeout(r, 20));
    const s = (await get('/api/run/status')).body;
    expect(s.running).toBe(false);
    expect(s.lastError).toContain('prepare failed: boom');
    // Server still serves requests after the failure.
    expect((await get('/api/stats')).status).toBe(200);
  });
});

describe('dashboard batch actions + CSV export', () => {
  let db;
  let dash;
  let trackerWrites;
  const get = (p) => fetch(dash.url + p);
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    seed(db);
    trackerWrites = 0;
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        liveVerifiedAts: ['greenhouse'], // a supervised live run is on record (P1-11)
        assistFn: async ({ options }) => (options?.autoSubmit
          // Mirrors the real runner contract: submitted:true is ONLY ever
          // reported together with a positive post-submit verification.
          ? { status: 'submitted', submitted: true, blockers: [],
              submitVerification: { verified: true, signals: ['confirmation message'] } }
          : { status: 'ready_for_submit', blockers: [] }),
        loadPacketImpl: () => eligiblePacket(),
        // Avoid touching the real filesystem in tests.
        writeJobTrackerImpl: () => { trackerWrites += 1; return { path: '/fake/root/data/job_tracker.csv' }; },
        readTextImpl: () => 'Company,Job Role\nAcme,Senior Data Engineer',
        // The tracker rewrite is coalesced off the request path (it is an
        // O(all jobs) export). Keep the window small so tests stay fast, but
        // wider than a cold first request (~20 ms on a JIT-cold server), or a
        // "burst" straddles two windows and the coalescing test flakes.
        trackerDebounceMs: 60,
      },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  /** Wait past the tracker debounce window so the coalesced write has run. */
  const settleTracker = () => new Promise((r) => setTimeout(r, 150));

  it('refreshes the tracker CSV after a human-gated action', async () => {
    await post('/api/jobs/j1/approve');
    await settleTracker();
    expect(trackerWrites).toBeGreaterThan(0);
  });

  it('coalesces a burst of actions into a single tracker rewrite', async () => {
    // Rewriting the whole spreadsheet once per click is what made bulk actions
    // slow. The guarantee is "the CSV catches up", not "one write per action".
    await Promise.all([
      post('/api/jobs/j1/decision', { decision: 'shortlisted' }),
      post('/api/jobs/j2/decision', { decision: 'shortlisted' }),
      post('/api/jobs/j1/decision', { decision: 'clear' }),
    ]);
    await settleTracker();
    expect(trackerWrites).toBe(1);
  });

  it('GET /api/export/tracker.csv streams the spreadsheet as an attachment', async () => {
    const res = await get('/api/export/tracker.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('job_tracker.csv');
    expect(await res.text()).toContain('Company,Job Role');
  });

  it('approve-batch approves prepared packets and reports the rest', async () => {
    const r = await post('/api/approve-batch', { jobIds: ['j1', 'j2'] });
    expect(r.status).toBe(200);
    expect(r.body.approved).toEqual(['j1']);     // j1 has a packet
    expect(r.body.failed.map((f) => f.jobId)).toEqual(['j2']); // j2 has none
    expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
  });

  it('previews Auto-Apply eligibility without mutating jobs or approvals', async () => {
    const before = db.getApprovalByJob('j1').approval_status;
    const r = await post('/api/auto-apply/eligibility', {
      jobIds: ['j1', 'j2'], autoSubmit: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, eligible: 1, ineligible: 1, autoSubmitAuthorized: true });
    expect(r.body.items.find((x) => x.jobId === 'j1')).toMatchObject({ eligible: true, ats: 'greenhouse' });
    expect(r.body.items.find((x) => x.jobId === 'j2').reasons.join(' ')).toMatch(/Prepare|Sponsorship|ATS/);
    expect(db.getApprovalByJob('j1').approval_status).toBe(before);
    expect(Number(db.getJob('j1').applied)).toBe(0);
  });

  it('auto-apply orchestrates prepare -> approve -> fill and never submits', async () => {
    // j1 has a packet awaiting review (NOT pre-approved); j2 has no packet and
    // no preparable config in this test env. One click must handle both
    // honestly: fill j1 end-to-end, report j2 as skipped with a reason.
    const r = await post('/api/assist-batch', { jobIds: ['j1', 'j2'] });
    expect(r.status).toBe(202);
    expect(r.body.queued).toBe(2);
    await new Promise((res) => setTimeout(res, 60));
    const run = (await fetch(dash.url + '/api/run/status').then((x) => x.json()));
    expect(run.running).toBe(false);
    expect(run.lastResult.phase).toBe('assist-batch');
    // The click IS the approval — j1 was auto-approved and filled.
    expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
    expect(run.lastResult.results.map((x) => x.jobId)).toEqual(['j1']);
    expect(run.lastResult.skipped.map((s) => s.jobId)).toContain('j2');
    expect(Number(db.getJob('j1').applied)).toBe(0); // auto-apply NEVER submits
  });

  it('auto-apply rejects an empty selection; unpreparable jobs are skipped, not 400s', async () => {
    expect((await post('/api/assist-batch', { jobIds: [] })).status).toBe(400);
    const r = await post('/api/assist-batch', { jobIds: ['j2'] });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.lastResult.skipped.map((s) => s.jobId)).toEqual(['j2']);
    expect(run.lastResult.results).toEqual([]);
  });

  it('POST /api/jobs/:id/auto-apply runs the full chain for one job', async () => {
    const r = await post('/api/jobs/j1/auto-apply');
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.lastResult.results[0]).toMatchObject({ jobId: 'j1', status: 'ready_for_submit' });
    expect(Number(db.getJob('j1').applied)).toBe(0);
  });

  it('Auto-apply ignores legacy autoSubmit flags; only the explicit advanced route submits', async () => {
    // Regression: the primary UI used to send autoSubmit:true after an
    // ambiguous confirm dialog, causing Unconfirmed sponsorship to block a
    // perfectly valid assisted fill. The named Auto-apply route is now safe.
    const safe = await post('/api/jobs/j1/auto-apply', { autoSubmit: true });
    expect(safe.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    expect(Number(db.getJob('j1').applied)).toBe(0);
    expect(db.getJob('j1').status).toBe('ready_for_submit');

    expect((await post('/api/auto-submit-batch', { jobIds: ['j1'] })).status).toBe(400);
    const explicit = await post('/api/auto-submit-batch', { jobIds: ['j1'], confirmed: true });
    expect(explicit.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    const job = db.getJob('j1');
    expect(Number(job.applied)).toBe(1);
    expect(job.status).toBe('submitted');
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.lastResult.results[0]).toMatchObject({ jobId: 'j1', submitted: true });
  });

  it('reconciles a stale packet URL to the live DB job URL before assisting', async () => {
    // The packet was prepared with an old aggregator link; the DB now holds the
    // refreshed direct company URL the user sees on the board.
    await dash.close();
    db.upsertJob({ id: 'j1', url: 'https://jobs.company.com/apply/42' });
    let navigatedUrl = null;
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        loadPacketImpl: () => eligiblePacket('https://www.indeed.com/viewjob?jk=stale'),
        assistFn: async ({ packet }) => { navigatedUrl = packet.job.url; return { status: 'ready_for_submit', blockers: [] }; },
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
      },
    });
    await post('/api/jobs/j1/approve');
    await post('/api/assist-batch', { jobIds: ['j1'] });
    await new Promise((res) => setTimeout(res, 30));
    expect(navigatedUrl).toBe('https://jobs.company.com/apply/42'); // live URL, not the stale packet one
  });

  it('a failing assistFn never crashes the batch and always clears the busy lock', async () => {
    // Regression: a thrown background error must be captured (status "failed"),
    // the run must finish (running=false), and the server must stay reachable —
    // otherwise the UI would only ever see "Failed to fetch".
    await dash.close();
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        loadPacketImpl: () => eligiblePacket(),
        assistFn: async () => { throw new Error('browser blew up'); },
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
      },
    });
    await post('/api/jobs/j1/approve');
    const r = await post('/api/assist-batch', { jobIds: ['j1'] });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 30));
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.running).toBe(false);                 // busy lock released
    expect(run.lastResult.results[0].status).toBe('failed');
    expect(run.lastResult.results[0].error).toContain('browser blew up');
    // Server still alive: a follow-up request succeeds.
    expect((await fetch(dash.url + '/api/stats')).status).toBe(200);
  });
});

describe('installProcessSafetyNet', () => {
  // A minimal fake "process" so we never register handlers on the real one.
  function fakeProc() {
    const handlers = {};
    return {
      on(event, fn) { (handlers[event] ??= []).push(fn); },
      off(event, fn) { handlers[event] = (handlers[event] ?? []).filter((h) => h !== fn); },
      emit(event, arg) { for (const h of handlers[event] ?? []) h(arg); },
      count(event) { return (handlers[event] ?? []).length; },
    };
  }

  it('records background errors on runState instead of crashing the process', () => {
    const runState = { lastError: null };
    const proc = fakeProc();
    const exits = [];
    const logs = [];
    installProcessSafetyNet({ runState, proc, logger: { error: (m) => logs.push(m) }, exit: (code) => exits.push(code) });
    proc.emit('unhandledRejection', new Error('window closed by user'));
    expect(runState.lastError).toContain('window closed by user');
    expect(runState.lastError).toContain('server still up');
    expect(exits).toEqual([]);
    // An uncaught EXCEPTION leaves the process in an undefined state: it is
    // logged, then the process exits non-zero instead of limping on.
    proc.emit('uncaughtException', new Error('transport EPIPE'));
    expect(logs.at(-1)).toContain('transport EPIPE');
    expect(exits).toEqual([1]);
  });

  it('uninstall removes the handlers so tests never leak globals', () => {
    const proc = fakeProc();
    const uninstall = installProcessSafetyNet({ runState: {}, proc });
    expect(proc.count('unhandledRejection')).toBe(1);
    expect(proc.count('uncaughtException')).toBe(1);
    uninstall();
    expect(proc.count('unhandledRejection')).toBe(0);
    expect(proc.count('uncaughtException')).toBe(0);
  });

  it('tolerates a missing runState (logger-only mode)', () => {
    const proc = fakeProc();
    const logs = [];
    installProcessSafetyNet({ logger: { error: (m) => logs.push(m) }, proc });
    expect(() => proc.emit('unhandledRejection', new Error('boom'))).not.toThrow();
    expect(logs[0]).toContain('boom');
  });
});

describe('command-center endpoints (sections, notes, export, decide-batch)', () => {
  let db;
  let dash;
  const get = (p) => fetch(dash.url + p);
  const getJson = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    seed(db);
    db.upsertJob({ id: 'blk', company: 'Wall Co', title: 'DE', url: 'http://w', score: 80, tier: 'Apply',
      status: 'assist_blocked', assist_blockers: ['login required'] });
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: { now: () => NOW, writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }) },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('GET /api/sections returns curated sections + counts', async () => {
    const { status, body } = await getJson('/api/sections');
    expect(status).toBe(200);
    expect(body.counts).toBeDefined();
    expect(body.counts.needsReview).toBe(1);          // j1 has a pending packet
    expect(body.counts.blocked).toBe(1);              // blk
    expect(body.blockedByReason[0].reason).toBe('Login / account required');
  });

  it('GET /api/export/jobs.csv streams a rich CSV attachment', async () => {
    const res = await get('/api/export/jobs.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('jobagent_jobs.csv');
    const text = await res.text();
    expect(text).toContain('Company,Role');
    expect(text).toContain('Grade');
  });

  it('POST /api/jobs/:id/note saves a note and rejects unknown ids', async () => {
    const ok = await post('/api/jobs/j1/note', { note: 'call recruiter' });
    expect(ok.status).toBe(200);
    expect(ok.body.notes).toBe('call recruiter');
    expect(db.getJob('j1').notes).toBe('call recruiter');
    expect((await post('/api/jobs/ghost/note', { note: 'x' })).status).toBe(404);
  });

  it('POST /api/decide-batch applies a triage decision to many jobs', async () => {
    const r = await post('/api/decide-batch', { jobIds: ['j1', 'j2'], decision: 'shortlisted' });
    expect(r.status).toBe(200);
    expect(r.body.updated.sort()).toEqual(['j1', 'j2']);
    expect(db.getJob('j1').user_decision).toBe('shortlisted');
    expect(db.getJob('j2').user_decision).toBe('shortlisted');
  });

  it('POST /api/decide-batch reports invalid decisions per job without 500ing', async () => {
    const r = await post('/api/decide-batch', { jobIds: ['j1'], decision: 'banana' });
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual([]);
    expect(r.body.failed[0].error).toMatch(/invalid decision/);
  });

  it('POST /api/add-url ingests a pasted job (via injected ingest impl) and refreshes the tracker', async () => {
    await dash.close();
    let received = null;
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
        ingestUrlFn: async ({ url }) => {
          received = url;
          return { id: 'ext1', company: 'Microsoft', title: 'Senior Data Engineer', url, score: 82, tier: 'Apply', appStatusHint: 'scored' };
        },
      },
    });
    const r = await post('/api/add-url', { url: 'https://careers.microsoft.com/jobs/123' });
    expect(r.status).toBe(200);
    expect(received).toBe('https://careers.microsoft.com/jobs/123');
    expect(r.body).toMatchObject({ company: 'Microsoft', tier: 'Apply', score: 82 });
  });

  it('POST /api/add-url surfaces a blocked-page error with its status code', async () => {
    await dash.close();
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
        ingestUrlFn: async () => { throw Object.assign(new Error('could not read that page (HTTP 403)'), { statusCode: 422 }); },
      },
    });
    const r = await post('/api/add-url', { url: 'https://blocked.example.com/x' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/could not read that page/);
  });
});

describe('reports, prepare-selected, and submission-record endpoints', () => {
  let db;
  let dash;
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'p1', company: 'Acme', title: 'Sr DE', url: 'http://a', source: 'greenhouse',
      score: 88, tier: 'Priority', sponsorship: 'Confirmed', status: 'ready_for_submit',
      application_packet_path: '/p/p1.json',
    });
    db.upsertJob({ id: 'p2', company: 'Globex', title: 'DE', url: 'http://b', source: 'ashby', score: 70, tier: 'Queue' });
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        prepareForJobsFn: async ({ jobIds }) => ({
          prepared: jobIds.map((jobId) => ({ jobId, packetPath: `/p/${jobId}.json` })),
          failed: [],
        }),
      },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('GET /api/reports returns the full reports bundle', async () => {
    const { status, body } = await get('/api/reports');
    expect(status).toBe(200);
    expect(body.dailySummary.daily).toHaveLength(7);
    expect(Array.isArray(body.applicationLog)).toBe(true);
    expect(Array.isArray(body.sourcePerformance)).toBe(true);
    expect(body.sourcePerformance.find((s) => s.source === 'greenhouse')).toBeDefined();
  });

  it('POST /api/prepare-batch prepares the selected jobs asynchronously', async () => {
    const started = await post('/api/prepare-batch', { jobIds: ['p2'] });
    expect(started.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const s = (await get('/api/run/status')).body;
    expect(s.running).toBe(false);
    expect(s.lastResult).toMatchObject({ phase: 'prepare-selected', counters: { jobs_prepared: 1 } });
    expect((await post('/api/prepare-batch', {})).status).toBe(400); // no ids
  });

  it('mark-submitted accepts a confirmation number and note', async () => {
    const r = await post('/api/jobs/p1/mark-submitted', {
      confirmationNumber: 'REQ-9', note: 'submitted via Greenhouse',
    });
    expect(r.status).toBe(200);
    expect(r.body.confirmationNumber).toBe('REQ-9');
    const job = db.getJob('p1');
    expect(job.submitted_confirmation).toBe('REQ-9');
    expect(job.notes).toContain('submitted via Greenhouse');
    expect(Number(job.applied)).toBe(1);
  });

  it('GET /api/jobs supports the ATS filter', async () => {
    db.upsertJob({ id: 'p1', ats_platform: 'greenhouse' });
    const { body } = await get('/api/jobs?ats=greenhouse');
    expect(body.jobs.map((j) => j.id)).toEqual(['p1']);
  });
});

describe('static assets', () => {
  let db;
  let dash;

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps: { now: () => NOW } });
  });
  afterEach(async () => {
    await dash.close();
    db.close();
  });

  it('404s a missing static asset', async () => {
    expect((await fetch(dash.url + '/assets/js/does-not-exist.js')).status).toBe(404);
  });

  it('never serves files outside the public dir via traversal', async () => {
    // Encoded slashes (%2f) keep the "../../" from being collapsed by fetch, so
    // the request reaches serveStatic and its guard rejects the escape. Either
    // way (guard 403 or unmatched 404), the server source must never leak.
    const res = await fetch(dash.url + '/assets/..%2f..%2fserver.js');
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('createDashboardServer');
  });
});
