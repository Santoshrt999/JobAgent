/**
 * Outcome calibration (P2-10): refuses without enough outcomes, finds a
 * planted signal and moves the right weight the right way within bounds,
 * keeps the total, and never touches config by itself.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { calibrate, MAX_STEP, roundPreservingTotal } from '../../src/scoring/calibration.js';
import { buildSamples } from '../../src/scoring/calibrationData.js';
import { openDatabase } from '../../src/logging/db.js';
import { loadTestConfig } from './helpers/testConfig.js';

const WEIGHTS = { titleFit: 20, stackFit: 20, freshness: 10 };
/** Interviews happened where stackFit was high; titleFit and freshness carry no signal. */
function planted(n = 40) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const positive = i % 2 === 0;
    out.push({
      positive,
      breakdown: {
        titleFit: { points: 10 + (i % 5) },
        stackFit: { points: positive ? 16 + (i % 4) : 4 + (i % 4) },
        freshness: { points: 5 + (i % 3) },
      },
    });
  }
  return out;
}

describe('outcome calibration (P2-10)', () => {
  it('refuses with too few outcomes, or too few on one side', () => {
    expect(calibrate(planted(10), WEIGHTS)).toMatchObject({ ok: false, reason: expect.stringMatching(/at least 30/) });
    const lopsided = planted(40).map((s, i) => ({ ...s, positive: i < 2 }));
    expect(calibrate(lopsided, WEIGHTS).reason).toMatch(/at least 5/);
  });

  it('raises the weight that tracks interviews, within the step, keeping the total', () => {
    const r = calibrate(planted(), WEIGHTS);
    expect(r.ok).toBe(true);
    const stack = r.categories.find((c) => c.category === 'stackFit');
    expect(stack.clear).toBe(true);
    expect(stack.difference).toBeGreaterThan(0);
    expect(r.proposed.stackFit).toBeGreaterThan(WEIGHTS.stackFit);
    expect(r.proposed.stackFit).toBeLessThanOrEqual(Math.ceil(WEIGHTS.stackFit * (1 + MAX_STEP)) + 1);
    expect(Object.values(r.proposed).reduce((a, b) => a + b, 0)).toBe(50);
    expect(r.categories.find((c) => c.category === 'freshness').clear).toBe(false);
  });

  it('gives the same answer every time', () => {
    expect(calibrate(planted(), WEIGHTS)).toEqual(calibrate(planted(), WEIGHTS));
  });

  it('rounds to whole points without changing the total', () => {
    expect(roundPreservingTotal({ a: 10.6, b: 10.6, c: 28.8 }, 50)).toEqual({ a: 11, b: 10, c: 29 });
  });

  it('builds samples from submitted applications: recorded outcomes and long silences only', () => {
    const config = loadTestConfig({ loadEnv: false, env: {} });
    const db = openDatabase({ path: ':memory:' });
    const job = (id, applied_at) => db.upsertJob({ id, company: 'Co', title: 'Data Engineer', url: `https://x/${id}`, source: 'greenhouse', jd_text: 'Python SQL Spark', applied: 1, status: 'submitted', applied_at });
    job('interviewed', '2026-10-01T00:00:00Z');
    job('rejected', '2026-10-01T00:00:00Z');
    job('ghosted', '2026-09-01T00:00:00Z');
    job('recent', '2026-11-08T00:00:00Z');
    const outcome = (jobId, outcomeName) => db.insertEvent({ id: randomUUID(), job_id: jobId, event_type: 'application_outcome', message: '', metadata: JSON.stringify({ outcome: outcomeName, on: '2026-10-10' }) });
    outcome('interviewed', 'interviewing');
    outcome('rejected', 'rejected');
    const samples = buildSamples(db, config, { now: new Date('2026-11-11T00:00:00Z') });
    expect(samples.map((s) => [s.jobId, s.positive]).sort()).toEqual([['ghosted', false], ['interviewed', true], ['rejected', false]]);
    expect(Object.keys(samples[0].breakdown).length).toBeGreaterThan(5);
    db.close();
  });
});
