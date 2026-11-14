/**
 * The dashboard says when its server is older than the code on disk, so an
 * update is never silently half-applied (new page, old Auto-fill).
 */
import { describe, expect, it } from 'vitest';

import { createCodeFreshness, newestServerCode, restartNotice } from '../../src/dashboard/codeFreshness.js';
import { startTestDashboard } from './helpers/dashboardPage.js';

describe('createCodeFreshness', () => {
  it('reports a change made after start, and caches the folder walk', () => {
    let scans = 0;
    let clock = 10_000;
    let mtime = 5_000;
    const check = createCodeFreshness({
      startedAt: 8_000, ttlMs: 1_000, now: () => clock,
      scan: () => { scans += 1; return { mtimeMs: mtime, file: 'automation/navigator.js' }; },
    });
    expect(check()).toBeNull();
    mtime = 20_000;
    expect(check()).toBeNull(); // cached
    expect(scans).toBe(1);
    clock += 1_000;
    expect(check()).toEqual({ changedAt: new Date(20_000).toISOString(), file: 'automation/navigator.js' });
  });

  it('allows files written while the server was starting', () => {
    const check = createCodeFreshness({ startedAt: 8_000, scan: () => ({ mtimeMs: 8_900, file: 'x.js' }) });
    expect(check()).toBeNull();
  });

  it('walks the real source tree but not the live-served page files', () => {
    const newest = newestServerCode();
    expect(newest?.file).toMatch(/\.m?js$/);
    expect(newest.file.replace(/\\/g, '/')).not.toMatch(/^dashboard\/public\//);
  });

  it('words the notice as a restart with a copyable command', () => {
    expect(restartNotice(null)).toBeNull();
    expect(restartNotice({ changedAt: 'x', file: 'y' })).toMatchObject({
      code: 'restart_needed', severity: 'warn', fix: expect.stringContaining('`npm run app`'),
    });
  });
});

describe('/api/today', () => {
  it('puts the restart notice first while the server is behind', async () => {
    const dash = await startTestDashboard({
      deps: { codeFreshness: () => ({ changedAt: '2026-11-12T01:00:00.000Z', file: 'automation/navigator.js' }) },
    });
    try {
      const res = await fetch(`${dash.url}/api/today`);
      const body = await res.json();
      expect(body.systemNotices[0].code).toBe('restart_needed');
    } finally {
      await dash.stop();
    }
  }, 30_000);

  it('says nothing when it is current', async () => {
    const dash = await startTestDashboard({ deps: { codeFreshness: () => null } });
    try {
      const body = await (await fetch(`${dash.url}/api/today`)).json();
      expect((body.systemNotices ?? []).map((n) => n.code)).not.toContain('restart_needed');
    } finally {
      await dash.stop();
    }
  }, 30_000);
});
