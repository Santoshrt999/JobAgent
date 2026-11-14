/**
 * LinkedIn connector (public, limited).
 *
 * Reads ONLY public LinkedIn job posting pages supplied as URLs in config and
 * parses their schema.org JobPosting JSON-LD (LinkedIn publishes this on public
 * /jobs/view/ pages). No login, no authenticated scraping, no evasion. Anything
 * behind authentication or that requires automating the feed is out of scope.
 */

import { fetchUrl } from './genericPublicPage.js';
import { safeFetch } from '../../utils/safeFetch.js';

export const adapterId = 'linkedin';

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
      if (rateLimiter) await rateLimiter.wait('linkedin', source.rateLimitMs);
      const found = await fetchUrl(url, { fetchImpl, source: 'linkedin', maxRetries });
      jobs.push(...found);
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  if (urls.length === 0 && (source.queries?.length ?? 0) > 0) {
    errors.push({
      note: 'LinkedIn query/feed search is not automated (requires login/evasion). ' +
        'Provide public LinkedIn /jobs/view/ URLs in jobboards.json `urls`.',
    });
  }
  return { jobs, errors };
}
