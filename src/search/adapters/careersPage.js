/**
 * Company careers-page discovery (public, compliant).
 *
 * Discovers jobs for a configured list of companies using ONLY public surfaces:
 *
 *   1. ATS-typed entries delegate to the existing official-API adapters:
 *        { ats: 'greenhouse', slug }                       -> greenhouse adapter
 *        { ats: 'lever', slug }                            -> lever adapter
 *        { ats: 'workday', host, tenant, site, ... }       -> workday CXS adapter
 *   2. { careersUrl } : fetch the public careers/listing page, extract job-posting
 *        links, and parse each via the public JSON-LD reader.
 *   3. { sitemap } : fetch a public sitemap.xml (or sitemap index), keep job-like
 *        <loc> URLs, and parse each via the public JSON-LD reader.
 *
 * Hard safety rules:
 *   - Public pages only. No login, no CAPTCHA solving, no private endpoints.
 *   - If a fetch returns 401/403/429 or a challenge page, it is treated as
 *     BLOCKED: the entry is logged and SKIPPED. We never attempt to bypass it.
 *   - Per-company link/URL caps prevent runaway crawls.
 */

import { fetchUrl } from './genericPublicPage.js';
import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as workday from './workday.js';
import * as ashby from './ashby.js';
import * as smartrecruiters from './smartrecruiters.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, discoveryHeaders } from '../../utils/httpClient.js';
import { safeFetch } from '../../utils/safeFetch.js';

export const adapterId = 'careers';

/** Default and hard ceiling on links/URLs fetched per company. */
const DEFAULT_MAX_LINKS = 50;
const MAX_LINKS_CEILING = 200;
/** How many nested sitemaps from a sitemap index we will follow (one level). */
const MAX_NESTED_SITEMAPS = 25;
/** Default number of companies processed in parallel. */
const DEFAULT_COMPANY_CONCURRENCY = 6;
/** Default number of posting URLs parsed in parallel within one company. */
const DEFAULT_LINK_CONCURRENCY = 4;

/**
 * @param {object} source jobboards entry: { companies: object[], maxLinksPerCompany?: number }
 * @param {object} ctx adapter context (fetchImpl, rateLimiter, maxRetries)
 * @returns {Promise<{ jobs: object[], errors: Array<object>, cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const companies = Array.isArray(source.companies) ? source.companies : [];
  const maxLinks = clampInt(source.maxLinksPerCompany, DEFAULT_MAX_LINKS, MAX_LINKS_CEILING);
  const concurrency = ctx.boardConcurrency ?? DEFAULT_COMPANY_CONCURRENCY;
  const jobs = [];
  const errors = [];
  let cancelled = false;

  // Companies are independent public sites, so they run in parallel (bounded)
  // like every other adapter. This used to be a sequential `for...of`, which
  // made the source unusably slow at any real list size — and it is the source
  // the harvester grows to hundreds of entries. The shared host gate in ctx is
  // what keeps the fan-out polite.
  const perCompany = await mapWithConcurrency(companies, concurrency, async (company) => {
    if (ctx.shouldCancel?.()) { cancelled = true; return null; }
    try {
      return await runCompany(company, source, ctx, maxLinks);
    } catch (err) {
      // A single company must never crash discovery for the rest.
      return { jobs: [], errors: [{ company: companyLabel(company), error: err.message }] };
    }
  });

  for (const r of perCompany) {
    if (!r) continue;
    jobs.push(...r.jobs);
    errors.push(...r.errors);
  }

  if (companies.length === 0) {
    errors.push({
      note: 'careers source enabled but no companies configured. Add entries to ' +
        '`companies` like { ats: "greenhouse", slug: "acme" } or { careersUrl: "..." } ' +
        'or { sitemap: "https://company.com/sitemap.xml" }.',
    });
  }

  return { jobs, errors, cancelled };
}

/** Discover one company entry by its declared (or inferred) strategy. */
async function runCompany(company = {}, source, ctx, maxLinks) {
  const ats = String(company.ats ?? '').trim().toLowerCase();

  // 1. Delegate ATS-typed entries to the official-API adapters (reuse + reliable).
  if (ats === 'greenhouse') {
    return tagDelegated(await greenhouse.run(
      { boards: [company.slug ?? company.token].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }
  if (ats === 'lever') {
    return tagDelegated(await lever.run(
      { boards: [company.slug].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }
  if (ats === 'workday') {
    return tagDelegated(await workday.run(
      {
        tenants: [{
          host: company.host,
          tenant: company.tenant ?? company.slug,
          site: company.site,
          locale: company.locale,
          pageSize: company.pageSize,
          searchText: company.searchText,
        }],
        rateLimitMs: source.rateLimitMs,
      },
      ctx,
    ), company);
  }
  // Ashby and SmartRecruiters have official public board APIs and adapters too;
  // omitting them here forced those companies down the HTML-scraping path for
  // no reason.
  if (ats === 'ashby') {
    return tagDelegated(await ashby.run(
      { boards: [company.slug ?? company.token].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }
  if (ats === 'smartrecruiters') {
    return tagDelegated(await smartrecruiters.run(
      { boards: [company.slug ?? company.token].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }

  // 2. Public careers/listing page -> extract links -> parse each.
  if (company.careersUrl) {
    return fromCareersPage(company, source, ctx, maxLinks);
  }

  // 3. Public sitemap.xml -> job-like locs -> parse each.
  if (company.sitemap) {
    return fromSitemap(company, source, ctx, maxLinks);
  }

  return { jobs: [], errors: [{ company: companyLabel(company), error: 'no ats/careersUrl/sitemap specified' }] };
}

/** Strategy 2: scrape job links off a public careers page, then parse each. */
async function fromCareersPage(company, source, ctx, maxLinks) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const errors = [];

  if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
  const page = await fetchPage(company.careersUrl, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
  if (page.blocked) {
    return { jobs: [], errors: [{ company: companyLabel(company), url: company.careersUrl, error: `blocked (${page.reason}); skipped` }] };
  }
  if (page.error) {
    return { jobs: [], errors: [{ company: companyLabel(company), url: company.careersUrl, error: page.error }] };
  }

  const links = extractJobLinks(page.html, company.careersUrl, maxLinks);
  if (links.length === 0) {
    errors.push({ company: companyLabel(company), url: company.careersUrl, note: 'no job-like links found on careers page' });
  }
  const jobs = await parseLinks(links, company, source, ctx, errors);
  return { jobs, errors };
}

/** Strategy 3: read a public sitemap (or sitemap index), then parse job-like URLs. */
async function fromSitemap(company, source, ctx, maxLinks) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const errors = [];

  if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
  const root = await fetchPage(company.sitemap, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
  if (root.blocked) {
    return { jobs: [], errors: [{ company: companyLabel(company), url: company.sitemap, error: `blocked (${root.reason}); skipped` }] };
  }
  if (root.error) {
    return { jobs: [], errors: [{ company: companyLabel(company), url: company.sitemap, error: root.error }] };
  }

  let urls = [];
  if (isSitemapIndex(root.html)) {
    // Follow nested sitemaps one level deep.
    const nested = extractLocs(root.html).slice(0, MAX_NESTED_SITEMAPS);
    for (const sm of nested) {
      if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
      const child = await fetchPage(sm, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
      if (child.blocked || child.error) {
        errors.push({ company: companyLabel(company), url: sm, error: child.blocked ? `blocked (${child.reason}); skipped` : child.error });
        continue;
      }
      urls.push(...extractLocs(child.html));
    }
  } else {
    urls = extractLocs(root.html);
  }

  const jobUrls = dedupe(urls.filter(isJobLikeUrl)).slice(0, maxLinks);
  if (jobUrls.length === 0) {
    errors.push({ company: companyLabel(company), url: company.sitemap, note: 'no job-like URLs found in sitemap' });
  }
  const jobs = await parseLinks(jobUrls, company, source, ctx, errors);
  return { jobs, errors };
}

/** Parse a list of public posting URLs via the JSON-LD reader, tagging company. */
async function parseLinks(urls, company, source, ctx, errors) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const concurrency = ctx.detailConcurrency ?? DEFAULT_LINK_CONCURRENCY;
  const jobs = [];

  const perUrl = await mapWithConcurrency(urls, concurrency, async (url) => {
    if (ctx.shouldCancel?.()) return null;
    try {
      if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
      const found = await fetchUrl(url, {
        fetchImpl, source: 'careers', maxRetries, requestTimeoutMs, hostGate,
      });
      for (const job of found) {
        job.rawMetadata = { ...(job.rawMetadata ?? {}), company: company.name ?? job.company, via: 'careers' };
        if (!job.company && company.name) job.company = company.name;
      }
      return { jobs: found, error: null };
    } catch (err) {
      return { jobs: [], error: { company: companyLabel(company), url, error: err.message } };
    }
  });

  for (const r of perUrl) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return jobs;
}

/** Stamp delegated ATS results with the careers provenance (source unchanged). */
function tagDelegated(result, company) {
  const jobs = (result.jobs ?? []).map((job) => ({
    ...job,
    rawMetadata: { ...(job.rawMetadata ?? {}), via: 'careers', careersCompany: company.name ?? null },
  }));
  return { jobs, errors: result.errors ?? [] };
}

/**
 * Fetch a page's raw text, classifying common blocks instead of bypassing them.
 *
 * Carries the same request timeout and host gate as every other adapter: this
 * one visits arbitrary company domains, so it is the likeliest to meet a server
 * that accepts a connection and then never responds, and a hang here used to
 * stall the entire discovery run.
 *
 * @returns {Promise<{ html?: string, blocked?: boolean, reason?: string, error?: string }>}
 */
async function fetchPage(url, { fetchImpl, maxRetries, requestTimeoutMs, hostGate }) {
  const call = async () => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: discoveryHeaders({ Accept: 'text/html,application/xhtml+xml,application/xml' }) },
      requestTimeoutMs,
    );
    const status = res.status ?? 200;
    const body = await res.text();
    const reason = blockReason(status, body);
    if (reason) {
      // Do NOT retry or evade a block — surface it and stop for this URL.
      return { blocked: true, reason };
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${status} for ${url}`);
      e.status = status;
      throw e;
    }
    return { html: body };
  };
  try {
    return await withRetry(
      () => (hostGate ? hostGate.run(url, call) : call()),
      { maxRetries },
    );
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Return a short reason string if a response looks like a login/CAPTCHA/bot
 * block, else null. Detection only — we never try to defeat these.
 * @param {number} status
 * @param {string} body
 * @returns {string|null}
 */
export function blockReason(status, body = '') {
  if (status === 401) return 'http-401-unauthorized';
  if (status === 403) return 'http-403-forbidden';
  if (status === 429) return 'http-429-rate-limited';
  const b = String(body).toLowerCase();
  const markers = [
    ['captcha', 'captcha'],
    ['recaptcha', 'recaptcha'],
    ['hcaptcha', 'hcaptcha'],
    ['cf-challenge', 'cloudflare-challenge'],
    ['attention required', 'cloudflare-challenge'],
    ['verify you are human', 'human-verification'],
    ['are you a robot', 'human-verification'],
    ['enable javascript and cookies to continue', 'js-challenge'],
    ['access denied', 'access-denied'],
    ['please log in', 'login-wall'],
    ['sign in to continue', 'login-wall'],
  ];
  for (const [needle, reason] of markers) {
    if (b.includes(needle)) return reason;
  }
  return null;
}

/** Path/host fragments that strongly suggest a single job posting URL. */
const JOB_URL_HOST_HINTS = [
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'icims.com',
  'smartrecruiters.com', 'jobvite.com', 'ashbyhq.com',
];
// Deliberately excludes bare '/career'/'/careers/' — too generic, it matches
// marketing/landing pages (e.g. ".../pages/careers/topics/careers.html") that
// carry no posting. Every real hint here names something specific to an
// individual job page.
const JOB_URL_PATH_HINTS = [
  '/job/', '/jobs/', '/position', '/opening',
  '/vacancy', '/vacancies', '/req', 'gh_jid', 'jobid', 'requisition', '/apply',
  '/postings/', '/posting/', 'job_details', 'job-details', 'jobdetail',
];

/**
 * Decide if a URL looks like an individual job posting (heuristic, conservative).
 * @param {string} url
 * @returns {boolean}
 */
export function isJobLikeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.host.toLowerCase();
  const lowerPath = (parsed.pathname + parsed.search).toLowerCase();
  if (JOB_URL_HOST_HINTS.some((h) => host.includes(h))) return true;
  return JOB_URL_PATH_HINTS.some((p) => lowerPath.includes(p));
}

/**
 * Extract distinct job-like links from careers-page HTML, resolved to absolute
 * URLs against the page's own URL.
 * @param {string} html
 * @param {string} baseUrl
 * @param {number} maxLinks
 * @returns {string[]}
 */
export function extractJobLinks(html, baseUrl, maxLinks = DEFAULT_MAX_LINKS) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  // A listing page commonly links back to ITSELF with different search/filter
  // query params (pagination, sort, facets). Same path + different query is
  // never a distinct job posting, so it is excluded regardless of query string
  // — without this, a search-results page's own filter links get scraped as
  // if each one were a separate job.
  let basePath = null;
  try {
    const b = new URL(baseUrl);
    basePath = `${b.origin}${b.pathname.replace(/\/+$/, '')}`;
  } catch { /* leave null; nothing to compare against */ }
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('javascript:')) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    if (!isJobLikeUrl(abs)) continue;
    const norm = abs.split('#')[0];
    if (seen.has(norm)) continue;
    if (basePath) {
      const candidatePath = `${new URL(norm).origin}${new URL(norm).pathname.replace(/\/+$/, '')}`;
      if (candidatePath === basePath) continue;
    }
    seen.add(norm);
    out.push(norm);
    if (out.length >= maxLinks) break;
  }
  return out;
}

/** Extract all <loc> URLs from sitemap XML. */
export function extractLocs(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = decodeXmlEntities(m[1].trim());
    if (url) out.push(url);
  }
  return out;
}

/** True if the XML is a sitemap index (points at other sitemaps). */
export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml ?? ''));
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function companyLabel(company) {
  return company?.name ?? company?.slug ?? company?.tenant ?? company?.careersUrl ?? company?.sitemap ?? null;
}

function clampInt(value, fallback, ceiling) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), ceiling);
}
