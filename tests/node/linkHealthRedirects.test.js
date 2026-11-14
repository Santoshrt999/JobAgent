import { describe, it, expect } from 'vitest';
import { checkJobLink, isPrivateAddress, MAX_REDIRECTS } from '../../src/dashboard/linkHealth.js';

const redirect = (to) => ({ status: 302, headers: { get: (h) => (h === 'location' ? to : null) }, body: null });
const ok = (url) => ({ status: 200, url, headers: { get: () => null }, body: null });
const publicDns = async () => [{ address: '93.184.216.34' }];

describe('linkHealth — every redirect hop is validated', () => {
  it('follows public redirects manually', async () => {
    const seen = [];
    const result = await checkJobLink('https://jobs.example.com/a', {
      lookupImpl: publicDns,
      fetchImpl: async (url, init) => {
        seen.push([url, init.redirect]);
        return url.endsWith('/a') ? redirect('/b') : ok(url);
      },
    });
    expect(seen).toEqual([['https://jobs.example.com/a', 'manual'], ['https://jobs.example.com/b', 'manual']]);
    expect(result).toMatchObject({ status: 'reachable', finalUrl: 'https://jobs.example.com/b' });
  });

  it('refuses a redirect to a loopback / metadata address without requesting it', async () => {
    const seen = [];
    for (const target of ['http://127.0.0.1:4646/api/stats', 'http://169.254.169.254/latest/meta-data']) {
      const result = await checkJobLink('https://jobs.example.com/a', {
        lookupImpl: publicDns,
        fetchImpl: async (url) => { seen.push(url); return redirect(target); },
      });
      expect(result.status).toBe('blocked');
    }
    expect(seen.every((u) => u.startsWith('https://jobs.example.com'))).toBe(true);
  });

  it('refuses a public hostname that RESOLVES to a private address', async () => {
    const result = await checkJobLink('https://sneaky.example.com/', {
      lookupImpl: async () => [{ address: '10.0.0.5' }],
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    expect(result.status).toBe('blocked');
  });

  it('reports blocked when the connect-time guard refuses (the rebinding case the pre-check cannot see)', async () => {
    // The pre-check resolves to a public address, but the fetch's own
    // connect-time lookup gets a private one: a DNS answer that changed.
    const { createSafeFetch } = await import('../../src/utils/safeFetch.js');
    const fetchImpl = createSafeFetch({
      lookupImpl: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    const result = await checkJobLink('https://rebinding.example.com/job', { lookupImpl: publicDns, fetchImpl });
    expect(result.status).toBe('blocked');
    expect(result.message).toMatch(/private or local network address/);
  });

  it(`caps redirects at ${MAX_REDIRECTS}`, async () => {
    let n = 0;
    const result = await checkJobLink('https://jobs.example.com/0', {
      lookupImpl: publicDns,
      fetchImpl: async () => { n += 1; return redirect(`/${n}`); },
    });
    expect(n).toBe(MAX_REDIRECTS);
    expect(result.message).toMatch(/redirected more than/);
  });

  it('classifies private addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });
});
