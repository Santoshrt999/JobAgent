/**
 * Dice connector (public, limited).
 *
 * Dice is a sponsorship-friendly source. This connector ONLY reads public job
 * posting pages provided as URLs in config and parses their schema.org
 * JobPosting JSON-LD. It does NOT log in, automate the search UI, or evade any
 * protection. Query-based discovery requires the user to supply public posting
 * URLs (see config jobboards `urls`).
 */

import { fetchUrl } from './genericPublicPage.js';
import { safeFetch } from '../../utils/safeFetch.js';

export const adapterId = 'dice';

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
      if (rateLimiter) await rateLimiter.wait('dice', source.rateLimitMs);
      const found = await fetchUrl(url, { fetchImpl, source: 'dice', maxRetries });
      jobs.push(...found);
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  if (urls.length === 0 && (source.queries?.length ?? 0) > 0) {
    errors.push({
      note: 'Dice query search is not automated (would require evasion/login). ' +
        'Provide public Dice job URLs in jobboards.json `urls`.',
    });
  }
  return { jobs, errors };
}
