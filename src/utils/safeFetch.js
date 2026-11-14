// @ts-check
/**
 * A fetch that can only reach the PUBLIC internet, checked when the socket
 * connects, not before.
 *
 * `publicUrl.js` judges a URL by its literal shape. That stops `127.0.0.1`,
 * `10.0.0.5` and `localhost`, but not a public-looking hostname whose DNS
 * answer is private: `localtest.me` resolves to 127.0.0.1, and anyone can point
 * a name they own at 169.254.169.254 (cloud metadata) or a LAN router. Resolving
 * the name first and fetching after does not close the gap either: the fetch
 * resolves again, and a short-TTL record can answer differently the second time
 * (DNS rebinding).
 *
 * So the check lives inside the connection. Requests go through node:http /
 * node:https with a custom `lookup`: every address the resolver returns is
 * checked, and if ANY of them is private, loopback, link-local, multicast or
 * otherwise reserved, the connection is refused. The address that is checked
 * is the address that is used. Redirects are followed by hand and every hop
 * goes through the same lookup. Lookup errors fail closed.
 *
 * The result is fetch-compatible (it returns a WHATWG Response), so it drops
 * into any `fetchImpl` slot. Proxy environment variables are deliberately not
 * honoured: a proxy would resolve the name itself and bypass the check.
 */

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Readable, Transform, pipeline } from 'node:stream';
import zlib from 'node:zlib';

import { assertPublicHttpUrl, MAX_REDIRECTS } from './publicUrl.js';

/** Default total time for one hop (headers and body), in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default largest decoded body accepted, in bytes. Sitemaps can be large. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Every range that is not the public internet. Sources: IANA IPv4 and IPv6
// Special-Purpose Address Registries (RFC 6890 and successors).
/** @type {Array<[string, number]>} */
const IPV4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
];
/** @type {Array<[string, number]>} */
const IPV6_BLOCKED = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const BLOCKED = new BlockList();
for (const [net, prefix] of IPV4_BLOCKED) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of IPV6_BLOCKED) BLOCKED.addSubnet(net, prefix, 'ipv6');

/**
 * Expand an IPv6 address into its 8 hextets (numbers). Accepts a trailing
 * dotted quad (`::ffff:1.2.3.4`). Returns null when it is not IPv6.
 * @param {string} address
 * @returns {number[]|null}
 */
function ipv6Hextets(address) {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const quad = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad[1].split('.').map(Number);
    text = `${text.slice(0, -quad[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const parts = tail === null ? left : [...left, ...Array(missing).fill('0'), ...right];
  return parts.map((h) => parseInt(h || '0', 16));
}

/** The IPv4 address an IPv6 address carries, when it is a transition form. */
function embeddedIpv4(hextets) {
  const toV4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n) => hextets.slice(0, n).every((h) => h === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible)
  if (zeros(5) && hextets[5] === 0xffff) return toV4(hextets[6], hextets[7]);
  if (zeros(6) && (hextets[6] !== 0 || hextets[7] > 1)) return toV4(hextets[6], hextets[7]);
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)) {
    return toV4(hextets[6], hextets[7]);
  }
  // 2002:AABB:CCDD::/48 (6to4)
  if (hextets[0] === 0x2002) return toV4(hextets[1], hextets[2]);
  return null;
}

/**
 * Is this IP address anything other than the public internet? Unknown or
 * malformed input counts as blocked.
 * @param {string} address
 * @returns {boolean}
 */
export function isBlockedAddress(address) {
  const bare = String(address ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, 'ipv4');
  if (family === 6) {
    const hextets = ipv6Hextets(bare);
    const v4 = hextets && embeddedIpv4(hextets);
    if (v4 && BLOCKED.check(v4, 'ipv4')) return true;
    return BLOCKED.check(bare, 'ipv6');
  }
  return true;
}

function blockedError(message) {
  return Object.assign(new Error(message), { code: 'BLOCKED_URL', retryable: false });
}

/**
 * A `lookup` for net/http that refuses any hostname with a blocked answer.
 * Every answer is checked, not just the first, because the connection may try
 * any of them (happy eyeballs).
 */
function guardedLookup(lookupImpl, isBlocked) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...(options ?? {}) };
    lookupImpl(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses }])
        .map((entry) => (typeof entry === 'string' ? { address: entry } : entry))
        .map((entry) => ({ address: entry.address, family: entry.family ?? isIP(entry.address) }));
      if (list.length === 0) {
        return callback(Object.assign(new Error(`no address found for ${hostname}`), { code: 'ENOTFOUND' }));
      }
      if (list.some((entry) => isBlocked(entry.address))) {
        return callback(blockedError(
          `URL blocked: ${hostname} resolves to a private or local network address, not a public job posting`,
        ));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * Headers in any fetch form (Headers, array of pairs, record) as a plain object.
 * @returns {Record<string, string>}
 */
function plainHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' && !Array.isArray(headers)
    ? headers.entries()
    : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null) out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function requestBody(body, headers) {
  if (body === undefined || body === null) return null;
  if (body instanceof URLSearchParams) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
    return Buffer.from(body.toString());
  }
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new TypeError('safeFetch supports string, Buffer, Uint8Array, ArrayBuffer and URLSearchParams bodies');
}

function decoderFor(encoding) {
  switch (String(encoding ?? '').trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    default: return null;
  }
}

/** One HTTP exchange, no redirect handling. Resolves when headers arrive. */
function singleRequest(url, { method, headers, body, signal }, { lookup, agents, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const outHeaders = plainHeaders(headers);
    outHeaders['accept-encoding'] ??= 'gzip, deflate, br';
    const payload = requestBody(body, outHeaders);
    if (payload) outHeaders['content-length'] = String(payload.length);

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    let settled = false;
    let response = null;
    const timer = setTimeout(() => {
      const err = Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
      req.destroy(err);
      response?.destroy(err);
    }, timeoutMs);
    timer.unref?.();

    const req = lib.request(url, {
      method,
      headers: outHeaders,
      lookup,
      agent: isHttps ? agents.https : agents.http,
      signal,
    }, (res) => {
      response = res;
      settled = true;
      const status = Number(res.statusCode);
      if (!(status >= 200 && status <= 599)) {
        clearTimeout(timer);
        res.destroy();
        reject(Object.assign(new Error(`unsupported HTTP status ${status}`), { retryable: false }));
        return;
      }
      res.once('close', () => clearTimeout(timer));

      const decoder = decoderFor(res.headers['content-encoding']);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (decoder && (key === 'content-encoding' || key === 'content-length')) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) responseHeaders.append(key, String(item));
        }
      }

      const nullBody = NULL_BODY_STATUSES.has(status) || method === 'HEAD';
      let webBody = null;
      if (nullBody) {
        res.resume();
      } else {
        let seen = 0;
        const limiter = new Transform({
          transform(chunk, _encoding, done) {
            seen += chunk.length;
            if (seen > maxBytes) {
              done(Object.assign(new Error(`response is larger than ${maxBytes} bytes`), {
                code: 'RESPONSE_TOO_LARGE', retryable: false,
              }));
            } else {
              done(null, chunk);
            }
          },
        });
        const done = () => { /* errors surface through the body stream */ };
        if (decoder) pipeline(res, decoder, limiter, done);
        else pipeline(res, limiter, done);
        webBody = Readable.toWeb(limiter);
      }

      const out = new Response(webBody, { status, statusText: res.statusMessage ?? '', headers: responseHeaders });
      Object.defineProperty(out, 'url', { value: url.href });
      resolve(out);
    });

    req.once('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });
    if (payload) req.end(payload);
    else req.end();
  });
}

/**
 * Build a guarded fetch. Tests inject `lookupImpl` (a dns.lookup-style
 * function) and, to reach a local test server at all, `isBlocked`.
 *
 * @param {object} [options]
 * @param {typeof dnsLookup} [options.lookupImpl]
 * @param {(address: string) => boolean} [options.isBlocked]
 * @param {number} [options.maxRedirects]
 * @param {number} [options.timeoutMs] per hop, headers and body together
 * @param {number} [options.maxBytes] decoded body cap
 * @returns {typeof fetch}
 */
export function createSafeFetch({
  lookupImpl = dnsLookup,
  isBlocked = isBlockedAddress,
  maxRedirects = MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const lookup = guardedLookup(lookupImpl, isBlocked);
  // Agents are per instance: a kept-alive socket was checked when it
  // connected, and must never be shared with an instance that checks
  // differently.
  const agents = {
    http: new http.Agent({ keepAlive: true, maxSockets: 8 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 8 }),
  };

  return async function safeFetch(input, init = {}) {
    const any = /** @type {any} */ (input);
    let current = typeof input === 'string' ? input : (any?.href ?? any?.url ?? String(input));
    let method = String(init.method ?? 'GET').toUpperCase();
    let body = init.body;
    const follow = (init.redirect ?? 'follow') === 'follow';
    if (init.redirect === 'error') {
      throw new TypeError('safeFetch does not support redirect: "error"');
    }

    for (let hop = 0; ; hop += 1) {
      const check = assertPublicHttpUrl(current);
      if (!check.ok) throw blockedError(`${hop ? 'redirect blocked' : 'URL blocked'}: ${check.reason}`);
      const url = check.url;
      // Literal IP hosts never reach `lookup`, so judge them here.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && isBlocked(host)) {
        throw blockedError(`${hop ? 'redirect blocked' : 'URL blocked'}: that is a private or local network address`);
      }

      const response = await singleRequest(url, { method, headers: init.headers, body, signal: init.signal },
        { lookup, agents, timeoutMs, maxBytes });
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (!location || !follow) {
        if (hop > 0) Object.defineProperty(response, 'redirected', { value: true });
        return response;
      }
      if (hop >= maxRedirects) {
        try { await response.body?.cancel(); } catch { /* already closed */ }
        throw Object.assign(new Error(`too many redirects (more than ${maxRedirects})`), { retryable: false });
      }
      try { await response.body?.cancel(); } catch { /* already closed */ }
      current = new URL(location, url).href;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
  };
}

/** The default guarded fetch, using real DNS. */
export const safeFetch = createSafeFetch();
