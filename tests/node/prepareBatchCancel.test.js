/**
 * Cancelling "Prepare" on a batch (audit BUG-07). Jobs the person stopped
 * before they started showed red "failed" badges, and any job the helper
 * reported in no list was assumed "prepared".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { preparePacketsForJobs } from '../../src/cli/commands.js';

let db; let dash;
afterEach(async () => { await dash?.close(); db?.close(); });

const statusOf = async () => (await fetch(`${dash.url}/api/run/status`)).json();
const settle = async () => {
  for (let i = 0; i < 50; i += 1) { if (!(await statusOf()).running) return; await new Promise((r) => setTimeout(r, 10)); }
};

describe('a cancelled prepare batch', () => {
  it('the helper reports jobs it never started as cancelled, not failed', async () => {
    db = openDatabase({ path: ':memory:' });
    const r = await preparePacketsForJobs({ config: {}, db, logger: null, jobIds: ['a', 'b'], deps: { shouldCancel: () => true } });
    expect(r.failed).toEqual([]);
    expect(r.cancelled.map((c) => c.jobId)).toEqual(['a', 'b']);
  });

  it('labels every item from an explicit outcome', async () => {
    db = openDatabase({ path: ':memory:' });
    for (const id of ['j1', 'j2', 'j3', 'j4']) db.upsertJob({ id, title: 'Data Engineer', company: 'Northwind', status: 'scored', score: 80 });
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        prepareForJobsFn: async () => ({
          prepared: [{ jobId: 'j1', packetPath: '/p/j1.json' }],
          failed: [{ jobId: 'j2', error: 'tailoring failed' }],
          cancelled: [{ jobId: 'j3', reason: 'cancelled before this job started' }],
          // j4: in no list at all
        }),
      },
    });
    const started = await fetch(`${dash.url}/api/prepare-batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobIds: ['j1', 'j2', 'j3', 'j4'] }),
    });
    expect(started.status).toBe(202);
    await settle();
    const items = Object.fromEntries((await statusOf()).progress.items.map((i) => [i.jobId, i.status]));
    expect(items).toEqual({ j1: 'prepared', j2: 'failed', j3: 'cancelled', j4: 'skipped' });
  });
});
