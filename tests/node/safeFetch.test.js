/**
 * The guarded fetch checks the address it CONNECTS to, so a public-looking
 * hostname that resolves to a private address is refused, and the decision is
 * made on the same answer the socket uses (no second resolution to race).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

import { createSafeFetch, isBlockedAddress } from '../../src/utils/safeFetch.js';

let server;
let port;
const hits = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Data Engineer</h1>'); return; }
    if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('compressed body')); return; }
    if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (req.url === '/to-rebind') { res.writeHead(302, { location: `http://rebind.example.com:${port}/ok` }); res.end(); return; }
    if (req.url === '/to-ok') { res.writeHead(301, { location: '/ok' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (req.url === '/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { res.writeHead(200); res.end(`got:${body}`); });
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

/** dns.lookup-style stub: name -> list of addresses. */
const stubLookup = (table) => (hostname, _options, callback) => {
  const answer = table[hostname];
  if (!answer) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  return callback(null, answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:0001::1',
    'not-an-ip', '',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('createSafeFetch', () => {
  it('refuses a public-looking hostname that resolves to loopback, before any request is sent', async () => {
    const before = hits.length;
    const safe = createSafeFetch({ lookupImpl: stubLookup({ 'localtest.example.com': ['127.0.0.1'] }) });
    await expect(safe(`http://localtest.example.com:${port}/ok`)).rejects.toMatchObject({ code: 'BLOCKED_URL', retryable: false });
    expect(hits.length).toBe(before);
  });

  it('refuses when any one of several answers is private', async () => {
    const safe = createSafeFetch({ lookupImpl: stubLookup({ 'mixed.example.com': ['93.184.216.34', '10.0.0.7'] }) });
    await expect(safe('http://mixed.example.com/')).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  });

  it('fails closed when the lookup errors', async () => {
    const safe = createSafeFetch({ lookupImpl: stubLookup({}) });
    await expect(safe('http://unknown.example.com/')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('refuses literal private addresses and internal names by shape', async () => {
    const safe = createSafeFetch();
    await expect(safe(`http://127.0.0.1:${port}/ok`)).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    await expect(safe('http://[::ffff:7f00:1]/')).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    await expect(safe('http://router.lan/')).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  });

  describe('against a reachable test server', () => {
    // The test server is on loopback, so these tests allow it explicitly and
    // block only the addresses each test names.
    const table = { 'jobs.example.com': ['127.0.0.1'], 'rebind.example.com': ['127.0.0.2'] };
    const allowOnly127001 = (address) => address !== '127.0.0.1';
    const safe = createSafeFetch({ lookupImpl: stubLookup(table), isBlocked: allowOnly127001, maxBytes: 1000 });

    it('returns a fetch-compatible Response', async () => {
      const res = await safe(`http://jobs.example.com:${port}/ok`);
      expect(res.ok).toBe(true);
      expect(res.headers.get('content-type')).toBe('text/html');
      expect(await res.text()).toBe('<h1>Data Engineer</h1>');
      expect(res.url).toBe(`http://jobs.example.com:${port}/ok`);
    });

    it('decodes gzip bodies', async () => {
      const res = await safe(`http://jobs.example.com:${port}/gz`);
      expect(await res.text()).toBe('compressed body');
      expect(res.headers.get('content-encoding')).toBeNull();
    });

    it('follows a safe redirect and marks the response redirected', async () => {
      const res = await safe(`http://jobs.example.com:${port}/to-ok`);
      expect(await res.text()).toBe('<h1>Data Engineer</h1>');
      expect(res.redirected).toBe(true);
    });

    it('refuses a redirect to a metadata address', async () => {
      await expect(safe(`http://jobs.example.com:${port}/to-metadata`)).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    });

    it('re-checks the resolved address on every hop', async () => {
      await expect(safe(`http://jobs.example.com:${port}/to-rebind`)).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    });

    it('returns the 3xx untouched when redirect is manual', async () => {
      const res = await safe(`http://jobs.example.com:${port}/to-metadata`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('169.254.169.254');
    });

    it('stops redirect loops', async () => {
      await expect(safe(`http://jobs.example.com:${port}/loop`)).rejects.toThrow(/too many redirects/);
    });

    it('aborts a body over the size cap', async () => {
      const res = await safe(`http://jobs.example.com:${port}/big`);
      await expect(res.text()).rejects.toThrow();
    });

    it('sends a request body', async () => {
      const res = await safe(`http://jobs.example.com:${port}/echo`, { method: 'POST', body: 'hello' });
      expect(await res.text()).toBe('got:hello');
    });

    it('honours an abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(safe(`http://jobs.example.com:${port}/ok`, { signal: controller.signal })).rejects.toThrow();
    });
  });
});
