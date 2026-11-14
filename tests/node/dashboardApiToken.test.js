/**
 * The dashboard's access token (P1-5): no API access without it, the launcher
 * link swaps it for a cookie, and the extension keeps its own key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';

import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';
import {
  loadOrCreateToken, readToken, resolveApiToken, tokenFromRequest, tokensMatch, TOKEN_FILE,
} from '../../src/dashboard/apiToken.js';

const TOKEN = 'a'.repeat(43);
let dash; let db;

beforeAll(async () => {
  db = openDatabase({ path: ':memory:' });
  dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps: { apiToken: TOKEN } });
});
afterAll(async () => { await new Promise((r) => dash.server.close(r)); db.close(); });

/** Raw request, so headers like Host can be omitted and redirects are not followed. */
function raw(path, { method = 'GET', headers = {}, host = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: dash.port, path, method, setHost: host, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dashboard access token (P1-5)', () => {
  it('refuses API calls without the token', async () => {
    const r = await raw('/api/stats');
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toMatch(/locked/);
  });

  it('serves the API with the header token', async () => {
    expect((await raw('/api/stats', { headers: { 'x-job-agent-token': TOKEN } })).status).toBe(200);
    expect((await raw('/api/stats', { headers: { 'x-job-agent-token': 'b'.repeat(43) } })).status).toBe(401);
  });

  it('shows a locked page, not the app, to a browser without the token', async () => {
    const r = await raw('/');
    expect(r.status).toBe(401);
    expect(r.body).toContain('JobAgent is locked');
    expect(r.body).not.toContain('main.js');
  });

  it('swaps the launcher link for an HttpOnly, SameSite=Strict cookie and a clean redirect', async () => {
    const r = await raw(`/?token=${TOKEN}`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/');
    const cookie = r.headers['set-cookie'][0];
    expect(cookie).toMatch(new RegExp(`^jobagent_token_${dash.port}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const pair = cookie.split(';')[0];
    const page = await raw('/', { headers: { cookie: pair } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('/assets/js/main.js');
    expect((await raw('/api/stats', { headers: { cookie: pair } })).status).toBe(200);
  });

  it('refuses a wrong link token', async () => {
    const r = await raw(`/?token=${'c'.repeat(43)}`);
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('still serves static assets (public code, no data) without the token', async () => {
    expect((await raw('/assets/js/main.js')).status).toBe(200);
  });

  it('refuses a request with no Host header', async () => {
    // Node's own HTTP parser answers 400 first (requireHostHeader); the
    // dashboard's isLoopbackHost would answer 403. Either way it is refused.
    const { status } = await raw('/api/stats', { host: false, headers: { 'x-job-agent-token': TOKEN } });
    expect([400, 403]).toContain(status);
  });

  it('leaves the extension namespace to its own shared key', async () => {
    const r = await raw('/api/extension/jobs/x/payload');
    expect(r.status).not.toBe(401);
  });
});

describe('token storage', () => {
  it('creates a 256-bit token once, owner-only, and reuses it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tok-'));
    try {
      expect(readToken(root)).toBeNull();
      const first = loadOrCreateToken(root);
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(loadOrCreateToken(root)).toBe(first);
      expect(readFileSync(join(root, TOKEN_FILE), 'utf8').trim()).toBe(first);
      if (process.platform !== 'win32') expect(statSync(join(root, TOKEN_FILE)).mode & 0o077).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves explicit, disabled and env-disabled tokens', () => {
    expect(resolveApiToken({ deps: { apiToken: 'x'.repeat(43) }, env: {} })).toBe('x'.repeat(43));
    expect(resolveApiToken({ deps: { apiToken: false }, env: {} })).toBeNull();
    expect(resolveApiToken({ deps: {}, env: { JOB_AGENT_DASHBOARD_AUTH: 'off' } })).toBeNull();
    expect(resolveApiToken({ deps: {}, env: {} })).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reads the token from the header or the per-port cookie and compares in constant time', () => {
    expect(tokenFromRequest({ headers: { 'x-job-agent-token': 'abc' } }, 4646)).toBe('abc');
    expect(tokenFromRequest({ headers: { cookie: 'a=1; jobagent_token_4646=xyz' } }, 4646)).toBe('xyz');
    expect(tokenFromRequest({ headers: { cookie: 'jobagent_token_4747=xyz' } }, 4646)).toBeNull();
    expect(tokensMatch('same', 'same')).toBe(true);
    expect(tokensMatch('same', 'other')).toBe(false);
    expect(tokensMatch(null, 'other')).toBe(false);
  });
});

describe('unlocking in a real browser (P1-5)', { timeout: 120_000 }, () => {
  it('shows the locked page, then the working app after the launcher link', async (ctx) => {
    const { launchBrowser, waitUntilConnected } = await import('./helpers/dashboardPage.js');
    const { browserUnavailable } = await import('./helpers/browser.js');
    let browser;
    try { browser = await launchBrowser(); } catch (err) { browserUnavailable(err); return ctx.skip(); }
    try {
      const page = await (await browser.newContext()).newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(dash.url);
      await expect(page.getByRole('heading', { name: 'JobAgent is locked' }).isVisible()).resolves.toBe(true);

      await page.goto(dash.unlockUrl);
      // The token leaves the address bar, and the app's own API calls succeed.
      expect(new URL(page.url()).search).toBe('');
      await waitUntilConnected(page);
      expect(await page.locator('#conn').textContent()).toBe('Connected');
    } finally {
      await browser.close();
    }
  });
});
