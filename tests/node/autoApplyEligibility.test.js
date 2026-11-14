import { describe, it, expect } from 'vitest';

import {
  evaluateAutoApplyEligibility, evaluateAutoApplyBatch,
  FIXTURE_VERIFIED_AUTO_APPLY_ATS,
} from '../../src/apply/autoApplyEligibility.js';

function eligible(overrides = {}) {
  return {
    job: {
      id: 'j1', company: 'Acme', title: 'Data Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
      source: 'greenhouse', sponsorship: 'Confirmed', status: 'prepared', applied: 0,
      ...overrides.job,
    },
    approval: { approval_status: 'pending_review' },
    packet: overrides.packet === null ? null : {
      id: 'p1', ats: { platform: 'greenhouse' }, blockers: [],
      resumePath: '/safe/tailored.docx', resumeWarning: null,
      prefill: { needsUser: [] }, screeningPlan: { needsUser: [] },
      uploads: { blockers: [] },
      ...(overrides.packet ?? {}),
    },
    autoSubmitAuthorized: overrides.autoSubmitAuthorized ?? true,
    // A supervised live run is on record for greenhouse (P1-11).
    liveVerifiedAts: overrides.liveVerifiedAts ?? ['greenhouse'],
  };
}

describe('Auto-Apply eligibility', () => {
  it('allows a reviewed, fixture-supported, sponsorship-safe packet', () => {
    const result = evaluateAutoApplyEligibility(eligible());
    expect(result.eligible).toBe(true);
    expect(result.ats).toBe('greenhouse');
    expect(result.warnings.join(' ')).toMatch(/approve this reviewed packet/);
  });

  it.each([
    ['already applied', { job: { applied: 1, status: 'submitted' } }, /duplicate/],
    ['submit unverified', { job: { status: 'submit_unverified' } }, /duplicate/],
    ['rejected', { job: { user_decision: 'rejected' } }, /rejected/],
    ['sponsorship unknown', { job: { sponsorship: 'Unconfirmed' } }, /verify compatibility/],
    ['unknown ATS', { job: { source: 'apify' }, packet: { ats: { platform: 'unknown' } } }, /supported contract/],
    ['missing packet', { packet: null }, /Prepare the application first/],
    ['missing resume', { packet: { resumePath: null } }, /does not contain a resume/],
    ['unanswered required question', { packet: { screeningPlan: { needsUser: [{ label: 'Salary expectation' }] } } }, /Salary expectation/],
    ['upload blocker', { packet: { uploads: { blockers: ['resume input missing'] } } }, /resume input missing/],
  ])('blocks %s before a browser opens', (_name, override, expected) => {
    const result = evaluateAutoApplyEligibility(eligible(override));
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(expected);
  });

  it('keeps explicit per-run authorization visible without hiding otherwise eligible jobs', () => {
    const result = evaluateAutoApplyEligibility(eligible({ autoSubmitAuthorized: false }));
    expect(result.eligible).toBe(true);
    expect(result.autoSubmitAuthorized).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/stop before Submit/);
  });

  it('does not block assisted fill when sponsorship is Unconfirmed', () => {
    const result = evaluateAutoApplyEligibility(eligible({
      job: { sponsorship: 'Unconfirmed' }, autoSubmitAuthorized: false,
    }));
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/verify compatibility before final submission/i);
    expect(result.nextAction).toMatch(/assisted fill/i);
  });

  it('summarizes a mixed batch and publishes the fixture-tested ATS list', () => {
    const preview = evaluateAutoApplyBatch({
      autoSubmitAuthorized: true, liveVerifiedAts: ['greenhouse'],
      items: [eligible(), eligible({ job: { id: 'j2', sponsorship: 'Unconfirmed' } })],
    });
    expect(preview).toMatchObject({ total: 2, eligible: 1, ineligible: 1 });
    expect(FIXTURE_VERIFIED_AUTO_APPLY_ATS).toEqual(expect.arrayContaining([
      'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters',
    ]));
  });

  it('refuses final Auto-submit on an ATS with no recorded live run (P1-11)', () => {
    const result = evaluateAutoApplyEligibility(eligible({ liveVerifiedAts: [] }));
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no recorded supervised live run/);
    expect(result.checks.find((c) => c.id === 'ats_live')).toMatchObject({ passed: false });
  });

  it('still allows assisted fill on an ATS with no live run, with a warning (P1-11)', () => {
    const result = evaluateAutoApplyEligibility(eligible({ liveVerifiedAts: [], autoSubmitAuthorized: false }));
    expect(result.eligible).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/no recorded supervised live run/);
  });

  it('a live run on one ATS does not cover another (P1-11)', () => {
    const result = evaluateAutoApplyEligibility(eligible({ liveVerifiedAts: ['lever'] }));
    expect(result.eligible).toBe(false);
  });
});
