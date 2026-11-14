import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { pruneDescriptions, pruneEvents, unsafeToWriteReason } from '../../scripts/dbMaintenance.mjs';

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe('dbMaintenance — retention', () => {
  it('prunes only old untouched discarded descriptions, with an ISO cutoff', () => {
    const db = openDatabase({ path: ':memory:' });
    const jd = 'x'.repeat(300);
    db.upsertJob({ id: 'old', status: 'discarded', jd_text: jd, created_at: iso(90) });
    db.upsertJob({ id: 'decided', status: 'discarded', jd_text: jd, created_at: iso(90), user_decision: 'rejected' });
    db.upsertJob({ id: 'recent', status: 'discarded', jd_text: jd, created_at: iso(10) });
    // The cutoff day itself: 'YYYY-MM-DDT…' vs datetime()'s 'YYYY-MM-DD …' was wrong here.
    db.upsertJob({ id: 'edge', status: 'discarded', jd_text: jd, created_at: iso(60.02) });
    expect(pruneDescriptions(db.db, { days: 60 })).toMatchObject({ eligible: 2, cleared: 0 });
    expect(pruneDescriptions(db.db, { days: 60, apply: true }).cleared).toBe(2);
    expect(db.getJob('old')).toMatchObject({ jd_text: null, summary_only: 1 });
    expect(db.getJob('edge').jd_text).toBeNull();
    expect(db.getJob('recent').jd_text).toBe(jd);
    db.close();
  });

  it('prunes only score_explained / exclusion_matched events', () => {
    const db = openDatabase({ path: ':memory:' });
    db.insertEvent({ id: 'a', event_type: 'score_explained', created_at: iso(40) });
    db.insertEvent({ id: 'b', event_type: 'exclusion_matched', created_at: iso(40) });
    db.insertEvent({ id: 'c', event_type: 'application_submitted', created_at: iso(400) });
    db.insertEvent({ id: 'd', event_type: 'score_explained', created_at: iso(5) });
    expect(pruneEvents(db.db, { days: 30 })).toEqual({ eligible: 2, deleted: 0 });
    expect(pruneEvents(db.db, { days: 30, apply: true }).deleted).toBe(2);
    expect(db.listEvents().map((e) => e.id).sort()).toEqual(['c', 'd']);
    db.close();
  });

  it('refuses writes while a run holds the lock or the dashboard answers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-maint-'));
    const down = async () => { throw new Error('ECONNREFUSED'); };
    expect(await unsafeToWriteReason({ root, fetchImpl: down })).toBeNull();
    expect(await unsafeToWriteReason({ root, fetchImpl: async () => ({ ok: true }) })).toMatch(/dashboard is running/);
    // A locked dashboard (access token, P1-5) answers 401 but still holds the database.
    expect(await unsafeToWriteReason({ root, fetchImpl: async () => ({ ok: false, status: 401 }) })).toMatch(/dashboard is running/);
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', '.run.lock'), JSON.stringify({ pid: process.pid, owner: 'cli', phase: 'watch' }));
    expect(await unsafeToWriteReason({ root, fetchImpl: down })).toMatch(/holds data\/\.run\.lock/);
    rmSync(root, { recursive: true, force: true });
  });
});
