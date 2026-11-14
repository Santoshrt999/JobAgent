/**
 * LLM usage totals (P3-5) and follow-up alerts (P3-3).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { summarizeUsage } from '../../src/llm/usage.js';
import { alertDueFollowUps, dueAlerts } from '../../src/reports/followUpAlerts.js';

describe('LLM usage totals (P3-5)', () => {
  it('sums per task and model within the window, skipping bad lines', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const lines = [
      JSON.stringify({ at: '2026-11-10T00:00:00Z', task: 'jd-requirements@2', provider: 'openai', model: 'm', inputTokens: 100, outputTokens: 20, cached: false }),
      JSON.stringify({ at: '2026-11-10T01:00:00Z', task: 'jd-requirements@2', provider: 'openai', model: 'm', inputTokens: 0, outputTokens: 0, cached: true }),
      JSON.stringify({ at: '2026-09-01T00:00:00Z', task: 'old', provider: 'openai', model: 'm', inputTokens: 999, outputTokens: 999 }),
      'not json',
    ];
    const s = summarizeUsage(lines, { now });
    expect(s.totals).toEqual({ calls: 2, cached: 1, inputTokens: 100, outputTokens: 20 });
    expect(s.rows).toHaveLength(1);
  });
});

describe('follow-up alerts (P3-3)', () => {
  const reminders = [
    { jobId: 'a', company: 'Globex', title: 'DE', dueOn: '2026-11-10' },
    { jobId: 'b', company: 'Initech', title: 'BI', dueOn: '2026-11-11' },
    { jobId: 'c', company: 'Hooli', title: 'PE', dueOn: '2026-11-15' },
  ];
  it('alerts due reminders once per day', () => {
    expect(dueAlerts(reminders, {}, '2026-11-11').map((r) => r.jobId)).toEqual(['a', 'b']);
    expect(dueAlerts(reminders, { a: '2026-11-11' }, '2026-11-11').map((r) => r.jobId)).toEqual(['b']);
    expect(dueAlerts(reminders, { a: '2026-11-10' }, '2026-11-11').map((r) => r.jobId)).toEqual(['a', 'b']);
  });

  it('sends each once and remembers it across restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alerts-'));
    const sent = [];
    const notifier = { actionRequired: async (title, message) => { sent.push(`${title}: ${message}`); } };
    try {
      expect(await alertDueFollowUps({ root, reminders, today: '2026-11-11', notifier })).toBe(2);
      expect(await alertDueFollowUps({ root, reminders, today: '2026-11-11', notifier })).toBe(0);
      expect(sent).toEqual(['Follow-up due: Globex — DE', 'Follow-up due: Initech — BI']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
