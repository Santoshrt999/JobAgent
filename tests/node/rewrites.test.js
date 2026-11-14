/**
 * Grounded rewrites end to end (P1-2), through the dashboard API with a stub
 * model and stub master units: proposals are verified, refused ones cannot be
 * accepted, decisions are recorded, an approved packet goes back to review,
 * and only accepted, verified rewrites reach the tailor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';
import { acceptedRewritesFor, proposeRewrites, rewriteSettings } from '../../src/resume/rewrites.js';

const ROLE = 'Data Engineer, Acme Corp | 2021 - Present';
const UNITS = [
  { id: 'u0', kind: 'section', role: null, text: 'EXPERIENCE' },
  { id: 'u1', kind: 'role', role: ROLE, text: ROLE },
  { id: 'u2', kind: 'bullet', role: ROLE, text: 'Built medallion pipelines on Azure Databricks with PySpark, cutting load time by 40%.' },
  { id: 'u3', kind: 'bullet', role: ROLE, text: 'Contributed to the migration of 3 legacy SSIS packages to Azure Data Factory.' },
];
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', RESUME_REWRITE: 'suggest' };

/** A model double that proposes one honest and one inflated rewrite. */
const fetchImpl = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ rewrites: [
    { unitId: 'u2', rewrite: 'Cut load time by 40% with Azure Databricks medallion pipelines built in PySpark.', evidence: ['u2'] },
    { unitId: 'u3', rewrite: 'Led the migration of 3 legacy SSIS packages to Azure Data Factory and Kafka.', evidence: ['u3'] },
  ] }) } }] }),
});
const deps = {
  fetchImpl,
  readMasterUnitsFn: async () => UNITS,
  extractJdRequirementsFn: async () => ({ phrases: ['Databricks', 'Kafka'] }),
};

describe('rewrite settings', () => {
  it('is off unless both the LLM and RESUME_REWRITE=suggest are on', () => {
    expect(rewriteSettings({}).enabled).toBe(false);
    expect(rewriteSettings({ RESUME_REWRITE: 'suggest' }).reason).toMatch(/LLM assist/);
    expect(rewriteSettings({ LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k' }).reason).toMatch(/RESUME_REWRITE=suggest/);
    expect(rewriteSettings(ENV).enabled).toBe(true);
  });
});

describe('proposeRewrites', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Globex', title: 'Data Engineer', url: 'https://x/1', jd_text: 'Databricks and Kafka.' });
  });

  it('verifies each proposal against the resume, never the posting', async () => {
    const r = await proposeRewrites({ db, job: db.getJob('j1'), config: { root: null, scoring: {} }, env: ENV, deps });
    expect(r.ok).toBe(true);
    const [honest, inflated] = r.record.items;
    expect(honest).toMatchObject({ unitId: 'u2', status: 'verified', decision: null });
    expect(inflated.status).toBe('refused');
    expect(inflated.reasons.join(' ')).toMatch(/Kafka/);
    expect(inflated.reasons.join(' ')).toMatch(/more ownership/);
    expect(r.record.task).toBe('rewrite-bullets@1');
    expect(acceptedRewritesFor(db, 'j1')).toEqual([]);
  });

  it('reports disabled instead of calling a model', async () => {
    let called = false;
    const r = await proposeRewrites({ db, job: db.getJob('j1'), config: {}, env: {}, deps: { ...deps, fetchImpl: async () => { called = true; } } });
    expect(r).toMatchObject({ ok: false, disabled: true });
    expect(called).toBe(false);
  });
});

describe('rewrite API', () => {
  let dash; let db;
  const call = (method, path, body) => fetch(`${dash.url}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeAll(async () => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Globex', title: 'Data Engineer', url: 'https://x/1', jd_text: 'Databricks.' });
    db.insertApproval({ id: 'ap1', job_id: 'j1', packet_path: '/p/j1.json', approval_status: 'approved' });
    const proposeRewritesImpl = (args) => proposeRewrites({ ...args, env: ENV, deps });
    dash = await startDashboard({ config: { scoring: {} }, db, logger: null, port: 0, deps: { proposeRewritesImpl } });
  });
  afterAll(async () => { await new Promise((r) => dash.server.close(r)); db.close(); });

  it('proposes, refuses to accept a refused item, accepts a verified one, and sends the packet back for review', async () => {
    expect((await call('GET', '/api/jobs/j1/rewrites')).body.record).toBeNull();
    const proposed = await call('POST', '/api/jobs/j1/rewrites');
    expect(proposed.status).toBe(200);
    expect(proposed.body.record.items.map((i) => i.status)).toEqual(['verified', 'refused']);

    const refused = await call('POST', '/api/jobs/j1/rewrite-decision', { unitId: 'u3', decision: 'accept' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/cannot be accepted/);

    const accepted = await call('POST', '/api/jobs/j1/rewrite-decision', { unitId: 'u2', decision: 'accept' });
    expect(accepted.body).toMatchObject({ changed: true, needsReapproval: true });
    expect(db.getApprovalByJob('j1').approval_status).toBe('pending_review');

    expect(acceptedRewritesFor(db, 'j1')).toEqual([{
      original: UNITS[2].text, rewrite: 'Cut load time by 40% with Azure Databricks medallion pipelines built in PySpark.',
      evidence: ['u2'], task: 'rewrite-bullets@1',
    }]);

    // Accepting again changes nothing and re-opens nothing.
    const again = await call('POST', '/api/jobs/j1/rewrite-decision', { unitId: 'u2', decision: 'accept' });
    expect(again.body).toMatchObject({ changed: false, needsReapproval: false });

    await call('POST', '/api/jobs/j1/rewrite-decision', { unitId: 'u2', decision: 'reject' });
    expect(acceptedRewritesFor(db, 'j1')).toEqual([]);
  });
});
