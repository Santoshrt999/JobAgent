/**
 * Indeed connector (public, limited).
 *
 * Reads ONLY public job posting pages supplied as URLs in config and parses
 * their schema.org JobPosting JSON-LD. No login, no search-UI automation, no
 * evasion. Indeed actively rate-limits and protects its search; we respect that
 * and require user-provided public posting URLs instead.
 */

import { fetchUrl } from './genericPublicPage.js';
import { safeFetch } from '../../utils/safeFetch.js';

export const adapterId = 'indeed';

/**
 * @param {object} source { urls?: string[], queries?: string[] }
 * @param {object} ctx
 * @returns {Promise<{ jobs: object[], errors: object[] }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = safeFetch, rateLimiter, maxRetries = 3 } = ctx;
  const jobs = [];
  const errors = [];
  const urls = Array.isArray(source.urls) ? source.urls : [];

  for (const url of urls) {
    try {
      if (rateLimiter) await rateLimiter.wait('indeed', source.rateLimitMs);
      const found = await fetchUrl(url, { fetchImpl, source: 'indeed', maxRetries });
      jobs.push(...found);
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  if (urls.length === 0 && (source.queries?.length ?? 0) > 0) {
    errors.push({
      note: 'Indeed query search is not automated (would require evasion). ' +
        'Provide public Indeed job URLs in jobboards.json `urls`.',
    });
  }
  return { jobs, errors };
}
