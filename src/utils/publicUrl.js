/**
 * Shared "is this a safe PUBLIC http(s) URL to fetch?" guard.
 *
 * The agent fetches URLs the user pastes and URLs an extension observes. Both
 * must be real, public job postings. A local or private-network address is never
 * a job posting, and fetching one turns a local convenience feature into a
 * request forgery primitive against the user's own machine and LAN (cloud
 * metadata endpoints, router admin pages, internal dashboards).
 *
 * Pure, dependency-free, and deliberately conservative: it blocks by literal
 * address shape. It cannot stop a public hostname that RESOLVES to a private
 * address, so it is the first line of defense and the source of user-facing
 * messages. The complete check is src/utils/safeFetch.js, which refuses a
 * private address at connect time, on every redirect hop.
 */

/** Hostnames that mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '[::]',
]);

/** Longest URL we will accept (DB column + UI sanity). */
export const MAX_URL_LENGTH = 2048;

/**
 * Literal IPv4/IPv6 address ranges that are never a public job posting.
 *   10/8, 172.16/12, 192.168/16   private (RFC 1918)
 *   127/8                        loopback
 *   169.254/16                   link-local — includes cloud metadata
 *                                (169.254.169.254 on AWS/Azure/GCP)
 *   100.64/10                    carrier-grade NAT / tailscale
 *   0/8, 224/4, 240/4            unspecified / multicast / reserved
 *   fc00::/7, fe80::/10          IPv6 unique-local and link-local
 */
const PRIVATE_IPV4_RE = new RegExp([
  '^10\\.',
  '^127\\.',
  '^169\\.254\\.',
  '^172\\.(?:1[6-9]|2\\d|3[01])\\.',
  '^192\\.168\\.',
  '^100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.',
  '^0\\.',
  '^(?:22[4-9]|23\\d|24\\d|25[0-5])\\.',
].join('|'));

const PRIVATE_IPV6_RE = /^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/** Hostname suffixes that only ever resolve inside a private network.
 *  `.localhost` is reserved for loopback (RFC 6761) and resolvers honour it:
 *  `anything.localhost` is 127.0.0.1. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan'];

/** Statuses whose Location a fetch would otherwise follow on its own. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Redirect hops followed before giving up — browsers allow 20; postings need ~2. */
export const MAX_REDIRECTS = 5;

/**
 * Validate a URL as a fetchable public http(s) address.
 *
 * @param {unknown} value candidate URL
 * @returns {{ ok: boolean, reason: string|null, url: URL|null }}
 */
export function assertPublicHttpUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return fail('a URL is required');
  if (raw.length > MAX_URL_LENGTH) return fail(`URL is longer than ${MAX_URL_LENGTH} characters`);

  let url;
  try { url = new URL(raw); }
  catch { return fail('not a valid URL'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return fail('only http(s) URLs can be read (no file:, data:, or custom schemes)');
  }
  // Credentials in a job URL are always a mistake and would be sent upstream.
  if (url.username || url.password) return fail('remove the credentials from the URL');

  // A trailing dot is the fully-qualified spelling of the SAME name, so
  // `localhost.` and `jobs.local.` resolve exactly like their dotless forms and
  // must be judged as them.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const bare = host.replace(/^\[|\]$/g, '');

  if (LOOPBACK_HOSTNAMES.has(host) || LOOPBACK_HOSTNAMES.has(bare)) {
    return fail('that is a local address, not a public job posting');
  }
  if (PRIVATE_IPV4_RE.test(bare) || PRIVATE_IPV6_RE.test(bare)) {
    return fail('that is a private or link-local network address, not a public job posting');
  }
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return fail('that hostname is internal to your network, not a public job posting');
  }
  // A bare single-label host ("intranet", "jobs") can only be internal.
  if (!host.includes('.')) {
    return fail('that hostname is not a public domain');
  }

  return { ok: true, reason: null, url };
}

/** Convenience boolean form. */
export function isPublicHttpUrl(value) {
  return assertPublicHttpUrl(value).ok;
}

/**
 * Wrap a fetch so it only ever talks to public http(s) addresses — including
 * every hop of a redirect chain. Checking the URL once and then letting fetch
 * follow redirects is not a check: a public posting that answers
 * `302 Location: http://169.254.169.254/` walks straight past it. So redirects
 * are followed by hand, and each Location is validated before it is requested.
 *
 * The result is fetch-compatible, so it drops into any `fetchImpl` slot.
 *
 * @param {typeof fetch} [fetchImpl]
 * @param {{ maxRedirects?: number }} [options]
 * @returns {typeof fetch}
 */
export function publicOnlyFetch(fetchImpl = fetch, { maxRedirects = MAX_REDIRECTS } = {}) {
  return async function guardedFetch(input, init = {}) {
    let current = String(input);
    let { method, body } = init;
    for (let hop = 0; ; hop += 1) {
      const check = assertPublicHttpUrl(current);
      if (!check.ok) {
        throw Object.assign(
          new Error(`${hop ? 'redirect blocked' : 'URL blocked'}: ${check.reason}`),
          { code: 'BLOCKED_URL', retryable: false },
        );
      }
      const response = await fetchImpl(current, { ...init, method, body, redirect: 'manual' });
      const status = Number(response.status);
      const location = REDIRECT_STATUSES.has(status) ? response.headers?.get?.('location') : null;
      if (!location) return response;
      if (hop >= maxRedirects) {
        throw Object.assign(new Error(`too many redirects (more than ${maxRedirects})`), { retryable: false });
      }
      try { await response.body?.cancel?.(); } catch { /* nothing to release */ }
      current = new URL(location, current).href;
      // Same method rewrite a browser applies: 303 always becomes GET, and so
      // does a POST answered with 301/302.
      if (status === 303 || ((status === 301 || status === 302) && String(method ?? 'GET').toUpperCase() === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
  };
}

function fail(reason) {
  return { ok: false, reason, url: null };
}
