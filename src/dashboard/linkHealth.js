/** Honest, non-bypassing health checks for job posting URLs. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { isPublicHttpUrl } from '../utils/publicUrl.js';
import { safeFetch } from '../utils/safeFetch.js';
import { checkPostingLiveness } from '../search/postingLiveness.js';

const AGGREGATORS = /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter|simplyhired|monster)\./i;

/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;

export function classifyJobUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'invalid', host: url.hostname };
    return { kind: AGGREGATORS.test(url.hostname) ? 'aggregator' : 'direct', host: url.hostname };
  } catch {
    return { kind: 'invalid', host: '' };
  }
}

/**
 * Is this resolved IP address private, loopback, link-local or otherwise not
 * the public internet? Covers IPv4, IPv6 and IPv4-mapped IPv6.
 * @param {string} address
 */
export function isPrivateAddress(address) {
  let a = String(address ?? '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 10 || p === 127 || p === 0 || (p === 169 && q === 254)
      || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)
      || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (isIP(a) === 6) {
    return a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  return true; // not an address at all: refuse
}

/**
 * Refuse a hop unless it is a public http(s) URL whose host RESOLVES only to
 * public addresses.
 *
 * `isPublicHttpUrl` checks the literal shape only, and `redirect: 'follow'`
 * never showed us the intermediate hops at all: a public posting URL that
 * 302s to http://169.254.169.254/ (cloud metadata) or http://127.0.0.1:4646/
 * (this dashboard's own API) was fetched by the server on the user's behalf.
 * Every hop is now validated, and resolved, before it is requested.
 *
 * @returns {Promise<string|null>} a reason to refuse, or null when safe
 */
async function unsafeHopReason(url, lookupImpl) {
  if (!isPublicHttpUrl(url)) return 'not a public HTTP(S) address';
  if (!lookupImpl) return null;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    return null; // unresolvable: the fetch itself will fail and say so
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.some((entry) => isPrivateAddress(entry?.address ?? entry))
    ? 'resolves to a private or local network address' : null;
}

const ATS_NAMES = {
  workday: 'Workday', smartrecruiters: 'SmartRecruiters', greenhouse: 'Greenhouse', lever: 'Lever',
  oracle: 'Oracle Recruiting', ashby: 'Ashby',
};

export async function checkJobLink(value, { fetchImpl = safeFetch, timeoutMs = 12000, lookupImpl, job = null, livenessImpl } = {}) {
  const classified = classifyJobUrl(value);
  if (classified.kind === 'invalid') {
    return { ...classified, status: 'invalid', httpStatus: null, finalUrl: null, message: 'This is not a valid HTTP(S) job URL.' };
  }
  // Ask the posting's own ATS first. An HTTP 200 proves nothing on Workday,
  // which renders "The page you are looking for doesn't exist" in the browser
  // on a 200 response — the link check used to call those postings reachable.
  if (job) {
    const live = await (livenessImpl ?? checkPostingLiveness)({ ...job, url: value }, { fetchImpl, timeoutMs });
    const name = ATS_NAMES[live.via] ?? live.via;
    if (live.state === 'open') {
      return { ...classified, status: 'open', liveness: live, httpStatus: live.httpStatus ?? null, finalUrl: String(value),
        message: `Posting is open — confirmed by the ${name} job API.` };
    }
    if (live.state === 'unknown' && /career-site segment/.test(live.detail ?? '')) {
      return { ...classified, status: 'broken', liveness: live, httpStatus: null, finalUrl: String(value),
        message: 'This Workday link is missing its career-site segment, so it opens Workday\'s "page doesn\'t exist" '
          + 'screen. Use "Replace URL" with the link from the employer\'s careers page.' };
    }
    if (live.state === 'closed') {
      return { ...classified, status: 'closed', liveness: live, httpStatus: live.httpStatus ?? null, finalUrl: String(value),
        message: `The employer has closed this posting — ${name} no longer lists it.` };
    }
  }
  // Real DNS whenever a real fetch is used; an injected fetch (tests) may
  // inject its own resolver too. The default safeFetch also checks the address
  // it connects to, so this pre-check only gives a clearer message.
  const resolver = lookupImpl ?? ((fetchImpl === safeFetch || fetchImpl === fetch) ? dnsLookup : null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = String(value);
    let response = null;
    for (let hop = 0; ; hop += 1) {
      const refused = await unsafeHopReason(current, resolver);
      if (refused) {
        return { kind: classifyJobUrl(current).kind, status: 'blocked', httpStatus: null, finalUrl: current,
          message: `The link check refused to follow this address: ${refused}.` };
      }
      response = await fetchImpl(current, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'JobAgent-LinkCheck/1.0 (local availability check; no form submission)',
        },
      });
      try { await response.body?.cancel?.(); } catch { /* no body on test doubles */ }
      const code = Number(response.status) || 0;
      const location = code >= 300 && code < 400
        ? (response.headers?.get?.('location') ?? null) : null;
      if (!location) break;
      if (hop + 1 >= MAX_REDIRECTS) {
        return { kind: classifyJobUrl(current).kind, status: 'error', httpStatus: code, finalUrl: current,
          message: `The posting redirected more than ${MAX_REDIRECTS} times.` };
      }
      current = new URL(location, current).toString();
    }
    const httpStatus = Number(response.status) || null;
    const finalUrl = response.url || current;
    const finalKind = classifyJobUrl(finalUrl).kind;
    if (httpStatus >= 200 && httpStatus < 400) {
      return { kind: finalKind, status: 'reachable', httpStatus, finalUrl,
        message: finalUrl !== String(value) ? 'Posting is reachable and redirects to this URL.' : 'Posting is reachable.' };
    }
    if ([404, 410].includes(httpStatus)) {
      return { kind: finalKind, status: 'closed', httpStatus, finalUrl,
        message: 'The server reports that this posting is missing or closed.' };
    }
    if ([401, 403].includes(httpStatus)) {
      return { kind: finalKind, status: 'restricted', httpStatus, finalUrl,
        message: finalKind === 'aggregator'
          ? 'The aggregator restricts automated access. The posting may still open normally in your browser.'
          : 'The employer site restricts automated access. Open it manually; this does not prove the job is closed.' };
    }
    if (httpStatus === 429) {
      return { kind: finalKind, status: 'rate_limited', httpStatus, finalUrl,
        message: 'The site is rate-limiting checks. Wait and open the posting manually.' };
    }
    return { kind: finalKind, status: 'error', httpStatus, finalUrl,
      message: `The posting returned HTTP ${httpStatus ?? 'error'}.` };
  } catch (err) {
    if (err?.code === 'BLOCKED_URL') {
      return { ...classified, status: 'blocked', httpStatus: null, finalUrl: String(value),
        message: `The link check refused to follow this address: ${err.message}.` };
    }
    const timedOut = err?.name === 'AbortError';
    return { ...classified, status: timedOut ? 'timeout' : 'unreachable', httpStatus: null,
      finalUrl: String(value), message: timedOut ? 'The link check timed out.' : `The posting could not be reached: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
