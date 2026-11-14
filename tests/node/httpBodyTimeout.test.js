/**
 * A response that sends its headers and then stalls must still time out.
 *
 * The timeout used to be cleared as soon as headers arrived, so `res.json()`
 * on a stalled body waited forever — and the discovery run with it. These tests
 * use a real local HTTP server (127.0.0.1, no external network) that writes a
 * 200 and a partial body and then never ends the response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';

import {
  fetchWithTimeout, fetchJsonWithTimeout, fetchTextWithTimeout,
} from '../../src/utils/httpClient.js';

let server;
let base;
const open = new Set();

beforeAll(async () => {
  server = createServer((req, res) => {
    open.add(res);
    if (req.url === '/stall') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
      return; // never end
    }
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  for (const res of open) res.destroy?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

describe('response body reads are covered by the request timeout', () => {
  // The timeout covers the headers too. At 150 ms this failed once in a full
  // parallel run (177 files) because the headers themselves arrived late; alone
  // it passed 5 of 5. One second is still far below the 3 s "did not hang" bound.
  const STALL_TIMEOUT_MS = 1000;

  it('rejects a stalled res.json() with a retryable ETIMEDOUT instead of hanging', async () => {
    const started = Date.now();
    const res = await fetchWithTimeout(fetch, `${base}/stall`, {}, STALL_TIMEOUT_MS);
    expect(res.ok).toBe(true);
    const err = await res.json().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ETIMEDOUT');
    expect(err.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('fetchJsonWithTimeout times out a stalled body too', async () => {
    const err = await fetchJsonWithTimeout(fetch, `${base}/stall`, {}, STALL_TIMEOUT_MS, 'Test').catch((e) => e);
    expect(err.code).toBe('ETIMEDOUT');
  });

  it('parses a complete body normally and throws httpError on a non-2xx status', async () => {
    await expect(fetchJsonWithTimeout(fetch, `${base}/ok`, {}, 2000, 'Test')).resolves.toEqual({ ok: true });
    await expect(fetchTextWithTimeout(fetch, `${base}/text`, {}, 2000, 'Test')).resolves.toBe('hello');
    const err = await fetchJsonWithTimeout(fetch, `${base}/missing`, {}, 2000, 'Test').catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toContain('Test HTTP 404');
  });

  it('a caller cancel during a stalled body read surfaces as cancelled, not as a timeout', async () => {
    const external = new AbortController();
    const res = await fetchWithTimeout(fetch, `${base}/stall`, { signal: external.signal }, 10_000);
    const pending = res.json().catch((e) => e);
    external.abort();
    const err = await pending;
    expect(err.cancelled).toBe(true);
    expect(err.code).toBe('RUN_CANCELLED');
  });

  it('guards a test double whose body promise never settles', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const err = await fetchJsonWithTimeout(fetchImpl, 'http://double.test', {}, 50).catch((e) => e);
    expect(err.code).toBe('ETIMEDOUT');
  });
});
