/**
 * Data quality agrees with the Jobs list, and answers from memory (BUG-10).
 * "Active" summed raw `scored` + `needs_description` rows, so rejected and
 * archived jobs (whose status column stays `scored`) counted as active while
 * prepared ones did not; and every open re-ran a full-table GROUP BY.
 */
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';
import { dataQualitySummary } from '../../src/dashboard/dataQuality.js';
import { applyDecision, boardPage } from '../../src/dashboard/data.js';

const NOW = new Date('2026-11-13T12:00:00Z');

describe('the Data quality "active" count', () => {
  it('matches the "All jobs" list after rejections and preparation', () => {
    const db = openDatabase({ path: ':memory:' });
    const base = { company: 'Northwind', title: 'Data Engineer', jd_text: 'SQL', posted_at: '2026-11-12T00:00:00Z', discovery_mode: 'profile' };
    for (let i = 0; i < 6; i += 1) db.upsertJob({ ...base, id: `s${i}`, status: 'scored', score: 70 + i });
    db.upsertJob({ ...base, id: 'prep', status: 'prepared', score: 80, application_packet_path: '/p.json' });
    db.upsertJob({ ...base, id: 'gone', status: 'discarded', score: 10, discard_reason: 'too old' });
    applyDecision(db, 's0', 'rejected');
    applyDecision(db, 's1', 'archived');

    const listed = boardPage(db, { now: NOW, hideApplied: 'true' }).total;
    const dq = dataQualitySummary(db, {}, { now: NOW });
    expect(dq.board.active).toBe(listed);
    expect(dq.board.active).toBe(5); // s2..s5 + prep
    expect(dq.filtered.reduce((n, f) => n + f.count, 0)).toBe(1);
    db.close();
  });

  it('serves the table-wide groupings from memory until something changes', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'a', company: 'N', title: 'T', status: 'discarded', discard_reason: 'too old', discovery_mode: 'profile' });
    let scans = 0;
    const real = db.db.prepare.bind(db.db);
    db.db.prepare = (sql) => { if (/GROUP BY discard_reason/.test(sql)) scans += 1; return real(sql); };
    dataQualitySummary(db, {}, { now: NOW });
    dataQualitySummary(db, {}, { now: NOW });
    expect(scans).toBe(1);
    db.upsertJob({ id: 'b', company: 'N', title: 'T', status: 'discarded', discard_reason: 'too old', discovery_mode: 'profile' });
    expect(dataQualitySummary(db, {}, { now: NOW }).filtered[0].count).toBe(2);
    expect(scans).toBe(2);
    db.close();
  });
});
