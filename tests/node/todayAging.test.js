/**
 * Old unsubmitted work sinks below fresh work on Today (audit BUG-09).
 * Measured live: card #2 was a role shortlisted from a posting 78 days old.
 */
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';
import { todayQueue, TODAY_AGING_DAYS } from '../../src/dashboard/data.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('Today demotes aging work', () => {
  it('a 78-day-old shortlist sits below a fresh one and is marked aging', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'ghost', title: 'Old', status: 'scored', score: 95, tier: 'Priority', user_decision: 'shortlisted', posted_at: daysAgo(78) });
    db.upsertJob({ id: 'fresh', title: 'New', status: 'scored', score: 70, tier: 'Queue', user_decision: 'shortlisted', posted_at: daysAgo(2) });
    db.upsertJob({ id: 'filled', title: 'Filled', status: 'ready_for_submit', score: 60, tier: 'Queue', posted_at: daysAgo(60) });
    const items = todayQueue(db, { now: NOW }).items;
    const order = items.map((i) => i.id);
    expect(order.indexOf('fresh')).toBeLessThan(order.indexOf('ghost'));
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.ghost.aging).toBe(78);
    // A filled form waiting for Submit is minutes from done: never demoted.
    expect(byId.filled.aging).toBeNull();
    expect(order[0]).toBe('filled');
    expect(byId.fresh.aging).toBeNull();
    db.close();
  });

  it('demotes only past the threshold, and never an undated posting', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'edge', title: 'E', status: 'scored', score: 80, tier: 'Queue', user_decision: 'shortlisted', posted_at: daysAgo(TODAY_AGING_DAYS) });
    db.upsertJob({ id: 'undated', title: 'U', status: 'scored', score: 80, tier: 'Queue', user_decision: 'shortlisted' });
    const byId = Object.fromEntries(todayQueue(db, { now: NOW }).items.map((i) => [i.id, i]));
    expect(byId.edge.aging).toBeNull();
    expect(byId.undated.aging).toBeNull();
    db.close();
  });
});
