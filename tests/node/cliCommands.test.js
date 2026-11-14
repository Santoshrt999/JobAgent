import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../../src/logging/db.js';
import { enqueueForApproval, APPROVAL_STATUS } from '../../src/apply/approvalQueue.js';
import {
  runDiscover, runAssist, listApprovalQueue, approvePacket, rejectPacket,
  listPackets, getPacket, loadPacket, ingestUrl,
} from '../../src/cli/commands.js';
import { loadTestConfig } from './helpers/testConfig.js';
import { LIFECYCLE } from '../../src/lifecycle.js';
import { scoreJob, freshnessModelFor } from '../../src/scoring/scorer.js';
import { classifySponsorship } from '../../src/scoring/sponsorshipClassifier.js';

describe('freshnessModelFor', () => {
  it('reads the discovery window from runtime and retention from exclusions', () => {
    expect(freshnessModelFor({ runtime: { jobFreshnessMode: 'LAST_3_DAYS' }, exclusions: { staleness: { skipOlderThanDays: 30 } } }))
      .toEqual({ discoveryDays: 3, retentionDays: 30 });
  });
  it('defaults to 7 / 45 and maps ALL onto the retention limit', () => {
    expect(freshnessModelFor({})).toEqual({ discoveryDays: 7, retentionDays: 45 });
    expect(freshnessModelFor({ runtime: { jobFreshnessMode: 'ALL' } })).toEqual({ discoveryDays: 45, retentionDays: 45 });
  });
});

function writePacketFile(dir, id, packet) {
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(packet), 'utf8');
  return path;
}

describe('approval-queue CLI commands', () => {
  let db; let dir;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    dir = mkdtempSync(join(tmpdir(), 'packets-'));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function enqueue(jobId, score = 90, tier = 'Priority', blockers = []) {
    const packet = { job: { id: jobId, company: `Co-${jobId}`, title: 'SDE', url: 'https://x/apply' }, score, tier, blockers };
    const path = writePacketFile(dir, jobId, packet);
    return { ...enqueueForApproval(db, { packet, packetPath: path }), packet, path };
  }

  it('lists pending packets, then all packets after approval', () => {
    enqueue('a'); enqueue('b');
    expect(listApprovalQueue(db)).toHaveLength(2);
    const { id } = listApprovalQueue(db)[0];
    approvePacket(db, id);
    expect(listApprovalQueue(db)).toHaveLength(1); // only pending now
    expect(listApprovalQueue(db, { all: true })).toHaveLength(2);
  });

  it('approve / reject update status', () => {
    const a = enqueue('a');
    expect(approvePacket(db, a.id).status).toBe(APPROVAL_STATUS.APPROVED);
    const b = enqueue('b');
    expect(rejectPacket(db, b.id).status).toBe(APPROVAL_STATUS.REJECTED);
  });

  it('listPackets returns a joined view with company/score/blockers', () => {
    enqueue('a', 88, 'Apply', ['resume warning']);
    const rows = listPackets(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe('Co-a');
    expect(rows[0].score).toBe(88);
    expect(rows[0].blockers).toEqual(['resume warning']);
  });

  it('getPacket finds by job id', () => {
    enqueue('job-xyz');
    const found = getPacket(db, 'job-xyz');
    expect(found).not.toBe(null);
    expect(found.packet.job.id).toBe('job-xyz');
    expect(getPacket(db, 'missing')).toBe(null);
  });

  it('loadPacket tolerates a missing/corrupt file', () => {
    expect(loadPacket({ packet_path: join(dir, 'nope.json') })).toBe(null);
    expect(loadPacket({})).toBe(null);
  });
});

describe('runDiscover', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'discover-')); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes found_jobs.json with FOUND lifecycle and null scores', async () => {
    const searchFn = async () => ({
      jobs: [{
        id: 'gh:acme::sde::1', source: 'greenhouse', company: 'Acme', title: 'SDE',
        location: 'Remote', url: 'https://x', rawMetadata: { sourceKind: 'ats', discovery: { match: 'strong', signals: [], reasons: [] } },
      }],
      duplicates: [], errors: [],
    });
    const r = await runDiscover({
      config: { root, jobboards: {}, candidate: {}, scoring: {} },
      logger: null,
      deps: { searchFn },
    });
    expect(r.counters.jobs_found).toBe(1);
    expect(r.jobs[0].lifecycle).toBe(LIFECYCLE.FOUND);
    expect(r.jobs[0].score).toBe(null);
    expect(r.found.endsWith('found_jobs.json')).toBe(true);
  });
});

describe('ingestUrl (add a job by URL)', () => {
  let db;
  const config = loadTestConfig({ loadEnv: false, env: {} });
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => db.close());

  // A page exposing a schema.org JobPosting JSON-LD (the legitimate public path).
  const jdHtml = (title, desc, org = 'Microsoft') => `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'JobPosting',
      title, description: desc, hiringOrganization: { name: org },
      jobLocation: { address: { addressLocality: 'Redmond', addressRegion: 'WA', addressCountry: 'US' } },
      datePosted: '2026-06-01',
    })}</script></head><body><h1>${title}</h1></body></html>`;

  it('reads, scores, and persists a strong-fit posting from a public URL', async () => {
    const desc = 'Senior Data Engineer building Azure Databricks medallion lakehouses with PySpark, '
      + 'Delta Lake, Azure Data Factory, Synapse, and Power BI. We sponsor H-1B visas.';
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => jdHtml('Senior Data Engineer', desc) });
    const r = await ingestUrl({
      config, db, url: 'https://careers.microsoft.com/jobs/123', deps: { fetchImpl, now: new Date('2026-06-05') },
    });
    expect(r.company).toBe('Microsoft');
    expect(r.title).toBe('Senior Data Engineer');
    expect(typeof r.score).toBe('number');
    expect(r.appStatusHint).toBe('scored');
    // Persisted so it shows on the board.
    const job = db.getJob(r.id);
    expect(job).toBeTruthy();
    expect(job.company).toBe('Microsoft');
    expect(job.status).toBe('scored');
    expect(job.url).toBe('https://careers.microsoft.com/jobs/123');
  });

  it('rejects an invalid (non-http) URL', async () => {
    await expect(ingestUrl({ config, db, url: 'not a url' })).rejects.toThrow(/valid public job URL/);
  });

  it('refuses a public-looking name that resolves to this machine, without sending a request (P0-2)', async () => {
    const { createServer } = await import('node:http');
    let hits = 0;
    const server = createServer((_req, res) => { hits += 1; res.end('<h1>secret local page</h1>'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    // A DNS answer like localtest.me's: a public-looking name that points at 127.0.0.1.
    const lookupImpl = (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
    try {
      const err = await ingestUrl({ config, db, url: `http://jobs.rebind-example.com:${port}/posting`, deps: { lookupImpl } })
        .then(() => null, (e) => e);
      expect(err).toBeTruthy();
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/private or local network address/);
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('E2 — grades freshness with the same model as discovery, not the legacy 7/14-day curve', async () => {
    const desc = 'Senior Data Engineer building Azure Databricks lakehouses with PySpark, Delta Lake and SQL.';
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => jdHtml('Senior Data Engineer', desc) });
    // 20 days after datePosted: outside the legacy curve's 14 days (0 points),
    // inside the 45-day retention (partial points under the discovery model).
    const now = new Date('2026-06-21');
    const r = await ingestUrl({ config, db, url: 'https://careers.microsoft.com/jobs/456', deps: { fetchImpl, now } });
    const row = db.getJob(r.id);
    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title, location: row.location,
      url: row.url, jdText: row.jd_text, postedAt: row.posted_at, employmentType: row.employment_type ?? '',
    };
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const args = { scoring: config.scoring, sponsorship, candidate: config.candidate, now, exclusions: config.exclusions };
    const model = scoreJob(job, { ...args, freshnessModel: freshnessModelFor(config) });
    const legacy = scoreJob(job, args);
    expect(model.breakdown.freshness.points).toBeGreaterThan(legacy.breakdown.freshness.points);
    expect(r.score).toBe(model.total);
  });

  it('reports honestly when the page is blocked (no fabricated job)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' });
    await expect(ingestUrl({ config, db, url: 'https://blocked.example.com/x', deps: { fetchImpl } }))
      .rejects.toThrow(/could not read that page/);
  });

  it('reports when no job posting is found on the page', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html><body></body></html>' });
    await expect(ingestUrl({ config, db, url: 'https://empty.example.com/x', deps: { fetchImpl } }))
      .rejects.toThrow(/no job posting found/);
  });

  it('persists even an off-target posting so the user sees it was considered', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200,
      text: async () => jdHtml('Warehouse Associate', 'Lift boxes in the warehouse. No remote.', 'Acme') });
    const r = await ingestUrl({ config, db, url: 'https://careers.acme.com/jobs/9', deps: { fetchImpl } });
    expect(['scored', 'discarded']).toContain(r.appStatusHint);
    expect(db.getJob(r.id)).toBeTruthy();
  });

  it('still SCORES a stale posting (manual add overrides the bulk freshness filter)', async () => {
    // A deliberately-pasted older posting must be scored, not silently discarded
    // with a null score — that was the "why am I not seeing the score?" bug.
    const stale = jdHtml('Senior Data Engineer',
      'Azure Databricks, PySpark, Delta Lake, Synapse, Power BI. H-1B sponsorship available.');
    const dated = stale.replace('"datePosted":"2026-06-01"', '"datePosted":"2026-04-01"');
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => dated });
    const r = await ingestUrl({
      config, db, url: 'https://careers.microsoft.com/jobs/stale', deps: { fetchImpl, now: new Date('2026-06-11') },
    });
    expect(typeof r.score).toBe('number');        // scored, not null
    expect(r.score).toBeGreaterThan(0);
    expect(r.caveat).toMatch(/stale_posting/);     // staleness surfaced as a caveat
    const job = db.getJob(r.id);
    expect(job.score).not.toBeNull();
    expect(job.explanation).toMatch(/Heads-up.*stale/);
  });
});

describe('runAssist', () => {
  let db; let dir;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); dir = mkdtempSync(join(tmpdir(), 'assist-')); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('only acts on APPROVED packets and fills them, never submitting', async () => {
    const mk = (id) => {
      const packet = { job: { id, url: 'https://x/apply' }, score: 90, blockers: [] };
      const path = writePacketFile(dir, id, packet);
      return enqueueForApproval(db, { packet, packetPath: path });
    };
    const approved = mk('a'); mk('b'); // b stays pending
    approvePacket(db, approved.id);

    const assistFn = async ({ packet }) => ({
      jobId: packet.job.id, status: LIFECYCLE.READY_FOR_SUBMIT, submitted: false, blockers: [],
    });

    const r = await runAssist({
      config: { runtime: {}, scoring: {} },
      db, logger: null, mode: 'LIVE_ASSIST',
      deps: { assistFn },
    });

    expect(r.results).toHaveLength(1); // only the approved packet
    expect(r.counters.jobs_assisted).toBe(1);
    expect(r.results[0].submitted).toBe(false);
    expect(r.results[0].status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
  });

  it('never passes autoSubmit to the filler, even when a caller asks for it (P2-8)', async () => {
    const packet = { job: { id: 'cli-x', url: 'https://x/apply' }, score: 90, blockers: [] };
    const approval = enqueueForApproval(db, { packet, packetPath: writePacketFile(dir, 'cli-x', packet) });
    approvePacket(db, approval.id);
    const seen = [];
    const assistFn = async ({ packet: p, options }) => {
      seen.push(options);
      return { jobId: p.job.id, status: LIFECYCLE.READY_FOR_SUBMIT, submitted: false, blockers: [] };
    };
    await runAssist({
      config: { runtime: {}, scoring: {} }, db, logger: null,
      options: { autoSubmit: true, headless: true }, deps: { assistFn },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].autoSubmit).toBe(false);
    expect(seen[0].headless).toBe(true); // other options still pass through
  });

  it('does NOT re-apply to a job already marked applied (idempotency guard)', async () => {
    const id = 'already-done';
    const packet = { job: { id, url: 'https://x/apply' }, score: 90, blockers: [] };
    const path = writePacketFile(dir, id, packet);
    const approval = enqueueForApproval(db, { packet, packetPath: path });
    approvePacket(db, approval.id);
    // Simulate a prior successful submission.
    db.upsertJob({ id, applied: 1, applied_at: new Date().toISOString(), status: LIFECYCLE.SUBMITTED });

    let called = 0;
    const assistFn = async ({ packet: p }) => {
      called += 1;
      return { jobId: p.job.id, status: LIFECYCLE.SUBMITTED, submitted: true, blockers: [] };
    };

    const r = await runAssist({
      config: { runtime: {}, scoring: {} },
      db, logger: null,
      deps: { assistFn },
    });

    expect(called).toBe(0); // never re-submitted
    expect(r.results).toHaveLength(0);
    expect(r.counters.jobs_skipped_already_applied).toBe(1);
  });
});
