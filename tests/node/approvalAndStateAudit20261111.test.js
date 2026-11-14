/**
 * Approval, state and launcher regressions from the 2026-11-11 audit
 * (docs/audits/FABLE_AUDIT_2026-11-11.md: AF-10..AF-13, AF-16, DI-01, DI-02,
 * SEC-03, SEC-05). The dashboard runs against an in-memory store and a private
 * workspace; the browser runner is a fake that records whether it was called.
 */
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTestRoot } from './globalSetup.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { applyVersionedMigrations, openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { packetOwner } from '../../src/apply/applicationPacket.js';
import { approvalDigest, approvedDigest, digestChanges } from '../../src/apply/approvalDigest.js';
import {
  APPLICATION_PHASE, createApplicationState, markApplicationUserSubmitted, resolveApplicationStateStore,
} from '../../src/apply/applicationState.js';
import { recordAssistResult, preparePacketsForJobs } from '../../src/cli/commands.js';
import { canTransition, LIFECYCLE } from '../../src/lifecycle.js';
import { instanceProof } from '../../src/dashboard/apiToken.js';
import { identifyRunningDashboard, runApp } from '../../src/cli/app.js';

/* ───────────────────────────── dashboard harness ───────────────────────────── */

let root;
let config;
let db;
let dash;
let assistCalls;
let packets;

function packetFor(jobId) {
  const dir = join(root, 'applications', 'output', jobId);
  mkdirSync(dir, { recursive: true });
  const resume = join(dir, 'resume.docx');
  writeFileSync(resume, `tailored resume for ${jobId}`);
  return {
    id: `pk-${jobId}`,
    job: { id: jobId, url: `https://careers.example.test/${jobId}/apply`, title: 'Data Engineer', company: 'Example Co' },
    owner: packetOwner(config),
    blockers: [],
    screeningPlan: { answered: [{ label: 'Desired salary', answer: 'Around $150,000 per year' }], needsUser: [] },
    fillPlan: { steps: [], uploads: [{ type: 'resume', path: resume, required: true }] },
    resumePath: resume,
  };
}

function seedJob(id, { status = 'prepared', approval = 'pending_review', decision = null, applied = 0 } = {}) {
  db.upsertJob({
    id, company: 'Example Co', title: 'Data Engineer', url: `https://careers.example.test/${id}/apply`,
    source: 'greenhouse', score: 90, tier: 'Priority', sponsorship: 'Confirmed', status, applied,
    jd_text: 'Build data pipelines. '.repeat(40),
  });
  if (decision) db.setUserDecision?.(id, decision);
  packets.set(id, packetFor(id));
  db.insertApproval({ id: `ap-${id}`, job_id: id, packet_path: `/packets/${id}.json`, approval_status: approval });
}

const post = (p, body) => fetch(dash.url + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

async function idle() {
  for (let i = 0; i < 100; i += 1) {
    const s = await fetch(`${dash.url}/api/run/status`).then((r) => r.json());
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('run did not finish');
}

async function boot(beforeStart) {
  root = buildTestRoot();
  config = loadConfig({ root, loadEnv: false, env: {} });
  db = openDatabase({ path: ':memory:' });
  packets = new Map();
  assistCalls = [];
  beforeStart?.();
  dash = await startDashboard({
    config, db, logger: null, port: 0,
    deps: {
      loadPacketImpl: (approval) => packets.get(approval.job_id) ?? null,
      assistFn: async ({ packet }) => {
        assistCalls.push(packet.job.id);
        return { jobId: packet.job.id, status: 'ready_for_submit', blockers: [], filled: [], phases: [] };
      },
      browserAvailable: async () => ({ ok: true }),
      checkBrowserAvailable: async () => ({ ok: true }),
    },
  });
}

afterEach(async () => {
  await dash?.close?.();
  db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  dash = null; db = null; root = null;
});

describe('approval covers what it approved (AF-10, DI-01)', () => {
  beforeEach(async () => { await boot(); });

  it('records a digest with the approval and fills when nothing changed', async () => {
    seedJob('same');
    expect((await post('/api/jobs/same/approve')).status).toBe(200);
    expect(approvedDigest(db, 'same')).toMatchObject({ answers: expect.any(String), resume: expect.any(String) });
    expect((await post('/api/jobs/same/assist')).status).toBe(202);
    await idle();
    expect(assistCalls).toEqual(['same']);
  });

  it('withdraws the approval and refuses to fill when an answer changed after approving', async () => {
    seedJob('edited');
    await post('/api/jobs/edited/approve');
    const salary = config.screeningAnswers.answers.find((a) => a.id === 'salary_expectation');
    salary.answer = 'Around $90,000 per year';
    const r = await post('/api/jobs/edited/assist');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed since you approved it: your saved screening answers/);
    expect(db.getApprovalByJob('edited').approval_status).toBe('pending_review');
    expect(db.listEvents('edited').map((e) => e.event_type)).toContain('approval_withdrawn');
    expect(assistCalls).toEqual([]);
  });

  it('notices the tailored resume being replaced after approval', async () => {
    seedJob('resume');
    await post('/api/jobs/resume/approve');
    writeFileSync(packets.get('resume').resumePath, 'a different resume');
    const r = await post('/api/jobs/resume/assist');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/the resume/);
  });

  it('refuses to approve a job that was already submitted', async () => {
    seedJob('sent', { status: 'submitted', applied: 1 });
    const r = await post('/api/jobs/sent/approve');
    expect(r.status).toBe(409);
    expect(db.getApprovalByJob('sent').approval_status).toBe('pending_review');
  });

  it('writes an audit event for approve and for reject', async () => {
    seedJob('a');
    seedJob('b');
    await post('/api/jobs/a/approve');
    await post('/api/jobs/b/reject-packet');
    expect(db.listEvents('a').map((e) => e.event_type)).toContain('packet_approved');
    expect(db.listEvents('b').map((e) => e.event_type)).toContain('packet_rejected');
  });
});

describe('what auto-fill will not touch (AF-13)', () => {
  beforeEach(async () => { await boot(); });

  it('skips a packet the person rejected instead of approving it for them', async () => {
    seedJob('kept');
    seedJob('rejected', { approval: 'rejected' });
    expect((await post('/api/assist-batch', { jobIds: ['kept', 'rejected'] })).status).toBe(202);
    const status = await idle();
    expect(assistCalls).toEqual(['kept']);
    expect(db.getApprovalByJob('rejected').approval_status).toBe('rejected');
    expect(JSON.stringify(status)).toMatch(/you rejected this packet/);
  });

  it('refuses to fill a job the person archived', async () => {
    seedJob('archived', { approval: 'approved', decision: 'archived' });
    const r = await post('/api/jobs/archived/assist');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/you archived this job/);
    expect(assistCalls).toEqual([]);
  });
});

describe('assist results are state changes with a record (AF-12, AF-16)', () => {
  beforeEach(async () => { await boot(); });

  it('a fill moves through assist_started to its outcome, each with an event', async () => {
    seedJob('run', { approval: 'approved' });
    await post('/api/jobs/run/assist');
    await idle();
    const moves = db.listEvents('run').filter((e) => e.event_type === 'status_changed')
      .map((e) => JSON.parse(e.metadata)).map((m) => `${m.from}->${m.to}:${m.actor}`);
    expect(moves).toEqual(['prepared->assist_started:assist', 'assist_started->ready_for_submit:assist']);
  });

  it('never creates a row for a job the store does not hold', () => {
    recordAssistResult(db, 'not-here', { status: 'submit_unverified', blockers: [], humanSubmissionDetected: { signals: [] } });
    expect(db.getJob('not-here')).toBeFalsy();
  });

  it('only the run may move a job through the assist outcomes, and never out of submitted', () => {
    expect(canTransition('prepared', LIFECYCLE.READY_FOR_SUBMIT)).toBe(false);
    expect(canTransition('prepared', LIFECYCLE.READY_FOR_SUBMIT, { actor: 'assist' })).toBe(true);
    expect(canTransition(LIFECYCLE.SUBMITTED, LIFECYCLE.ASSIST_BLOCKED, { actor: 'assist' })).toBe(false);
    expect(canTransition(LIFECYCLE.HARD_DISCARDED, LIFECYCLE.ASSIST_STARTED, { actor: 'assist' })).toBe(false);
  });
});

describe('recovery after a restart (AF-12)', () => {
  it('a job left "being filled" by a stopped app is marked interrupted and resumable', async () => {
    await boot(() => {
      db.upsertJob({ id: 'stuck', company: 'Example Co', title: 'Data Engineer', status: 'assist_started', score: 80, tier: 'Apply' });
    });
    const job = db.getJob('stuck');
    expect(job.status).toBe(LIFECYCLE.CANCELLED);
    expect(String(job.assist_blockers)).toMatch(/interrupted/);
  });
});

describe('"No, it didn\'t go through" reopens the application (AF-11, DI-02)', () => {
  beforeEach(async () => { await boot(); });

  it('resets the checkpoint so the next fill opens the form', async () => {
    seedJob('retry', { approval: 'approved' });
    const packet = packets.get('retry');
    const store = resolveApplicationStateStore({ packet, root });
    await store.save(createApplicationState(packet));
    await markApplicationUserSubmitted({ root, packet, evidence: ['reported by the person'] });
    db.setJobStatus('retry', 'submit_unverified', { actor: 'human', reason: 'reported by the person' });

    expect((await post('/api/jobs/retry/not-submitted')).status).toBe(200);
    const state = await store.load();
    expect([APPLICATION_PHASE.READY_FOR_REVIEW, APPLICATION_PHASE.BLOCKED]).toContain(state.phase);
    expect(state.submissionEvidence).toEqual([]);
  });

  it('will not re-prepare an application that is reported submitted but unconfirmed', async () => {
    seedJob('pending', { status: 'submit_unverified', approval: 'approved' });
    const r = await preparePacketsForJobs({ config, db, logger: null, jobIds: ['pending'], deps: {} });
    expect(r.failed).toEqual([{ jobId: 'pending', error: expect.stringMatching(/confirm or deny/) }]);
  });
});

/* ───────────────────────────── pure helpers ───────────────────────────── */

describe('approvalDigest', () => {
  it('names exactly the parts that changed and ignores parts an old record lacks', () => {
    const before = { resume: 'a', coverLetter: null, answers: 'x', profile: 'p', plan: 'q' };
    expect(digestChanges(before, { ...before })).toEqual([]);
    expect(digestChanges(before, { ...before, answers: 'y', profile: 'z' }))
      .toEqual(['your saved screening answers', 'your profile details']);
    expect(digestChanges({ answers: 'x' }, { resume: 'new', answers: 'x' })).toEqual([]);
    expect(digestChanges(null, before)).toEqual([]);
  });

  it('stores hashes, never the values', () => {
    const d = approvalDigest(
      { screeningPlan: { answered: [{ label: 'Salary', answer: '$150,000' }] } },
      { candidate: { contact: { email: 'someone@example.test' } }, screeningAnswers: { answers: [{ id: 's', answer: '$150,000' }] } },
    );
    expect(JSON.stringify(d)).not.toMatch(/150,000|someone@/);
  });
});

describe('a store from newer code is refused (SEC-05)', () => {
  it('throws SCHEMA_TOO_NEW instead of writing to it', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA user_version = 999');
    expect(() => applyVersionedMigrations(raw)).toThrow(/newer JobAgent/);
    raw.close();
  });
});

/* ───────────────────────────── launcher (SEC-03) ───────────────────────────── */

describe('the launcher sends the access token only to a server that proves it holds it', () => {
  const TOKEN = 't'.repeat(43);
  const servers = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
  });
  async function serve(handler) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server.address().port;
  }
  const status = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ running: false, phase: null, cancelRequested: false }));
  };

  it('proves the real dashboard and only then sends the token', async () => {
    const seen = [];
    const port = await serve((req, res) => {
      seen.push(req.headers['x-job-agent-token'] ?? null);
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/instance') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ app: 'job-agent', proof: instanceProof(TOKEN, u.searchParams.get('challenge')) }));
      }
      return status(res);
    });
    expect(await identifyRunningDashboard(port, { token: TOKEN })).toEqual({ url: `http://127.0.0.1:${port}`, proven: true });
    expect(seen).toEqual([null, TOKEN]);
  });

  it('never sends the token to a squatter that only mimics the status reply', async () => {
    const seen = [];
    const port = await serve((req, res) => {
      seen.push(req.headers['x-job-agent-token'] ?? null);
      if (req.url.startsWith('/api/instance')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ app: 'job-agent', proof: 'f'.repeat(64) }));
      }
      return status(res);
    });
    const found = await identifyRunningDashboard(port, { token: TOKEN });
    expect(found).toEqual({ url: `http://127.0.0.1:${port}`, proven: false });
    expect(seen.every((h) => h === null)).toBe(true);
  });

  it('runApp neither opens the unlock link nor starts a second server for an unproven listener', async () => {
    const port = await serve((req, res) => (req.url.startsWith('/api/instance') ? res.writeHead(404).end() : status(res)));
    const tokenRoot = buildTestRoot();
    mkdirSync(join(tokenRoot, 'data'), { recursive: true });
    writeFileSync(join(tokenRoot, 'data', '.dashboard-token'), TOKEN);
    const deps = {
      loadConfig: () => ({ root: tokenRoot, candidate: {} }),
      openDatabase: vi.fn(() => { throw new Error('must not open the database'); }),
      startDashboard: vi.fn(() => { throw new Error('must not start a second server'); }),
      openBrowser: vi.fn(() => true),
    };
    const result = await runApp({
      parsed: { positionals: ['app'], options: { port: String(port) }, flags: new Set() }, env: {}, deps,
    });
    rmSync(tokenRoot, { recursive: true, force: true });
    expect(result).toMatchObject({ ok: false, unproven: true });
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(deps.startDashboard).not.toHaveBeenCalled();
  });
});
