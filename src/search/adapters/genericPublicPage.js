/**
 * Generic public-page connector.
 *
 * Fetches a user-provided PUBLIC job URL and extracts the schema.org JobPosting
 * JSON-LD that the page publishes. This is the legitimate, structured, public
 * metadata many ATS/company pages expose. No login, no DOM scraping, no evasion.
 *
 * Used directly and as the parsing engine for other public-URL adapters.
 */

import { parseJsonLdJobs, normalizeJob, htmlToText, extractReadableContent } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { fetchWithTimeout, discoveryHeaders } from '../../utils/httpClient.js';
import { safeFetch } from '../../utils/safeFetch.js';

export const adapterId = 'genericPublicPage';

/**
 * Fetch and parse one public job URL.
 *
 * Unlike the official-API adapters, this one points at arbitrary company sites,
 * so it is the MOST likely to meet a host that accepts a connection and then
 * never answers. It therefore threads the same request timeout and host gate
 * every other adapter uses — without them a single hung careers page stalled
 * the whole discovery run, because `withRetry` cannot rescue a call that never
 * throws.
 *
 * @param {string} url
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {string} [ctx.source]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.requestTimeoutMs]
 * @param {{ run: Function }} [ctx.hostGate]
 * @returns {Promise<object[]>} normalized jobs
 */
export async function fetchUrl(url, ctx = {}) {
  const { fetchImpl = safeFetch, source = 'public', maxRetries = 3, requestTimeoutMs, hostGate } = ctx;
  const call = async () => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: discoveryHeaders({ Accept: 'text/html' }) },
      requestTimeoutMs,
    );
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} for ${url}`);
      e.status = res.status;
      throw e;
    }
    return res.text();
  };
  const html = await withRetry(
    () => (hostGate ? hostGate.run(url, call) : call()),
    { maxRetries },
  );

  // 1. Preferred: structured schema.org JobPosting JSON-LD.
  let jobs = parseJsonLdJobs(html, { url, source });
  if (jobs.length > 0) return jobs;

  // 2..5. Layered readable-content extraction (container -> article/main ->
  // largest block -> stripped). Title-only is the last resort.
  const title = pageTitle(html);
  const { text, method } = extractReadableContent(html);
  if (text && method !== 'empty') {
    return [normalizeJob({
      source, url,
      title: title || firstHeading(html) || '',
      jdText: text.slice(0, 12000),
      rawMetadata: { fallback: method, extractionMethod: method },
    })];
  }

  // 6. Title-only last resort, so the URL is never silently dropped. Enrich the
  //    thin body with the page's <meta name="description"> when available.
  if (title) {
    const stripped = htmlToText(html).slice(0, 8000);
    const meta = metaDescription(html);
    const jdText = meta && meta.length > stripped.length ? meta : (stripped || meta);
    return [normalizeJob({
      source, url, title,
      jdText,
      rawMetadata: { fallback: meta && jdText === meta ? 'meta-description' : 'title-only' },
    })];
  }
  return [];
}

/** Extract a <meta name="description"> / og:description value, if present. */
function metaDescription(html) {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return htmlToText(m[1]).trim();
  }
  return '';
}

/** Extract a clean <title> from page HTML. */
function pageTitle(html) {
  const raw = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  return htmlToText(raw);
}

/** Extract the first <h1>/<h2> heading text, if any. */
function firstHeading(html) {
  const m = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  return m ? htmlToText(m[1]) : '';
}


/**
 * @param {object} source jobboards source entry ({ urls: string[] })
 * @param {object} ctx
 * @returns {Promise<{ jobs: object[], errors: Array<{url: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = safeFetch, rateLimiter, maxRetries = 3 } = ctx;
  const urls = Array.isArray(source.urls) ? source.urls : [];
  const jobs = [];
  const errors = [];

  for (const url of urls) {
    try {
      if (rateLimiter) await rateLimiter.wait('genericPublicPage', source.rateLimitMs);
      const found = await fetchUrl(url, { fetchImpl, source: source.id ?? 'public', maxRetries });
      jobs.push(...found);
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }
  return { jobs, errors };
}
