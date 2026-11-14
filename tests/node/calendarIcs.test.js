/**
 * Follow-ups as a calendar file (P2-5): valid iCalendar basics, stable UIDs,
 * and only reminders that are still open, end to end through the API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildIcs, foldLine } from '../../src/reports/calendar.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';

describe('iCalendar output (P2-5)', () => {
  const reminders = [{ jobId: 'g1', company: 'Globex, Inc.', title: 'Data Engineer; Platform', url: 'https://x/1', dueOn: '2026-11-20', note: 'Ask about\nnext steps' }];

  it('escapes text, uses CRLF, all-day dates and a UID that is the same every time', () => {
    const a = buildIcs(reminders, { now: new Date('2026-11-11T10:00:00Z') });
    const b = buildIcs(reminders, { now: new Date('2026-11-12T10:00:00Z') });
    expect(a.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(a.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(a).not.toMatch(/[^\r]\n/);
    expect(a).toContain('DTSTART;VALUE=DATE:20261120\r\n');
    expect(a).toContain('DTEND;VALUE=DATE:20261121\r\n');
    expect(a).toContain('SUMMARY:Follow up: Globex\\, Inc. — Data Engineer\\; Platform');
    // Every ; in a text value must be escaped, or calendar apps split the field.
    expect(a.split('\r\n').find((l) => l.startsWith('SUMMARY:')).slice('SUMMARY:'.length)).not.toMatch(/(^|[^\\]);/);
    expect(a).toContain('DESCRIPTION:Ask about\\nnext steps\\nhttps://x/1');
    const uid = (s) => s.match(/UID:(.+)\r\n/)[1];
    expect(uid(a)).toBe(uid(b));
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é'.repeat(80)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});

describe('GET /api/calendar.ics', () => {
  let dash; let db;
  beforeAll(async () => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'g1', company: 'Globex', title: 'Data Engineer', url: 'https://x/1', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
    db.upsertJob({ id: 'i1', company: 'Initech', title: 'Analyst', url: 'https://x/2', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
    dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps: { now: () => new Date('2026-11-11T12:00:00Z') } });
  });
  afterAll(async () => { await new Promise((r) => dash.server.close(r)); db.close(); });
  const post = (p, body) => fetch(`${dash.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('contains each open follow-up, and drops one marked done', async () => {
    expect((await post('/api/jobs/g1/follow-up', { action: 'set', dueOn: '2026-11-20' })).status).toBe(200);
    expect((await post('/api/jobs/i1/follow-up', { action: 'set', dueOn: '2026-11-18' })).status).toBe(200);
    expect((await post('/api/jobs/i1/follow-up', { action: 'done' })).status).toBe(200);
    const r = await fetch(`${dash.url}/api/calendar.ics`);
    expect(r.headers.get('content-type')).toMatch(/text\/calendar/);
    const ics = await r.text();
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261120');
    expect(ics).toContain('SUMMARY:Follow up: Globex — Data Engineer');
  });
});
