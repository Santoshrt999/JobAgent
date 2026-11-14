/**
 * The Activity menu lists an optional tool only when it is set up: an item
 * that could only open "this is off" is clutter. GET /api/features says which.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';

let dash; let db; let root;
async function start(deps = {}) {
  root = mkdtempSync(join(tmpdir(), 'jobagent-features-'));
  db = openDatabase({ path: ':memory:' });
  dash = await startDashboard({ config: { root }, db, logger: null, port: 0, deps });
  return (await fetch(`${dash.url}/api/features`)).json();
}
afterEach(async () => {
  await dash?.close(); db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  dash = null; db = null; root = null;
});

describe('GET /api/features', () => {
  it('reports both tools off when nothing is configured', async () => {
    expect(await start({ inboxEnv: {}, rerankEnv: {} })).toEqual({ inbox: false, rerank: false });
  });

  it('reports a tool on once it is configured', async () => {
    const on = await start({
      inboxSettings: { enabled: true, reason: null },
      rerankEnv: { RERANK: 'on', RERANK_PROVIDER: 'ollama', RERANK_MODEL: 'nomic-embed-text' },
    });
    expect(on).toEqual({ inbox: true, rerank: true });
  });

  it('never exposes settings, only yes or no', async () => {
    const body = await start({ inboxSettings: { enabled: true, password: 'secret', user: 'me@example.com' } });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(Object.keys(body).sort()).toEqual(['inbox', 'rerank']);
  });
});

describe('the menus as shipped', () => {
  it('hide optional tools until /api/features says they are ready', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../src/dashboard/public/index.html', import.meta.url), 'utf8');
    expect(html).toContain('data-action="open-rerank" data-feature="rerank" hidden');
    expect(html).toContain('data-action="open-inbox" data-feature="inbox" hidden');
    const actions = readFileSync(new URL('../../src/dashboard/public/assets/js/actions.js', import.meta.url), 'utf8');
    expect(actions).toContain("node.hidden = !on?.[node.dataset.feature];");
  });
});
