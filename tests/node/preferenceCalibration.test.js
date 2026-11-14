/** Patterns in what the person turns down, as proposals only (audit Backlog #8). Fictional employers. */
import { describe, it, expect } from 'vitest';
import { preferenceProposals } from '../../src/dashboard/preferenceProposals.js';
import { openDatabase } from '../../src/logging/db.js';
import { applyDecision, todayQueue } from '../../src/dashboard/data.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const recent = '2026-11-10T00:00:00Z';

describe('preferenceProposals', () => {
  it('proposes archiving the rest of an employer rejected three times, naming the evidence', () => {
    const rows = [
      ...[1, 2, 3].map((i) => ({ id: `r${i}`, company: 'Staffing Co', user_decision: 'rejected', decided_at: recent })),
      { id: 'o1', company: 'staffing co', status: 'scored' },
      { id: 'o2', company: 'Staffing Co', status: 'scored' },
      { id: 'x', company: 'Northwind', status: 'scored' },
    ];
    const [p] = preferenceProposals(rows, { now: NOW });
    expect(p).toMatchObject({ kind: 'company', count: 3, action: 'proposal-archive', ids: ['o1', 'o2'] });
    expect(p.message).toMatch(/rejected 3 jobs from Staffing Co\. 2 more/);
  });

  it('points a repeated reason at its setting, and ignores old or sparse evidence', () => {
    const pay = (i, at = recent) => ({ id: `p${i}`, company: `C${i}`, user_decision: 'rejected', decision_reason: 'salary', decided_at: at });
    expect(preferenceProposals([1, 2, 3, 4].map((i) => pay(i)), { now: NOW })[0]).toMatchObject({ kind: 'reason', key: 'salary', action: 'open-edit-profile' });
    expect(preferenceProposals([1, 2, 3].map((i) => pay(i)), { now: NOW })).toEqual([]);
    expect(preferenceProposals([1, 2, 3, 4].map((i) => pay(i, '2026-06-01T00:00:00Z')), { now: NOW })).toEqual([]);
  });

  it('reaches Today from real decisions', () => {
    const db = openDatabase({ path: ':memory:' });
    for (let i = 0; i < 5; i += 1) db.upsertJob({ id: `j${i}`, company: 'Staffing Co', title: `Role ${i}`, status: 'scored', score: 60, tier: 'Queue' });
    for (let i = 0; i < 3; i += 1) applyDecision(db, `j${i}`, 'rejected', { reason: 'company' });
    const p = todayQueue(db, { now: new Date() }).proposals;
    expect(p[0]).toMatchObject({ kind: 'company', count: 3 });
    expect(p[0].ids.sort()).toEqual(['j3', 'j4']);
    db.close();
  });
});
