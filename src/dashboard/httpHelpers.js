/**
 * HTTP helpers shared by the dashboard server and its route modules
 * (src/dashboard/routes/*): JSON responses, request bodies, security headers,
 * static files and small request validators. Moved out of server.js unchanged.
 */
import { isDocxBuffer } from '../resume/docxText.js';
import { isPublicHttpUrl } from '../utils/publicUrl.js';
import { gzipSync } from 'node:zlib';

/** Phases the dashboard may trigger. Submission is intentionally absent. */
export const RUN_PHASES = new Set(['discover', 'score', 'prepare']);

/** Bound user-triggered batches so one local request cannot monopolize the UI. */
export const MAX_BATCH_JOBS = 200;

/** Largest board page a request may ask for (the UI offers up to 500). */
export const MAX_JOBS_PAGE = 1000;

/** A Word resume is tens of KB; anything near this is not a resume. */
export const MAX_MASTER_RESUME_BYTES = 8 * 1024 * 1024;

/** Upload body cap: base64 inflates the payload by ~4/3, plus JSON overhead. */
export const MAX_UPLOAD_BODY_BYTES = 12 * 1024 * 1024;

/** /api/runs page size: default and ceiling. */
export const RUNS_DEFAULT_LIMIT = 20;

export const RUNS_MAX_LIMIT = 100;

/**
 * One run_log row as /api/runs reports it: the raw columns (kept for existing
 * readers) plus a camelCase summary — counters grouped, the per-source table
 * parsed, and an error COUNT so a list can flag a bad run without parsing.
 *
 * @param {object} row listRunLogs() row
 * @returns {object}
 */
export function runSummary(row = {}) {
  const counters = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('jobs_') && value !== null && value !== undefined) counters[key] = Number(value);
  }
  let perSource = [];
  try { perSource = row.per_source ? JSON.parse(row.per_source) : []; } catch { perSource = []; }
  let errorCount = 0;
  if (row.errors) {
    try {
      const parsed = JSON.parse(row.errors);
      errorCount = Array.isArray(parsed) ? parsed.reduce((n, e) => n + (Number(e?.count) || 1), 0) : 1;
    } catch { errorCount = 1; }
  }
  const { per_source: _perSource, ...raw } = row;
  return {
    ...raw,
    runId: row.run_id ?? null,
    mode: row.mode ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    durationMs: row.durationMs ?? null,
    counters,
    perSource: Array.isArray(perSource) ? perSource : [],
    errorCount,
  };
}

/* ------------------------------- helpers --------------------------------- */

/** Hostnames that mean "this machine's browser talking to its own dashboard". */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Is this Origin header acceptable for a state-changing request? Absent means
 * a same-origin/non-browser client (fetch/curl); "null" is an opaque origin
 * (sandboxed iframe, file://) and is rejected like any foreign site.
 * @param {string|undefined} origin
 */
export function isAllowedOrigin(origin, port) {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
    // Loopback is not one origin: a dev server or another local app on
    // 127.0.0.1:3000 is a different site, and its "simple" text/plain POST
    // reaches us without a CORS preflight. When the caller knows our port,
    // only a page served from THIS dashboard may change state.
    if (port === undefined) return true;
    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return originPort === String(port);
  } catch {
    return false;
  }
}

/** JSON bodies at least this large are gzipped when the client accepts it. */
export const GZIP_MIN_BYTES = 64 * 1024;

/** Does the request that produced `res` accept gzip? */
export function acceptsGzip(res) {
  return /\bgzip\b/i.test(String(res.req?.headers?.['accept-encoding'] ?? ''));
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  // Measured live: a default 100-row board page is ~210 KB and the full stats
  // payload is larger; gzip cuts JSON like this ~8x for a few ms of CPU.
  if (text.length >= GZIP_MIN_BYTES && acceptsGzip(res)) {
    const zipped = gzipSync(text);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      vary: 'Accept-Encoding',
      'content-length': zipped.length,
    });
    res.end(zipped);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

export function setExtensionCors(res, origin) {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-job-agent-key');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'Origin');
}

export function isAggregatorUrl(value) {
  try {
    return /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter)\./i.test(new URL(value).hostname);
  } catch { return false; }
}

/**
 * A URL is only an application URL if it is a PUBLIC http(s) address. Delegates
 * to the shared guard so this endpoint, the link-replacement endpoint, and
 * add-url all reject the same things (loopback, RFC-1918, link-local/metadata,
 * internal hostnames, embedded credentials).
 */
export function isSafeObservedApplicationUrl(value) {
  return isPublicHttpUrl(value);
}

export function batchJobIds(value) {
  const ids = Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
    : [];
  if (ids.length > MAX_BATCH_JOBS) {
    throw Object.assign(new Error(`batch is limited to ${MAX_BATCH_JOBS} jobs`), { statusCode: 400 });
  }
  return ids;
}

/**
 * Read and parse a JSON request body (empty body -> {}).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes=1e6] cap for this route. Only the master-resume
 *   upload raises it; every other endpoint keeps the small default so a stray
 *   local request cannot make the dashboard buffer megabytes.
 */
/**
 * A resume sent as base64 JSON ({ contentBase64 }) -> its bytes, or a 400.
 * Same checks as the master-resume upload: strict base64 (Buffer.from would
 * silently drop bad characters), the size cap, and a real .docx.
 */
export function decodeResumeUpload(body = {}) {
  const encoded = String(body.contentBase64 ?? '');
  const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
  if (!encoded) fail('no file contents were received');
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) fail('the file contents were not transferred correctly, try again');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_MASTER_RESUME_BYTES) fail(`that file is over ${Math.round(MAX_MASTER_RESUME_BYTES / 1024 / 1024)} MB`, 413);
  if (!isDocxBuffer(bytes)) fail('that is not a Word (.docx) file — save it as .docx and try again');
  return bytes;
}

export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    const fail = (message, statusCode) => reject(Object.assign(new Error(message), { statusCode }));
    req.on('data', (chunk) => {
      if (tooLarge) {
        // Keep DRAINING an over-sized body instead of destroying the socket.
        // Killing it here meant the browser reported a generic network failure
        // and never saw the 413 that explains what to do about it.
        size += chunk.length;
        // A client that keeps streaming far past the limit is not a mistake.
        if (size > maxBytes * 4) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks = []; // release what was buffered
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      if (tooLarge) return fail('body too large', 413);
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) return resolve({});
      let parsed;
      try { parsed = JSON.parse(data); }
      catch { return fail('invalid JSON body', 400); }
      // Every route reads fields off the body; a bare `null` or `42` would
      // surface as a TypeError (500) instead of a clear 400.
      if (parsed === null || typeof parsed !== 'object') return fail('JSON body must be an object', 400);
      resolve(parsed);
    });
    req.on('error', (err) => reject(err));
    req.on('aborted', () => fail('the request was interrupted before it finished', 400));
  });
}
