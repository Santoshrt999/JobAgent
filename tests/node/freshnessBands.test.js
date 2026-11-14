/** Smooth apply-window bands in the queue order (audit Backlog #10). */
import { describe, it, expect } from 'vitest';
import { compareJobsForQueue, freshnessBand, sortJobsForQueue } from '../../src/scoring/jobRanking.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('freshness bands', () => {
  it('bands a posting by age', () => {
    expect([0.5, 2, 5, 14, 28].map((d) => freshnessBand(ago(d), NOW))).toEqual([4, 3, 2, 1, 0]);
    expect(freshnessBand(null, NOW)).toBe(1);
  });

  it('a two-day-old posting outranks a four-week-old one with the same score and tier', () => {
    const old = { id: 'old', tier: 'Apply', score: 85, postedAt: ago(28) };
    const fresh = { id: 'fresh', tier: 'Apply', score: 85, postedAt: ago(2) };
    expect(sortJobsForQueue([old, fresh], NOW).map((j) => j.id)).toEqual(['fresh', 'old']);
  });

  it('still puts tier first, and score decides within a band', () => {
    const cmp = compareJobsForQueue(NOW);
    expect(cmp({ tier: 'Priority', score: 70, postedAt: ago(30) }, { tier: 'Apply', score: 99, postedAt: ago(0.1) })).toBeLessThan(0);
    expect(cmp({ tier: 'Apply', score: 90, postedAt: ago(2) }, { tier: 'Apply', score: 80, postedAt: ago(1.5) })).toBeLessThan(0);
  });
});
