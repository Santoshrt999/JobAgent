/**
 * Manual URLs connector — highest priority, fully compliant source.
 *
 * Two inputs:
 *  1. `urls`: user-provided public job URLs (parsed via the generic public-page
 *     JSON-LD reader).
 *  2. `options.csvImportPath`: a CSV the user exports/curates manually, with
 *     columns matching the normalized job fields.
 *
 * Nothing here logs in, scrapes search results, or evades protections.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { normalizeJob, parseCsv } from '../normalize.js';
import { fetchUrl } from './genericPublicPage.js';
import { safeFetch } from '../../utils/safeFetch.js';

export const adapterId = 'manualUrls';

/** CSV header -> normalized field. */
const CSV_FIELD_MAP = {
  source: 'source',
  sourcejobid: 'sourceJobId',
  source_job_id: 'sourceJobId',
  company: 'company',
  title: 'title',
  location: 'location',
  url: 'url',
  jd: 'jdText',
  jdtext: 'jdText',
  jd_text: 'jdText',
  description: 'jdText',
  postedat: 'postedAt',
  posted_at: 'postedAt',
  applicantcount: 'applicantCount',
  applicant_count: 'applicantCount',
  employmenttype: 'employmentType',
  employment_type: 'employmentType',
};

/**
 * @param {object} source jobboards entry: { urls?: string[], options?: { csvImportPath?: string } }
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {(p: string, enc: string) => string} [ctx.readFileImpl]
 * @param {string} [ctx.root] project root for resolving relative CSV paths
 * @returns {Promise<{ jobs: object[], errors: Array<object> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = safeFetch, rateLimiter, readFileImpl = readFileSync, root = process.cwd(), maxRetries = 3 } = ctx;
  const jobs = [];
  const errors = [];

  // 1) CSV import (no network).
  const csvPath = source.options?.csvImportPath;
  if (csvPath) {
    try {
      const resolved = isAbsolute(csvPath) ? csvPath : join(root, csvPath);
      const text = readFileImpl(resolved, 'utf8');
      const { jobs: csvJobs, errors: csvErrors } = csvToJobsDetailed(text);
      jobs.push(...csvJobs);
      for (const e of csvErrors) errors.push({ csvPath, ...e });
    } catch (err) {
      // Missing CSV is non-fatal — user may only use URLs.
      if (err.code !== 'ENOENT') errors.push({ csvPath, error: err.message });
    }
  }

  // 2) Public URLs.
  for (const url of Array.isArray(source.urls) ? source.urls : []) {
    try {
      if (rateLimiter) await rateLimiter.wait('manualUrls', source.rateLimitMs);
      const found = await fetchUrl(url, { fetchImpl, source: 'manual', maxRetries });
      jobs.push(...found);
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  return { jobs, errors };
}

/** Convert manual CSV rows into normalized jobs (lenient; drops invalid rows). */
export function csvToJobs(text) {
  return csvToJobsDetailed(text).jobs;
}

/**
 * Convert manual CSV rows into normalized jobs, validating each row. Invalid
 * rows are reported (never thrown) so one bad line does not lose the whole file.
 *
 * A row is valid when it has a non-empty title AND at least one of url/company.
 *
 * @param {string} text raw CSV
 * @returns {{ jobs: object[], errors: Array<{ row: number, error: string, raw?: object }> }}
 */
export function csvToJobsDetailed(text) {
  const jobs = [];
  const errors = [];
  const rows = parseCsv(text);

  rows.forEach((row, i) => {
    const lineNo = i + 2; // +1 for header, +1 for 1-based line numbers
    const mapped = { source: 'manual' };
    for (const [key, value] of Object.entries(row)) {
      const field = CSV_FIELD_MAP[key.toLowerCase().trim()];
      if (field) mapped[field] = value;
    }
    const job = normalizeJob(mapped);
    const problem = validateManualJob(job);
    if (problem) {
      errors.push({ row: lineNo, error: problem, raw: { company: job.company, title: job.title, url: job.url } });
      return;
    }
    jobs.push(job);
  });

  return { jobs, errors };
}

/** Return a reason string if a manual job is malformed, else null. */
function validateManualJob(job) {
  if (!job.title) return 'missing title';
  if (!job.url && !job.company) return 'missing both url and company';
  return null;
}
