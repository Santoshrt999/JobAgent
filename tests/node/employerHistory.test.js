/** Employer sponsorship memory and repost detection (audit Backlog #3, #7). Fictional employers. */
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';
import { employerHistory, sponsorshipVerdict } from '../../src/dashboard/employerHistory.js';
import { jobDetail } from '../../src/dashboard/data.js';

const day = (d) => new Date(Date.UTC(2026, 6, 1) + d * 86_400_000).toISOString();

function seed() {
  const db = openDatabase({ path: ':memory:' });
  for (let i = 0; i < 4; i += 1) {
    db.upsertJob({ id: `no${i}`, company: 'Northwind', title: `Analyst ${i}`, status: 'discarded', discard_reason: 'sponsorship_denial: sponsorship is not available' });
  }
  db.upsertJob({ id: 'open', company: 'Northwind', title: 'Data Engineer', status: 'scored', score: 80, sponsorship: 'Unconfirmed', posted_at: day(90) });
  for (let i = 0; i < 3; i += 1) {
    db.upsertJob({ id: `rep${i}`, company: 'Northwind', title: 'Data Engineer', sourceJobId: `r${i}`, status: 'discarded', posted_at: day(i * 30) });
  }
  db.upsertJob({ id: 'c1', company: 'Contoso', title: 'Engineer', status: 'scored', sponsorship: 'Confirmed' });
  db.upsertJob({ id: 'c2', company: 'contoso', title: 'Engineer II', status: 'scored', sponsorship: 'Likely' });
  return db;
}

describe('employer history', () => {
  it('counts how the employer\'s other postings answered sponsorship, case-insensitively', () => {
    const db = seed();
    const north = employerHistory(db, { company: 'Northwind', title: 'Data Engineer' }, { sync: true });
    expect(north.employer).toMatchObject({ sponsorNo: 4, sponsorYes: 0, verdict: 'unlikely' });
    const contoso = employerHistory(db, { company: 'Contoso', title: 'Engineer' }, { sync: true });
    expect(contoso.employer).toMatchObject({ postings: 2, sponsorYes: 2, verdict: 'likely' });
    db.close();
  });

  it('flags a title reposted three or more times over a month or longer', () => {
    const db = seed();
    const h = employerHistory(db, { company: 'Northwind', title: 'Data Engineer' }, { sync: true });
    expect(h.repost).toMatchObject({ count: 4, spanDays: 90 });
    expect(employerHistory(db, { company: 'Northwind', title: 'Analyst 1' }, { sync: true }).repost).toBeNull();
    db.close();
  });

  it('is built off the request path: the first detail has none, a later one does', async () => {
    const db = seed();
    expect(jobDetail(db, 'open', {}).history).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(jobDetail(db, 'open', {}).history.repost.count).toBe(4);
    db.close();
  });

  it('only calls a verdict with two or more answers pointing one way', () => {
    expect(sponsorshipVerdict({ sponsorYes: 1, sponsorNo: 0 })).toBeNull();
    expect(sponsorshipVerdict({ sponsorYes: 1, sponsorNo: 1 })).toBe('mixed');
  });
});
