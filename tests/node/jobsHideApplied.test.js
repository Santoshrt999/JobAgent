/**
 * The Jobs list is for deciding what to apply to next (audit BUG-08).
 * Measured live: ranks #1 and #2 on Jobs were jobs already submitted, because
 * only archived/rejected/discarded were treated as closed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';
import { boardPage, BOARD_VIEWS, countViews } from '../../src/dashboard/data.js';

const NOW = new Date('2026-11-13T12:00:00Z');
let db;
beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  const base = { company: 'Northwind', title: 'Data Engineer', score: 80, jd_text: 'SQL', posted_at: '2026-11-12T00:00:00Z', discovery_mode: 'profile' };
  db.upsertJob({ ...base, id: 'applied', status: 'submitted', applied: 1, score: 95 });
  db.upsertJob({ ...base, id: 'unverified', status: 'submit_unverified', score: 94 });
  db.upsertJob({ ...base, id: 'open', status: 'scored', score: 70 });
  db.upsertJob({ ...base, id: 'ready', status: 'ready_for_submit', score: 60 });
});
afterEach(() => db.close());

const ids = (page) => page.jobs.map((j) => j.id).sort();

describe('the Jobs list leaves out jobs already applied to', () => {
  it('hides submitted and unconfirmed submissions when asked, keeps work in progress', () => {
    const page = boardPage(db, { now: NOW, hideApplied: 'true' });
    expect(ids(page)).toEqual(['open', 'ready']);
    expect(page.total).toBe(2);
  });

  it('the Applications view (no hideApplied) and "Closed jobs" still show them', () => {
    expect(ids(boardPage(db, { now: NOW }))).toEqual(['applied', 'open', 'ready', 'unverified']);
    expect(ids(boardPage(db, { now: NOW, hideClosed: 'false', hideApplied: 'true' }))).toContain('applied');
    expect(ids(boardPage(db, { now: NOW, view: 'submitted' }))).toEqual(['applied']);
  });

  it('the "All jobs" count matches the list it opens', () => {
    const rows = boardPage(db, { now: NOW, hideApplied: 'true', withViewCounts: 'true' });
    expect(rows.viewCounts.all).toBe(rows.total);
    expect(BOARD_VIEWS.all({ appStatus: 'submitted' })).toBe(false);
    expect(BOARD_VIEWS.all({ appStatus: 'scored' })).toBe(true);
    expect(typeof countViews).toBe('function');
  });
});
