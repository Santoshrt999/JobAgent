/**
 * People manager vs individual contributor (audit Backlog #2).
 * Seniority aliases put `manager` and `staff` on one rung, so "Principal Data
 * Engineering Manager" scored as a step up for a hands-on senior IC engineer.
 * Track is now a separate, penalty-only factor.
 */
import { describe, it, expect } from 'vitest';
import { scoreJob, isPeopleManagerTitle, candidateTracks } from '../../src/scoring/scorer.js';
import { loadTestConfig } from './helpers/testConfig.js';

const config = loadTestConfig();
const JD = 'We need Python, SQL, Spark, Airflow, dbt, Snowflake and AWS experience building data pipelines. '
  + 'You will own the data platform architecture and mentor engineers.';
const job = (title) => ({ id: title, title, company: 'Northwind', source: 'greenhouse', jdText: JD, location: 'Remote, US', postedAt: new Date().toISOString() });
const score = (title, candidate) => scoreJob(job(title), {
  scoring: config.scoring, sponsorship: { status: 'Likely' }, candidate: { ...config.candidate, ...candidate },
});

describe('the track classifier', () => {
  it('tells people-manager titles from IC ones, including IC "manager" titles', () => {
    for (const t of ['Principal Data Engineering Manager', 'Manager, Data Engineering', 'Director of Analytics', 'Head of Data', 'VP Engineering', 'Nurse Manager']) {
      expect(isPeopleManagerTitle(t), t).toBe(true);
    }
    for (const t of ['Senior Data Engineer', 'Lead Data Engineer', 'Staff Data Engineer', 'Product Manager', 'Project Manager', 'Account Manager', 'Data Product Manager', 'Case Management Nurse']) {
      expect(isPeopleManagerTitle(t), t).toBe(false);
    }
  });

  it('reads which tracks a search asks for', () => {
    expect(candidateTracks({ targetTitles: ['Senior Data Engineer'] })).toEqual({ ic: true, manager: false });
    expect(candidateTracks({ targetTitles: ['Data Engineering Manager'] })).toEqual({ ic: false, manager: true });
    expect(candidateTracks({ targetTitles: ['Senior Data Engineer', 'Data Engineering Manager'] })).toEqual({ ic: true, manager: true });
    expect(candidateTracks({})).toBeNull();
  });
});

describe('scoring by track', () => {
  const ic = { targetTitles: ['Senior Data Engineer', 'Lead Data Engineer'] };

  it('a people-manager posting scores well below the same IC posting for an IC search', () => {
    const manager = score('Principal Data Engineering Manager', ic);
    const engineer = score('Principal Data Engineer', ic);
    expect(manager.breakdown.trackFit.points).toBeLessThan(0);
    expect(engineer.breakdown.trackFit).toBeUndefined();
    expect(engineer.total - manager.total).toBeGreaterThanOrEqual(15);
  });

  it('no penalty when the search includes management, or states no titles', () => {
    expect(score('Data Engineering Manager', { targetTitles: ['Data Engineering Manager', 'Senior Data Engineer'] }).breakdown.trackFit).toBeUndefined();
    expect(score('Data Engineering Manager', { targetTitles: [] }).breakdown.trackFit).toBeUndefined();
  });

  it('a manager-only search is docked, more gently, for IC postings', () => {
    const r = score('Senior Data Engineer', { targetTitles: ['Data Engineering Manager'] });
    expect(r.breakdown.trackFit.points).toBeLessThan(0);
    expect(r.breakdown.trackFit.points).toBeGreaterThan(-20);
  });
});
