/**
 * Normalization helpers shared by all search adapters.
 *
 * Every adapter must return job objects with this exact shape so the rest of
 * the pipeline (dedup, exclusion, scoring) can rely on it:
 *   { source, sourceJobId, company, title, location, url, jdText,
 *     postedAt, applicantCount, employmentType, rawMetadata }
 *
 * Parsing here is dependency-free and conservative. JSON-LD JobPosting data is
 * the legitimate, public, structured metadata many job pages expose; we read it
 * rather than scraping rendered DOM or evading protections.
 */

import { dedupKey } from '../utils/textNormalize.js';
import { displayCompany } from '../utils/companyName.js';

/**
 * Coerce a raw partial job into the canonical normalized shape.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeJob(raw = {}) {
  const job = {
    source: str(raw.source),
    sourceJobId: str(raw.sourceJobId),
    company: str(raw.company),
    title: str(raw.title),
    location: str(raw.location),
    url: str(raw.url),
    jdText: str(raw.jdText),
    postedAt: raw.postedAt ? str(raw.postedAt) : null,
    applicantCount: numOrNull(raw.applicantCount),
    employmentType: str(raw.employmentType),
    rawMetadata: raw.rawMetadata && typeof raw.rawMetadata === 'object' ? raw.rawMetadata : {},
  };
  // Stable id used as the SQLite primary key. Computed from the name AS THE
  // SOURCE GAVE IT, before the display name below, so showing "Shield AI" for
  // the board token "shieldai" never re-keys a job already in the database.
  job.id = raw.id ? str(raw.id) : makeJobId(job);
  job.company = displayCompany(job.company);
  return job;
}

/**
 * Build a deterministic job id from source + dedup key.
 *
 * The id is the SQLite PRIMARY KEY, and `upsertJob` does ON CONFLICT DO UPDATE,
 * so two postings sharing an id do not both exist — the second silently
 * OVERWRITES the first. The id must therefore stay unique per posting.
 *
 * REGRESSION GUARD ON THE LENGTH CAP. This used to be a bare `.slice(0, 200)`.
 * `dedupKey` puts `sourceJobId` LAST, so it is exactly the discriminator that a
 * naive truncation cuts off: two different requisitions at a company with a
 * long name and a long shared title truncate to the same 200 chars and become
 * one row. 52 rows in the live database already sit exactly at that boundary,
 * so this was live, not theoretical. When the key is too long the tail is now
 * replaced by a short hash of the FULL key, which keeps ids bounded, stable
 * across runs, and still distinct.
 */
export function makeJobId(job) {
  const key = dedupKey({ company: job.company, title: job.title, sourceJobId: job.sourceJobId });
  const src = str(job.source) || 'src';
  const full = `${src}:${key}`;
  if (full.length <= 200) return full;
  const digest = fnv1a32(full);
  return `${full.slice(0, 200 - 9)}#${digest}`;
}

/**
 * Small, dependency-free 32-bit hash. Only needs to be deterministic and
 * well-spread for id disambiguation — not cryptographic.
 * @param {string} text
 * @returns {string} 8-char hex
 */
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Typographic entities common in job postings. (`amp` is decoded separately, last.) */
const NAMED_ENTITIES = {
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  trade: '™', reg: '®', copy: '©', deg: '°', euro: '€', pound: '£',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '',
};

/** A decoded code point, or the original entity text when it is not a valid one. */
function codePoint(n, original) {
  // `&#38;` is an encoded ampersand; leave it for the &amp;-last rule so it can
  // never combine with following text into a second, fake entity.
  if (n === 38) return '&amp;';
  return Number.isInteger(n) && n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF)
    ? String.fromCodePoint(n) : original;
}

/**
 * Strip HTML tags to readable plain text (dependency-free).
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    // Numeric and typographic entities. Left encoded, "can&#8217;t sponsor"
    // and "don&rsquo;t offer sponsorship" hid refusals from the sponsorship
    // reader, and keyword boundaries broke on "&ndash;"-joined terms.
    .replace(/&#(\d{1,7});/g, (m, dec) => codePoint(Number(dec), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, hex) => codePoint(parseInt(hex, 16), m))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    // &amp; is decoded LAST so "&amp;lt;" yields the literal text "&lt;"
    // instead of double-decoding into a fake "<" tag character.
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract schema.org JobPosting objects from a page's JSON-LD blocks.
 * Returns an array of normalized jobs (possibly empty).
 *
 * @param {string} html
 * @param {object} [ctx]
 * @param {string} [ctx.url]
 * @param {string} [ctx.source]
 * @returns {object[]}
 */
export function parseJsonLdJobs(html, { url = '', source = 'public' } = {}) {
  if (!html) return [];
  const blocks = extractJsonLdBlocks(html);
  const jobs = [];
  for (const block of blocks) {
    for (const node of flattenJsonLd(block)) {
      if (!isJobPosting(node)) continue;
      jobs.push(jobFromJsonLd(node, { url, source }));
    }
  }
  return jobs;
}

/** Pull raw JSON objects from <script type="application/ld+json"> blocks. */
export function extractJsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // Ignore malformed JSON-LD blocks rather than failing the whole parse.
    }
  }
  return out;
}

/** Flatten JSON-LD that may be an array or use @graph. */
function flattenJsonLd(block) {
  if (Array.isArray(block)) return block.flatMap(flattenJsonLd);
  if (block && typeof block === 'object') {
    if (Array.isArray(block['@graph'])) return block['@graph'].flatMap(flattenJsonLd);
    return [block];
  }
  return [];
}

function isJobPosting(node) {
  const t = node?.['@type'];
  if (!t) return false;
  return Array.isArray(t) ? t.includes('JobPosting') : t === 'JobPosting';
}

/** Map a JobPosting JSON-LD node to a normalized job. */
function jobFromJsonLd(node, { url, source }) {
  const org = node.hiringOrganization;
  const company = typeof org === 'string' ? org : org?.name ?? '';
  const loc = node.jobLocation;
  const address = Array.isArray(loc) ? loc[0]?.address : loc?.address;
  const location = formatAddress(address) || (node.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '');

  return normalizeJob({
    source,
    sourceJobId: str(node.identifier?.value ?? node.identifier ?? ''),
    company,
    title: node.title ?? '',
    location,
    url: node.url ?? url,
    jdText: htmlToText(node.description ?? ''),
    postedAt: node.datePosted ?? null,
    employmentType: Array.isArray(node.employmentType)
      ? node.employmentType.join(', ')
      : (node.employmentType ?? ''),
    rawMetadata: {
      jsonLd: true,
      validThrough: node.validThrough ?? null,
      // schema.org states the country explicitly. Carrying it through makes the
      // US-only gate decide on ground truth instead of trying to recognize a
      // city name — the failure mode that let offshore roles past a filter that
      // was switched on. Applies to every JSON-LD source (iCIMS, careers pages).
      ...(countryOf(address) ? { country: countryOf(address) } : {}),
    },
  });
}

/** The country named by a schema.org PostalAddress, if any. */
function countryOf(address) {
  if (!address || typeof address !== 'object') return '';
  const c = address.addressCountry;
  return str(typeof c === 'object' ? (c?.name ?? c?.identifier ?? '') : c);
}

function formatAddress(address) {
  if (!address || typeof address !== 'object') return '';
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .map((p) => (typeof p === 'object' ? p?.name : p))
    .filter(Boolean);
  return parts.join(', ');
}

/** Block/element opening tags whose inner content we may extract. */
const CONTAINER_TAGS = ['article', 'main', 'section', 'div'];

/** id/class keyword fragments that commonly wrap a job description. */
const JD_CONTAINER_HINTS = [
  'job-description', 'jobdescription', 'job_description',
  'job-details', 'jobdetails', 'job-detail',
  'posting-description', 'posting__description', 'posting-content',
  'description', 'job-post', 'jobpost', 'opening', 'content-job',
];

/**
 * Extract the most useful readable text from a job page using a layered set of
 * deterministic heuristics. Returns the chosen text and the method used so the
 * caller can record provenance.
 *
 * Order: known job-description container -> <article> -> <main> ->
 * largest meaningful text block -> whole stripped page text.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {number} [opts.minChars=200] minimum length to accept a richer method
 * @returns {{ text: string, method: 'container'|'article'|'main'|'largest-block'|'stripped'|'empty' }}
 */
export function extractReadableContent(html, { minChars = 200 } = {}) {
  if (!html || typeof html !== 'string') return { text: '', method: 'empty' };

  // 1. Known job-description containers (by id/class hint).
  const container = extractHintedContainer(html);
  if (container && container.length >= minChars) {
    return { text: container, method: 'container' };
  }

  // 2/3. Semantic <article> then <main>.
  for (const tag of ['article', 'main']) {
    const inner = firstElementText(html, tag);
    if (inner && inner.length >= minChars) {
      return { text: inner, method: tag };
    }
  }

  // 4. Largest meaningful text block (densest region of the stripped page).
  const block = largestTextBlock(html, minChars);
  if (block && block.length >= minChars) {
    return { text: block, method: 'largest-block' };
  }

  // 5. Whole stripped page text — only if it carries meaningful content.
  const stripped = htmlToText(html);
  if (stripped && wordCount(stripped) >= 12) return { text: stripped, method: 'stripped' };
  return { text: '', method: 'empty' };
}

/** Find the text of the first element whose id/class matches a JD hint. */
function extractHintedContainer(html) {
  const lower = html.toLowerCase();
  let best = '';
  /** [start, end) of every container already evaluated. */
  const spans = [];
  for (const hint of JD_CONTAINER_HINTS) {
    let from = 0;
    // Scan all occurrences of the hint; only accept ones inside an id/class attr
    // of a container tag, then slice that element's balanced inner HTML.
    for (;;) {
      const idx = lower.indexOf(hint, from);
      if (idx === -1) break;
      from = idx + hint.length;
      const tagStart = lower.lastIndexOf('<', idx);
      if (tagStart === -1) continue;
      const tagMatch = /^<([a-z0-9]+)\b/.exec(lower.slice(tagStart, idx + hint.length + 1));
      if (!tagMatch) continue;
      const tagName = tagMatch[1];
      if (!CONTAINER_TAGS.includes(tagName)) continue;
      const attrSlice = lower.slice(tagStart, lower.indexOf('>', tagStart) + 1);
      if (!/\b(id|class)\s*=/.test(attrSlice)) continue;
      // A container NESTED inside one already evaluated cannot win — its text is
      // a subset of the outer one's — and neither can the same element reached
      // through a second hint ("job-description" then "description"). Skipping
      // them removes the repeated slice + htmlToText that made pages with many
      // nested matching containers quadratic.
      if (spans.some(([s, e]) => tagStart >= s && tagStart < e)) continue;
      const inner = balancedInner(html, tagStart, tagName, lower);
      const contentStart = lower.indexOf('>', tagStart) + 1;
      spans.push([tagStart, contentStart + inner.length]);
      const text = htmlToText(inner);
      if (text.length > best.length) best = text;
    }
  }
  return best;
}

/** Text of the first <tag>...</tag> element (non-nesting-aware first match). */
function firstElementText(html, tagName) {
  const lower = html.toLowerCase();
  const open = lower.indexOf(`<${tagName}`);
  if (open === -1) return '';
  return htmlToText(balancedInner(html, open, tagName, lower));
}

/**
 * Return the inner HTML of an element starting at `openIndex`, balancing nested
 * same-name tags so we capture the full element.
 */
function balancedInner(html, openIndex, tagName, lowered = null) {
  // Callers pass their already-lowered copy: re-lowering the WHOLE page once
  // per hint hit made a page with many matching containers quadratic.
  const lower = lowered ?? html.toLowerCase();
  const openEnd = lower.indexOf('>', openIndex);
  if (openEnd === -1) return '';
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let i = openEnd + 1;
  const contentStart = i;
  while (i < html.length && depth > 0) {
    const nextOpen = lower.indexOf(openTag, i);
    const nextClose = lower.indexOf(closeTag, i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + openTag.length;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(contentStart, nextClose);
      i = nextClose + closeTag.length;
    }
  }
  return html.slice(contentStart);
}

/** Pick the densest contiguous region of stripped text (>= minWords blocks). */
function largestTextBlock(html, minChars) {
  const stripped = htmlToText(html);
  if (!stripped) return '';
  const blocks = stripped.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const meaningful = blocks.filter((b) => wordCount(b) >= 12);
  if (meaningful.length === 0) return '';
  const joined = meaningful.join('\n\n');
  if (joined.length >= minChars) return joined;
  // Otherwise return the single longest block.
  return meaningful.reduce((a, b) => (b.length > a.length ? b : a), '');
}

function wordCount(s) {
  return (s.match(/\b[\w'-]+\b/g) ?? []).length;
}

/**
 * Minimal RFC-4180-ish CSV parser. Returns array of row objects keyed by header.
 * @param {string} text
 * @returns {object[]}
 */
export function parseCsv(text) {
  if (!text || !text.trim()) return [];
  const rows = splitCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length && r.some((c) => c !== '')).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });
}

/** Split CSV text into rows of fields, honoring quotes. */
function splitCsvRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
