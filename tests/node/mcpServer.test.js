/**
 * The MCP server (P2-4), through a real MCP client over an in-memory
 * transport: exactly the allowed tools, none that can act on an application,
 * reads that work, and the two append-only writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, FORBIDDEN_TOOL_WORDS, MCP_TOOLS } from '../../src/mcp/server.js';
import { openDatabase } from '../../src/logging/db.js';

let db; let client;
const config = { candidate: { identity: { fullName: 'Test Person', headline: 'Data Engineer' }, contact: { email: 'test@example.com' }, targetTitles: ['Data Engineer'], technicalStack: { languages: ['Python'] } } };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

beforeAll(async () => {
  db = openDatabase({ path: ':memory:' });
  db.upsertJob({ id: 'g1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://x/1', score: 88, tier: 'Priority', status: 'scored' });
  db.upsertJob({ id: 's1', company: 'Initech', title: 'Analytics Engineer', url: 'https://x/2', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
  const server = createMcpServer({ db, config, env: {}, now: () => new Date('2026-11-11T12:00:00Z') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => { await client.close(); db.close(); });

describe('MCP server (P2-4)', () => {
  it('offers exactly the allowed tools, and none that could act on an application', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    for (const t of tools) expect(FORBIDDEN_TOOL_WORDS.test(t.name), t.name).toBe(false);
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(['add_note', 'record_outcome']);
  });

  it('searches and reads jobs', async () => {
    const found = await call('search_jobs', { query: 'globex' });
    expect(found.data.jobs.map((j) => j.id)).toEqual(['g1']);
    const job = await call('get_job', { jobId: 'g1' });
    expect(job.data).toMatchObject({ id: 'g1', company: 'Globex' });
    expect(job.data.packet).toBeUndefined();
  });

  it('keeps contact details out of the profile summary by default', async () => {
    const p = await call('get_profile_summary');
    expect(p.data.targetTitles).toEqual(['Data Engineer']);
    expect(JSON.stringify(p.data)).not.toContain('test@example.com');
    expect(JSON.stringify(p.data)).not.toContain('Test Person');
  });

  it('adds a note and records an outcome on a submitted application only', async () => {
    expect((await call('add_note', { jobId: 'g1', note: 'Ask about the team size.' })).isError).toBeFalsy();
    expect(db.getJob('g1').notes).toBe('Ask about the team size.');
    const ok = await call('record_outcome', { jobId: 's1', outcome: 'interviewing', note: 'Phone screen booked' });
    expect(ok.data.recorded).toBe('interviewing');
    const refused = await call('record_outcome', { jobId: 'g1', outcome: 'interviewing' });
    expect(refused.isError).toBe(true);
  });

  it('errors on any tool that does not exist', async () => {
    const r = await client.callTool({ name: 'submit_application', arguments: { jobId: 'g1' } }).catch((e) => ({ isError: true, error: e }));
    expect(r.isError).toBe(true);
  });
});
