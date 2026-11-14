/** Auto-fill readiness and "sign in once" grouping (audit Backlog #1, #5). Fictional employers. */
import { describe, it, expect } from 'vitest';
import { applicationAccess, openQuestionsFor, portalHost, signInGroups } from '../../src/apply/autofillReadiness.js';
import { openDatabase } from '../../src/logging/db.js';
import { applicationsWorkspace, todayQueue } from '../../src/dashboard/data.js';

describe('application access', () => {
  it('tells account-free systems from employer portals', () => {
    expect(applicationAccess({ atsPlatform: 'greenhouse' }).kind).toBe('instant');
    expect(applicationAccess({ source: 'lever' }).kind).toBe('instant');
    expect(applicationAccess({ source: 'workday' }).kind).toBe('portal');
    expect(applicationAccess({ atsPlatform: 'generic', url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/1' }).kind).toBe('portal');
    expect(applicationAccess({ url: 'https://careers.example.com/1' }).kind).toBe('unknown');
  });
});

describe('sign-in groups', () => {
  const blocked = (id, url, company) => ({ id, url, company, attention: { kind: 'sign_in' } });
  it('groups jobs stopped at sign-in by portal, largest first, and ignores other blockers', () => {
    const groups = signInGroups([
      blocked('a', 'https://northwind.wd1.myworkdayjobs.com/x/1', 'Northwind'),
      blocked('b', 'https://northwind.wd1.myworkdayjobs.com/x/2', 'Northwind'),
      blocked('c', 'https://contoso.wd5.myworkdayjobs.com/y/1', 'Contoso'),
      { id: 'd', url: 'https://northwind.wd1.myworkdayjobs.com/x/3', company: 'Northwind', attention: { kind: 'question' } },
      blocked('e', 'not a url', 'Nobody'),
    ]);
    expect(groups.map((g) => [g.host, g.count, g.ids])).toEqual([
      ['northwind.wd1.myworkdayjobs.com', 2, ['a', 'b']],
      ['contoso.wd5.myworkdayjobs.com', 1, ['c']],
    ]);
    expect(groups[0].company).toBe('Northwind');
    expect(portalHost('https://A.example.com/x')).toBe('a.example.com');
  });

  it('flows through the Applications workspace and Today', () => {
    const db = openDatabase({ path: ':memory:' });
    for (const id of ['w1', 'w2']) {
      db.upsertJob({ id, title: 'Data Engineer', company: 'Northwind', source: 'workday', url: `https://northwind.wd1.myworkdayjobs.com/x/${id}`,
        status: 'assist_blocked', score: 80, tier: 'Apply', assist_blockers: JSON.stringify(['login wall: sign in required']) });
    }
    const groups = applicationsWorkspace(db, { now: new Date() }).signInGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(todayQueue(db, { now: new Date() }).signInGroups[0].ids.sort()).toEqual(['w1', 'w2']);
    db.close();
  });
});

describe('open questions for a job', () => {
  it('lists only open questions seen on that job', () => {
    const queue = { questions: [
      { key: 'a', label: 'Clearance?', status: 'open', jobs: [{ jobId: 'j1' }] },
      { key: 'b', label: 'Relocate?', status: 'answered', jobs: [{ jobId: 'j1' }] },
      { key: 'c', label: 'Visa?', status: 'open', jobs: [{ jobId: 'j2' }] },
    ] };
    expect(openQuestionsFor(queue, 'j1')).toEqual([{ key: 'a', label: 'Clearance?' }]);
    expect(openQuestionsFor(null, 'j1')).toEqual([]);
  });
});
