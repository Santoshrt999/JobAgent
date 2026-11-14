/**
 * Drafted replies (P2-6): grounded in the resume, with gaps for what only the
 * applicant can say, and no way to send.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../../src/logging/db.js';
import { draftReply } from '../../src/inbox/draftReply.js';
import { SUGGESTION_EVENT } from '../../src/inbox/sync.js';
import { startDashboard } from '../../src/dashboard/server.js';

const ROLE = 'Data Engineer, Acme Corp | 2021 - Present';
const UNITS = [{ id: 'u2', kind: 'bullet', role: ROLE, text: 'Built medallion pipelines on Azure Databricks with PySpark.' }];
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k' };

function seed() {
  const db = openDatabase({ path: ':memory:' });
  db.upsertJob({ id: 'g1', company: 'Globex', title: 'Data Engineer', url: 'https://x/1', applied: 1, status: 'submitted' });
  const id = randomUUID();
  db.insertEvent({ id, job_id: 'g1', event_type: SUGGESTION_EVENT, message: 'interview', metadata: JSON.stringify({
    messageId: '<m@x>', kind: 'interview', outcome: 'interviewing', subject: 'Phone screen', evidence: 'Could you share your availability for a phone screen?',
    from: { name: 'Jane Smith', domain: 'globex.com', address: 'jane@globex.com' },
  }) });
  return { db, id };
}
const model = (data) => ({
  readMasterUnitsFn: async () => UNITS,
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) }),
});

describe('drafted replies (P2-6)', () => {
  it('keeps backed and courtesy paragraphs, drops invented claims, and lists the gaps', async () => {
    const { db, id } = seed();
    const draft = await draftReply({ db, suggestionId: id, config: { candidate: { identity: { fullName: 'Test Person' } } }, env: ENV, deps: model({
      paragraphs: [
        { text: 'Thank you for reaching out, I would be glad to talk about the Data Engineer role at Globex.', evidence: [] },
        { text: 'At Acme Corp I built medallion pipelines on Azure Databricks with PySpark.', evidence: ['u2'] },
        { text: 'I also ran Kafka clusters handling 2 million events a day.', evidence: ['u2'] },
        { text: 'I am available [your available times].', evidence: [] },
      ],
      gaps: ['Your available times for a phone screen'],
    }) });
    expect(draft.to).toBe('jane@globex.com');
    expect(draft.subject).toBe('Re: Phone screen');
    expect(draft.text.startsWith('Hi Jane,')).toBe(true);
    expect(draft.text).toContain('[your available times]');
    expect(draft.text).not.toContain('Kafka');
    expect(draft.dropped).toHaveLength(1);
    expect(draft.gaps).toEqual(['Your available times for a phone screen']);
    expect(draft.text.trim().endsWith('Test Person')).toBe(true);
  });

  it('refuses a draft with nothing backed, and needs the LLM', async () => {
    const { db, id } = seed();
    await expect(draftReply({ db, suggestionId: id, config: {}, env: ENV, deps: model({
      paragraphs: [{ text: 'I have 10 years of Snowflake experience.', evidence: [] }], gaps: [],
    }) })).rejects.toThrow(/No paragraph/);
    await expect(draftReply({ db, suggestionId: id, config: {}, env: {} })).rejects.toThrow(/LLM assist/);
  });

  it('offers no way to send: there is no send route', async () => {
    const { db } = seed();
    const dash = await startDashboard({ config: {}, db, logger: null, port: 0 });
    try {
      for (const p of ['/api/inbox/send', '/api/inbox/reply', '/api/inbox/drafts']) {
        const r = await fetch(`${dash.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(r.status, p).toBe(404);
      }
    } finally {
      await new Promise((r) => dash.server.close(r));
    }
  });
});
