/**
 * P1B-2 — the Applications workspace: stages, recruiting outcomes, follow-ups
 * and the numbers they add up to. Every database here is in-memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import {
  applicationsWorkspace, applicationSummary, recordOutcome, undoOutcome, updateFollowUp, todayQueue, jobDetail,
} from '../../src/dashboard/data.js';
import {
  OUTCOME_EVENT, FOLLOWUP_EVENT, WORKSPACE_STAGES, canRecordOutcome, allowedOutcomes, replayOutcomes,
  replayFollowUps, stageOf, applicationMetrics, isIsoDay, daysBetween, AWAITING_RESPONSE_DAYS,
} from '../../src/domain/applicationOutcome.js';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const TODAY = '2026-10-20';

const ev = (type, metadata, at) => ({ event_type: type, metadata: JSON.stringify(metadata), created_at: at });

/** One job per workspace stage, plus rows that must stay OUT of it. */
function seed(db) {
  const approval = (id, status) => db.insertApproval({ id: `ap-${id}`, job_id: id, approval_status: status });
  db.upsertJob({ id: 'review', company: 'Acme', title: 'Nurse Manager', status: 'prepared', score: 85, tier: 'Apply' });
  approval('review', 'pending_review');
  db.upsertJob({ id: 'approved', company: 'Globex', title: 'Accountant', status: 'prepared', score: 70, tier: 'Queue' });
  approval('approved', 'approved');
  db.upsertJob({ id: 'filled', company: 'Initech', title: 'Teacher', status: 'ready_for_submit', score: 80, tier: 'Apply' });
  db.upsertJob({ id: 'blocked', company: 'Umbrella', title: 'Paralegal', status: 'assist_blocked', score: 75, tier: 'Apply',
    assist_blockers: ['screening question needs user'] });
  db.upsertJob({ id: 'unverified', company: 'Hooli', title: 'Designer', status: 'submit_unverified', score: 60, tier: 'Queue' });
  db.upsertJob({ id: 'sub1', company: 'Acme, Inc.', title: 'Charge Nurse', status: 'submitted', applied: 1,
    applied_at: '2026-10-01T16:00:00.000Z', score: 88, tier: 'Priority' });
  db.upsertJob({ id: 'sub2', company: 'acme inc', title: 'Clinical Educator', status: 'submitted', applied: 1,
    applied_at: '2026-10-15T16:00:00.000Z', score: 77, tier: 'Apply' });
  // Found by an ad-hoc role search: still the user's application.
  db.upsertJob({ id: 'sub3', company: 'Stark', title: 'Electrician', status: 'submitted', applied: 1,
    applied_at: '2026-10-19T16:00:00.000Z', score: 66, tier: 'Queue', discovery_mode: 'role_search', search_query: 'electrician' });
  // Not applications.
  db.upsertJob({ id: 'scored', company: 'X', title: 'Scored', status: 'scored', score: 90, tier: 'Priority' });
  db.upsertJob({ id: 'short', company: 'Y', title: 'Shortlisted', status: 'scored', score: 70, tier: 'Queue', user_decision: 'shortlisted' });
  db.upsertJob({ id: 'gone', company: 'Z', title: 'Discarded', status: 'discarded', score: 10, tier: 'Discard' });
  db.upsertJob({ id: 'nope', company: 'W', title: 'Rejected prepared', status: 'prepared', score: 60, tier: 'Queue', user_decision: 'rejected' });
}

let db;
beforeEach(() => { db = openDatabase({ path: ':memory:' }); db.onWarning = () => {}; seed(db); });
afterEach(() => db.close());

const byId = (ws) => Object.fromEntries(ws.items.map((i) => [i.id, i]));
const at = (iso) => new Date(iso);

describe('outcome graph (canRecordOutcome)', () => {
  it('moves forward, may skip a stage, and exits from anywhere not final', () => {
    expect(canRecordOutcome(null, 'interviewing')).toBe(true);
    expect(canRecordOutcome('applied', 'hired')).toBe(true);
    expect(canRecordOutcome('interviewing', 'offer')).toBe(true);
    expect(canRecordOutcome('offer', 'withdrawn')).toBe(true);
    expect(canRecordOutcome('interviewing', 'rejected')).toBe(true);
  });

  it('refuses backward moves, repeats, moves out of a final outcome, and unknown values', () => {
    expect(canRecordOutcome('interviewing', 'applied')).toBe(false);
    expect(canRecordOutcome('offer', 'interviewing')).toBe(false);
    expect(canRecordOutcome('interviewing', 'interviewing')).toBe(false);
    expect(canRecordOutcome(null, 'applied')).toBe(false);
    for (const final of ['hired', 'rejected', 'withdrawn']) {
      expect(allowedOutcomes(final)).toEqual([]);
    }
    expect(canRecordOutcome(null, 'ghosted')).toBe(false);
  });

  it('lists the allowed next outcomes in process order', () => {
    expect(allowedOutcomes(null)).toEqual(['interviewing', 'offer', 'hired', 'rejected', 'withdrawn']);
    expect(allowedOutcomes('offer')).toEqual(['hired', 'rejected', 'withdrawn']);
  });
});

describe('replay', () => {
  it('pops an undone outcome, so a mis-click never counts as an interview', () => {
    const r = replayOutcomes([
      ev(OUTCOME_EVENT, { outcome: 'offer', on: '2026-10-02' }, '1'),
      ev(OUTCOME_EVENT, { undo: true }, '2'),
    ]);
    expect(r.current).toBeNull();
    expect(r.reached).toBe('applied');
  });

  it('keeps the furthest stage reached after an exit, and skips unreadable rows', () => {
    const r = replayOutcomes([
      ev(OUTCOME_EVENT, { outcome: 'interviewing', on: '2026-10-05', note: 'phone screen' }, '1'),
      { event_type: OUTCOME_EVENT, metadata: '{not json', created_at: '2' },
      ev(OUTCOME_EVENT, { outcome: 'bogus' }, '3'),
      ev(OUTCOME_EVENT, { outcome: 'rejected', on: '2026-10-09' }, '4'),
    ]);
    expect(r.current).toMatchObject({ outcome: 'rejected', label: 'Rejected by employer', on: '2026-10-09' });
    expect(r.reached).toBe('interviewing');
    expect(r.history.map((h) => h.outcome)).toEqual(['interviewing', 'rejected']);
    expect(r.history[0].note).toBe('phone screen');
  });

  it('keeps the latest reminder open until it is done or dismissed', () => {
    expect(replayFollowUps([ev(FOLLOWUP_EVENT, { action: 'set', dueOn: '2026-10-25' }, '1')]).open)
      .toMatchObject({ dueOn: '2026-10-25' });
    expect(replayFollowUps([
      ev(FOLLOWUP_EVENT, { action: 'set', dueOn: '2026-10-25' }, '1'),
      ev(FOLLOWUP_EVENT, { action: 'set', dueOn: '2026-10-28', note: 'email the recruiter' }, '2'),
    ]).open).toMatchObject({ dueOn: '2026-10-28', note: 'email the recruiter' });
    const closed = replayFollowUps([
      ev(FOLLOWUP_EVENT, { action: 'set', dueOn: '2026-10-25' }, '1'),
      ev(FOLLOWUP_EVENT, { action: 'dismissed' }, '2'),
    ]);
    expect(closed.open).toBeNull();
    expect(closed.last.action).toBe('dismissed');
  });

  it('validates calendar days', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('10/20/2026')).toBe(false);
    expect(daysBetween('2026-10-01', '2026-10-20')).toBe(19);
  });
});

describe('stageOf', () => {
  it('maps automation statuses to the first three columns and outcomes to the rest', () => {
    expect(stageOf('needs_review')).toBe('review');
    expect(stageOf('approved')).toBe('ready');
    expect(stageOf('ready_for_submit')).toBe('ready');
    for (const s of ['blocked', 'failed', 'cancelled', 'submit_unverified']) expect(stageOf(s)).toBe('attention');
    expect(stageOf('submitted')).toBe('applied');
    expect(stageOf('submitted', 'interviewing')).toBe('interviewing');
    expect(stageOf('submitted', 'offer')).toBe('offer');
    for (const o of ['hired', 'rejected', 'withdrawn']) expect(stageOf('submitted', o)).toBe('closed');
  });

  it('keeps triage and closed rows out of the workspace', () => {
    for (const s of ['scored', 'discovered', 'shortlisted', 'rejected', 'archived', 'discarded', 'skipped']) {
      expect(stageOf(s)).toBeNull();
    }
  });
});

describe('applicationsWorkspace', () => {
  it('puts every application in its column, including one found by a role search, and nothing else', () => {
    const ws = applicationsWorkspace(db, { now: NOW });
    expect(ws.stages.map((s) => s.key)).toEqual(WORKSPACE_STAGES.map((s) => s.key));
    expect(ws.today).toBe(TODAY);
    const items = byId(ws);
    expect(Object.keys(items).sort()).toEqual(['approved', 'blocked', 'filled', 'review', 'sub1', 'sub2', 'sub3', 'unverified']);
    expect(items.review.stage).toBe('review');
    expect(items.approved.stage).toBe('ready');
    expect(items.filled.stage).toBe('ready');
    expect(items.blocked.stage).toBe('attention');
    expect(items.unverified.stage).toBe('attention');
    expect(items.sub3.stage).toBe('applied');
  });

  it('never offers approve or submit as a card action — approval starts from reading the resume', () => {
    const items = byId(applicationsWorkspace(db, { now: NOW }));
    expect(items.review.nextAction).toEqual({ kind: 'review', label: 'Review resume' });
    for (const item of Object.values(items)) expect(item.nextAction?.kind).not.toBe('approve');
    expect(items.filled.nextAction.kind).toBe('submit'); // opens the human "I submitted it" record
    expect(items.sub1.nextAction).toEqual({ kind: 'outcome', label: 'Record a response' });
  });

  it('flags applications waiting on a response and counts other applications at the same employer', () => {
    const items = byId(applicationsWorkspace(db, { now: NOW }));
    expect(items.sub1.awaitingDays).toBe(19);
    expect(items.sub1.awaitingDays).toBeGreaterThanOrEqual(AWAITING_RESPONSE_DAYS);
    expect(items.sub2.awaitingDays).toBe(5);
    // "Acme", "Acme, Inc." and "acme inc" are one employer: three applications.
    expect(items.sub1.sameCompany).toBe(2);
    expect(items.sub2.sameCompany).toBe(2);
    expect(items.review.sameCompany).toBe(2);
    expect(items.sub3.sameCompany).toBe(0);
  });

  it('reports metrics only from what was recorded', () => {
    const { metrics } = applicationsWorkspace(db, { now: NOW });
    expect(metrics).toMatchObject({ submitted: 3, interviews: 0, offers: 0, followUpsDue: 0, awaiting: 1 });
    expect(metrics.byStage).toMatchObject({ review: 1, ready: 2, attention: 2, applied: 3, interviewing: 0 });
    expect(metrics.rates.interview).toEqual({ n: 0, of: 3, pct: 0 });
    expect(metrics.rates.offer).toEqual({ n: 0, of: 0, pct: null }); // no interviews: no rate, not "0%"
  });
});

describe('recordOutcome', () => {
  const snapshot = (id) => {
    const j = db.getJob(id);
    return { status: j.status, applied: j.applied, applied_at: j.applied_at, user_decision: j.user_decision, notes: j.notes };
  };

  it('records interview then rejection as events, without touching the job row', () => {
    const before = snapshot('sub1');
    const a = recordOutcome(db, 'sub1', { outcome: 'interviewing', on: '2026-10-08', note: 'Panel interview', now: NOW });
    expect(a).toMatchObject({ stage: 'interviewing', outcome: { outcome: 'interviewing', on: '2026-10-08', note: 'Panel interview' } });
    const b = recordOutcome(db, 'sub1', { outcome: 'rejected', now: NOW });
    expect(b.stage).toBe('closed');
    expect(b.outcome.on).toBe(TODAY); // defaults to the user's today
    expect(b.reached).toBe('interviewing');
    expect(b.outcomeHistory.map((h) => h.outcome)).toEqual(['interviewing', 'rejected']);
    expect(snapshot('sub1')).toEqual(before);
    const events = db.listEvents('sub1').filter((e) => e.event_type === OUTCOME_EVENT);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1].metadata)).toMatchObject({ outcome: 'rejected', previous: 'interviewing' });
    const { metrics } = applicationsWorkspace(db, { now: NOW });
    expect(metrics).toMatchObject({ interviews: 1, rejected: 1, offers: 0 });
    expect(metrics.rates.interview).toEqual({ n: 1, of: 3, pct: 33 });
  });

  it('refuses an outcome on a job that was never submitted, and changes nothing', () => {
    for (const id of ['review', 'approved', 'filled', 'unverified', 'scored']) {
      const before = snapshot(id);
      expect(() => recordOutcome(db, id, { outcome: 'interviewing', now: NOW })).toThrow(/submitted/);
      try { recordOutcome(db, id, { outcome: 'interviewing', now: NOW }); } catch (err) { expect(err.statusCode).toBe(409); }
      expect(snapshot(id)).toEqual(before);
      expect(db.listEvents(id).filter((e) => e.event_type === OUTCOME_EVENT)).toHaveLength(0);
    }
  });

  it('validates outcome, date and the move itself', () => {
    const code = (fn) => { try { fn(); } catch (err) { return err.statusCode; } return 200; };
    expect(code(() => recordOutcome(db, 'missing', { outcome: 'offer', now: NOW }))).toBe(404);
    expect(code(() => recordOutcome(db, 'sub1', { outcome: 'ghosted', now: NOW }))).toBe(400);
    expect(code(() => recordOutcome(db, 'sub1', { outcome: 'offer', on: '2026-13-01', now: NOW }))).toBe(400);
    expect(code(() => recordOutcome(db, 'sub1', { outcome: 'offer', on: '2026-10-21', now: NOW }))).toBe(400);
    expect(code(() => recordOutcome(db, 'sub1', { outcome: 'offer', note: { x: 1 }, now: NOW }))).toBe(400);
    expect(code(() => recordOutcome(db, 'sub1', { outcome: 'applied', now: NOW }))).toBe(409);
    recordOutcome(db, 'sub1', { outcome: 'hired', now: NOW });
    expect(code(() => recordOutcome(db, 'sub1', { outcome: 'withdrawn', now: NOW }))).toBe(409);
    expect(() => recordOutcome(db, 'sub1', { outcome: 'withdrawn', now: NOW })).toThrow(/Undo the last outcome/);
  });

  it('keeps each application to the same employer independent', () => {
    recordOutcome(db, 'sub1', { outcome: 'rejected', now: NOW });
    recordOutcome(db, 'sub2', { outcome: 'interviewing', now: NOW });
    const items = byId(applicationsWorkspace(db, { now: NOW }));
    expect(items.sub1.stage).toBe('closed');
    expect(items.sub2.stage).toBe('interviewing');
    expect(items.sub1.sameCompany).toBe(2);
  });

  it('undo appends a reversal, one step at a time, and keeps the audit trail', () => {
    recordOutcome(db, 'sub1', { outcome: 'interviewing', now: NOW });
    recordOutcome(db, 'sub1', { outcome: 'offer', now: NOW });
    expect(undoOutcome(db, 'sub1', { now: NOW }).stage).toBe('interviewing');
    const back = undoOutcome(db, 'sub1', { now: NOW });
    expect(back.stage).toBe('applied');
    expect(back.canUndoOutcome).toBe(false);
    expect(() => undoOutcome(db, 'sub1', { now: NOW })).toThrow(/no recorded outcome/);
    expect(db.listEvents('sub1').filter((e) => e.event_type === OUTCOME_EVENT)).toHaveLength(4);
  });
});

describe('follow-ups', () => {
  it('sets a reminder that is not due until its day, then shows it on Today', () => {
    const set = updateFollowUp(db, 'sub2', { action: 'set', dueOn: '2026-10-27', note: 'Email the hiring manager', now: NOW });
    expect(set.followUp).toMatchObject({ dueOn: '2026-10-27', due: false, note: 'Email the hiring manager' });
    expect(todayQueue(db, { now: NOW }).items.some((i) => i.id === 'sub2')).toBe(false);

    const later = at('2026-10-29T15:00:00.000Z');
    const item = todayQueue(db, { now: later }).items.find((i) => i.id === 'sub2');
    expect(item.nextAction).toEqual({ kind: 'followup', label: 'Follow up' });
    expect(item.followUp).toMatchObject({ dueOn: '2026-10-27', due: true, daysLate: 2 });
    expect(item.reason).toBe('Applied 14 days ago · reminder was due 2 days ago. Email the hiring manager');
    expect(applicationsWorkspace(db, { now: later }).metrics.followUpsDue).toBe(1);
  });

  it('ranks a due follow-up after blocked work and before resumes to review', () => {
    updateFollowUp(db, 'sub1', { action: 'set', dueOn: '2026-10-20', now: NOW });
    const ids = todayQueue(db, { now: NOW }).items.map((i) => i.id);
    expect(ids.indexOf('sub1')).toBeGreaterThan(ids.indexOf('blocked'));
    expect(ids.indexOf('sub1')).toBeLessThan(ids.indexOf('review'));
    expect(ids.filter((id) => id === 'sub1')).toHaveLength(1);
  });

  it('completes and dismisses, and refuses when nothing is open or the job was not submitted', () => {
    const code = (fn) => { try { fn(); } catch (err) { return err.statusCode; } return 200; };
    expect(code(() => updateFollowUp(db, 'sub1', { action: 'done', now: NOW }))).toBe(409);
    expect(code(() => updateFollowUp(db, 'filled', { action: 'set', dueOn: TODAY, now: NOW }))).toBe(409);
    expect(code(() => updateFollowUp(db, 'sub1', { action: 'snooze', now: NOW }))).toBe(400);
    expect(code(() => updateFollowUp(db, 'sub1', { action: 'set', dueOn: 'tomorrow', now: NOW }))).toBe(400);
    expect(code(() => updateFollowUp(db, 'sub1', { action: 'set', dueOn: '2028-01-01', now: NOW }))).toBe(400);
    updateFollowUp(db, 'sub1', { action: 'set', dueOn: TODAY, now: NOW });
    expect(updateFollowUp(db, 'sub1', { action: 'done', now: NOW }).followUp).toBeNull();
    updateFollowUp(db, 'sub1', { action: 'set', dueOn: TODAY, now: NOW });
    const dismissed = updateFollowUp(db, 'sub1', { action: 'dismissed', now: NOW });
    expect(dismissed.followUp).toBeNull();
    expect(dismissed.lastFollowUp.action).toBe('dismissed');
    expect(todayQueue(db, { now: NOW }).items.some((i) => i.id === 'sub1')).toBe(false);
  });

  it('hides a reminder once the application is closed, and brings it back on undo', () => {
    updateFollowUp(db, 'sub1', { action: 'set', dueOn: TODAY, now: NOW });
    expect(recordOutcome(db, 'sub1', { outcome: 'withdrawn', now: NOW }).followUp).toBeNull();
    expect(todayQueue(db, { now: NOW }).items.some((i) => i.id === 'sub1')).toBe(false);
    expect(undoOutcome(db, 'sub1', { now: NOW }).followUp).toMatchObject({ dueOn: TODAY, due: true });
  });

  it('decides "due" on the user\'s own calendar day', () => {
    // 02:00 UTC on the 21st is still the 20th in Los Angeles.
    const lateEvening = at('2026-10-21T02:00:00.000Z');
    updateFollowUp(db, 'sub1', { action: 'set', dueOn: '2026-10-21', now: NOW });
    const config = { candidate: { location: { timezone: 'America/Los_Angeles' } } };
    expect(applicationSummary(db, 'sub1', { now: lateEvening, config }).followUp.due).toBe(false);
    expect(applicationSummary(db, 'sub1', { now: lateEvening }).followUp.due).toBe(true);
  });
});

describe('job detail', () => {
  it('carries the workspace card with history for an application, and null otherwise', () => {
    recordOutcome(db, 'sub1', { outcome: 'interviewing', now: NOW });
    expect(jobDetail(db, 'sub1', { now: NOW }).application).toMatchObject({
      stage: 'interviewing', outcomeHistory: [{ outcome: 'interviewing' }], allowedOutcomes: ['offer', 'hired', 'rejected', 'withdrawn'],
    });
    expect(jobDetail(db, 'scored', { now: NOW }).application).toBeNull();
  });
});

describe('metrics edge cases', () => {
  it('counts an offer that became a hire as an interview and an offer', () => {
    const m = applicationMetrics([
      { stage: 'closed', appStatus: 'submitted', reached: 'hired', outcome: { outcome: 'hired' } },
      { stage: 'applied', appStatus: 'submitted', reached: 'applied', awaitingDays: 20, followUp: { due: true } },
      { stage: 'review', appStatus: 'needs_review' },
    ]);
    expect(m).toMatchObject({ submitted: 2, interviews: 1, offers: 1, hired: 1, awaiting: 1, followUpsDue: 1 });
    expect(m.rates.offer).toEqual({ n: 1, of: 1, pct: 100 });
  });
});

describe('HTTP API', () => {
  let dash;
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps: { extensionKey: 'k'.repeat(32), now: () => NOW } });
  });
  afterEach(async () => { await dash.close(); });

  it('serves the workspace and records outcomes and follow-ups', async () => {
    const ws = await get('/api/applications');
    expect(ws.status).toBe(200);
    expect(Object.keys(ws.body).sort()).toEqual(['conversion', 'generatedAt', 'items', 'metrics', 'signInGroups', 'stages', 'today', 'weekly']);

    const ok = await post('/api/jobs/sub1/outcome', { outcome: 'interviewing', on: '2026-10-10' });
    expect(ok.status).toBe(200);
    expect(ok.body.stage).toBe('interviewing');
    expect((await post('/api/jobs/review/outcome', { outcome: 'interviewing' })).status).toBe(409);
    expect((await post('/api/jobs/sub1/outcome', { outcome: 'applied' })).status).toBe(409);
    expect((await post('/api/jobs/sub1/undo-outcome')).body.stage).toBe('applied');

    const fu = await post('/api/jobs/sub1/follow-up', { action: 'set', dueOn: '2026-10-20' });
    expect(fu.body.followUp.due).toBe(true);
    expect((await get('/api/today')).body.items.find((i) => i.id === 'sub1').nextAction.kind).toBe('followup');
    expect((await post('/api/jobs/sub1/follow-up', { action: 'done' })).body.followUp).toBeNull();
    expect((await get('/api/jobs/sub1')).body.application.lastFollowUp.action).toBe('done');
  });
});
