import { describe, it, expect } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import {
  todayQueue, dashboardSections, dashboardStats, boardPage, BOARD_FIELDS, MAX_PAGE_LIMIT,
  classifyAttention, explainStatus, buildReports, buildDocuments, buildMasterResume, placeholderFixes,
} from '../../src/dashboard/data.js';

const NOW = new Date('2026-09-22T15:00:00.000Z');
const BANNER = '╔════════════════╗\n║ Executable doesn\'t exist at /x/chromium ║\n║ Please run: npx playwright install ║\n╚════════════════╝';

function seed(db) {
  const approval = (id, status) => db.insertApproval({ id: `ap-${id}`, job_id: id, approval_status: status });
  db.upsertJob({ id: 'unverified', title: 'U', status: 'submit_unverified', score: 60, tier: 'Queue' });
  db.upsertJob({ id: 'ready', title: 'R', status: 'ready_for_submit', score: 90, tier: 'Priority' });
  db.upsertJob({ id: 'question', title: 'Q', status: 'assist_blocked', score: 80, tier: 'Apply',
    assist_blockers: ['screening question needs user'] });
  db.upsertJob({ id: 'nobrowser', title: 'B', status: 'failed', score: 95, tier: 'Priority',
    assist_blockers: [`browser_unavailable: ${BANNER}`] });
  db.upsertJob({ id: 'nobrowser2', title: 'B2', status: 'assist_blocked', score: 94, tier: 'Priority',
    assist_blockers: [BANNER] });
  db.upsertJob({ id: 'review', title: 'V', status: 'prepared', score: 85, tier: 'Apply',
    application_packet_path: '/tmp/p.json' });
  approval('review', 'pending_review');
  db.upsertJob({ id: 'approved', title: 'A', status: 'prepared', score: 70, tier: 'Queue' });
  approval('approved', 'approved');
  db.upsertJob({ id: 'short', title: 'S', status: 'scored', score: 72, tier: 'Queue', user_decision: 'shortlisted' });
  db.upsertJob({ id: 'fresh', title: 'F', status: 'scored', score: 88, tier: 'Priority',
    posted_at: '2026-09-22T09:00:00.000Z' });
  db.upsertJob({ id: 'failed', title: 'X', status: 'failed', score: 50, tier: 'Queue', assist_blockers: ['timeout'] });
  db.upsertJob({ id: 'old', title: 'O', status: 'discarded', score: 10, tier: 'Discard' });
}

describe('A1 — GET /api/today contract (todayQueue)', () => {
  it('orders by urgency then score, excludes environment failures, and shapes items exactly', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const today = todayQueue(db, { now: NOW });
    expect(Object.keys(today).sort()).toEqual(['generatedAt', 'items', 'proposals', 'signInGroups', 'systemNotices']);
    expect(today.items.map((i) => i.id)).toEqual([
      'unverified', 'ready', 'question', 'review', 'approved', 'failed', 'short', 'fresh',
    ]);
    expect(today.items.map((i) => i.nextAction.kind)).toEqual([
      'review', 'submit', 'answer', 'approve', 'autofill', 'review', 'prepare', 'prepare',
    ]);
    for (const item of today.items) {
      expect(Object.keys(item).sort()).toEqual([
        'aging', 'appStatus', 'company', 'fit', 'followUp', 'grade', 'id', 'linkState', 'location', 'nextAction', 'postedAt',
        'reason', 'score', 'sponsorshipGated', 'statusLabel', 'tier', 'title',
      ]);
      expect(Object.keys(item.nextAction).sort()).toEqual(['kind', 'label']);
    }
    expect(today.systemNotices).toEqual([{
      code: 'browser_unavailable', severity: 'error',
      message: 'Auto-fill can’t start: the Playwright browser is not installed',
      fix: 'npx playwright install chromium',
    }]);
    db.close();
  });

  it('caps the list at 10 items', () => {
    const db = openDatabase({ path: ':memory:' });
    for (let i = 0; i < 15; i += 1) db.upsertJob({ id: `r${i}`, status: 'ready_for_submit', score: i });
    expect(todayQueue(db, { now: NOW }).items).toHaveLength(10);
    db.close();
  });

  it('reports template profile values as one notice', () => {
    const db = openDatabase({ path: ':memory:' });
    const config = { candidate: { identity: { fullName: 'Jane Doe' }, contact: { email: 'you@example.com' } } };
    const notices = todayQueue(db, { now: NOW, config }).systemNotices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'profile_placeholders', severity: 'error' });
    expect(notices[0].fix).toMatch(/profile/i);
    db.close();
  });

  it('says WHERE each template value is fixed, not just its name', () => {
    const db = openDatabase({ path: ':memory:' });
    const config = {
      profile: { id: 'casey' },
      candidate: {
        identity: { fullName: 'Casey Fixture' },
        workAuthorization: {
          status: 'US Citizen | Green Card | H-1B | OPT | ...',
          details: 'Describe your authorization truthfully — this is used verbatim in screening answers.',
        },
      },
      coverLetter: {
        yearsOfExperience: "YOUR total years of experience (e.g. '8 years')",
        includeSponsorshipNote: true,
        template: { sponsorshipNote: 'YOUR truthful sponsorship sentence, or set includeSponsorshipNote to false.' },
      },
    };
    const [notice] = todayQueue(db, { now: NOW, config }).systemNotices;
    const byLabel = Object.fromEntries(notice.items.map((i) => [i.label, i]));

    // candidate.json is regenerated on activation, so it is never the answer.
    expect(notice.items.every((i) => i.where !== 'config/candidate.json')).toBe(true);
    // Every one of these is fixed on a screen: the Saved answer it is filled from.
    expect(notice.items.every((i) => !/\.json$/.test(i.where))).toBe(true);
    expect(byLabel['work authorization status']).toMatchObject({
      where: 'Application profile → Saved answers', value: 'US Citizen | Green Card | H-1B | OPT | ...',
    });
    expect(byLabel['work authorization status'].how).toMatch(/"work_authorization"/);
    expect(byLabel['years of experience (used in the cover letter)'].how).toMatch(/"years_experience"/);
    expect(byLabel['cover-letter sponsorship sentence'].how).toMatch(/"work_authorization"/);
    db.close();
  });

  it('sends a form-editable field to the Application profile', () => {
    expect(placeholderFixes([{ path: 'contact.email', label: 'email', value: 'you@example.com', file: 'config/candidate.json' }]))
      .toEqual([expect.objectContaining({ where: 'Application profile' })]);
    expect(placeholderFixes([{ path: 'answers[id=x].answer', label: 'screening answer "x"', value: 'YOUR answer', file: 'config/screening_answers.json' }]))
      .toEqual([expect.objectContaining({ where: 'Application profile → Saved answers' })]);
  });
});

describe('browser_unavailable is a setup problem everywhere', () => {
  it('attention, status reason, sections and next actions all say so', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const job = db.getJob('nobrowser2');
    expect(classifyAttention(job, 'blocked')).toMatchObject({ kind: 'setup_browser', label: 'Setup: browser not installed' });
    expect(explainStatus(job, 'blocked')).not.toMatch(/[╔═║╚╗╝]/);
    const sections = dashboardSections(db, { now: NOW });
    expect(sections.todaysPriorities.map((r) => r.id)).not.toContain('nobrowser');
    expect(sections.todaysPriorities.map((r) => r.id)).not.toContain('nobrowser2');
    expect(sections.todaysPriorities.map((r) => r.id)).not.toContain('failed');
    expect(sections.blockedByReason.map((g) => g.reason)).toContain('Setup: browser not installed');
    const stats = dashboardStats(db, { now: NOW });
    expect(stats.totals.blockedSetup).toBe(2);
    const verbs = stats.nextActions.map((a) => a.verb);
    expect(verbs).toContain('Setup: browser not installed');
    const unblock = stats.nextActions.find((a) => a.verb === 'Unblock applications');
    expect(unblock.count).toBe(stats.totals.blocked - 2);
    db.close();
  });
});

describe('P3 — board projection, page clamp, narrow reports and documents', () => {
  it('fields=board returns only the table fields; default is unchanged', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const full = boardPage(db, { now: NOW });
    const slim = boardPage(db, { now: NOW, fields: 'board' });
    expect(slim.total).toBe(full.total);
    expect(Object.keys(slim.jobs[0]).sort()).toEqual([...BOARD_FIELDS].sort());
    expect(full.jobs[0]).toHaveProperty('explanation');
    expect(slim.jobs.find((j) => j.id === 'short').decision).toBe('shortlisted');
    db.close();
  });

  it('clamps limit to MAX_PAGE_LIMIT', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'x', status: 'scored', score: 1 });
    expect(boardPage(db, { now: NOW, limit: 100000 }).limit).toBe(MAX_PAGE_LIMIT);
    db.close();
  });

  it('reports still list every acted-on row, and documents / staleness read only rows with files', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    db.upsertJob({ id: 'sub', status: 'submitted', applied: 1, applied_at: '2026-09-22T12:00:00.000Z', score: 70 });
    db.upsertJob({ id: 'rej', status: 'discarded', user_decision: 'rejected', score: 30 });
    const reports = buildReports(db, { now: NOW });
    expect(reports.applicationLog.map((r) => r.id)).toEqual(expect.arrayContaining(['sub', 'rej', 'ready', 'question']));
    expect(reports.preparedPackets.map((r) => r.id).sort()).toEqual(['approved', 'review']);
    let calls = 0;
    const original = db.listJobsSummary.bind(db);
    db.listJobsSummary = (...a) => { calls += 1; return original(...a); };
    const docs = buildDocuments(db, { now: NOW, readFileImpl: () => '{}' });
    expect(docs.tailored.map((d) => d.jobId)).toEqual(['review']);
    buildMasterResume(db, { root: '/nonexistent', now: NOW, statImpl: () => ({ exists: true, bytes: 1, modifiedAt: NOW.toISOString() }),
      readFileImpl: () => Buffer.from(''), listDirImpl: () => [] });
    expect(calls).toBe(0);
    db.close();
  });
});

describe('Today reflects the machine as it is now, and is never empty beside good matches', () => {
  it('a live "browser installed" check turns old browser failures into retry work, not an install notice', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const today = todayQueue(db, { now: NOW, browserAvailable: true });
    expect(today.systemNotices.map((n) => n.code)).toEqual(['browser_recovered']);
    const retry = today.items.filter((i) => i.id === 'nobrowser' || i.id === 'nobrowser2');
    expect(retry.map((i) => i.nextAction.kind)).toEqual(['autofill', 'autofill']);
    db.close();
  });

  it('a live "browser missing" check raises the install notice even with no failure rows', () => {
    const db = openDatabase({ path: ':memory:' });
    const today = todayQueue(db, { now: NOW, browserAvailable: false });
    expect(today.systemNotices.map((n) => n.code)).toEqual(['browser_unavailable']);
    db.close();
  });

  it('tops up a quiet day with the best undecided fits, strongest first', () => {
    const db = openDatabase({ path: ':memory:' });
    // Old posting dates: none qualifies as "new strong fit in the last 24 h".
    for (const [id, score, tier] of [['s1', 91, 'Priority'], ['s2', 86, 'Apply'], ['m1', 62, 'Queue']]) {
      db.upsertJob({ id, title: id, status: 'scored', score, tier, posted_at: '2026-09-01T00:00:00.000Z' });
    }
    db.upsertJob({ id: 'decided', title: 'd', status: 'scored', score: 95, tier: 'Priority',
      posted_at: '2026-09-01T00:00:00.000Z', user_decision: 'rejected' });
    const items = todayQueue(db, { now: NOW, browserAvailable: true }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.id)).not.toContain('decided');
    const scores = items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const item of items) expect(item.reason).toMatch(/score \d+/);
    db.close();
  });
});

describe('browser-failure labels follow the live check, not the history', () => {
  it('relabels old "browser not installed" rows as retryable once the browser is present', async () => {
    const data = await import('../../src/dashboard/data.js');
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    try {
      data.setBrowserAvailability(true);
      const blocked = data.classifyAttention({ assist_blockers: JSON.stringify([`browser_unavailable: ${BANNER}`]) }, "failed");
      expect(blocked).toMatchObject({ kind: 'retry', label: data.SETUP_BROWSER_RECOVERED_LABEL });
      data.setBrowserAvailability(null);
      const unknown = data.classifyAttention({ assist_blockers: JSON.stringify([`browser_unavailable: ${BANNER}`]) }, "failed");
      expect(unknown).toMatchObject({ kind: 'setup_browser' });
    } finally {
      data.setBrowserAvailability(null);
      db.close();
    }
  });
});

describe('E4 — Today discloses the age of in-flight work on an old posting', () => {
  const config = { exclusions: { staleness: { skipOlderThanDays: 45 } } };

  it('warns when a prepared packet targets a posting past retention, and says whether it is confirmed open', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'oldpkt', title: 'O', status: 'prepared', score: 75, tier: 'Queue',
      application_packet_path: '/tmp/o.json', posted_at: '2026-07-20T00:00:00.000Z' });
    db.insertApproval({ id: 'ap-oldpkt', job_id: 'oldpkt', approval_status: 'pending_review' });
    db.upsertJob({ id: 'oldopen', title: 'P', status: 'scored', score: 72, tier: 'Queue', user_decision: 'shortlisted',
      posted_at: '2026-07-20T00:00:00.000Z', link_state: 'open', link_checked_at: NOW.toISOString() });
    db.upsertJob({ id: 'recent', title: 'R', status: 'scored', score: 71, tier: 'Queue', user_decision: 'shortlisted',
      posted_at: '2026-09-15T00:00:00.000Z' });
    const items = Object.fromEntries(todayQueue(db, { now: NOW, config }).items.map((i) => [i.id, i]));
    expect(items.oldpkt.reason).toMatch(/Posted 64 days ago and not confirmed open/);
    expect(items.oldpkt.reason).toMatch(/^Its tailored resume/);
    expect(items.oldopen.reason).toMatch(/Posted 64 days ago; the employer still lists it\./);
    expect(items.recent.reason).not.toMatch(/Posted \d+ days ago/);
    db.close();
  });
});
