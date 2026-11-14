/**
 * Employer display names from ATS board slugs (audit BUG-13).
 *
 * When a Greenhouse, Lever or Ashby posting carries no organisation name, the
 * adapters fall back to the board's URL token: `shieldai`, `capitalone`,
 * `lyrahealth`. Those reached the board, the Applications cards and, worst,
 * the cover letter ("…the Data Engineer role at shieldai").
 *
 * Only a name that LOOKS like a slug is touched — lowercase letters, digits,
 * hyphens or underscores, no spaces, no capitals. Anything a person or an
 * employer wrote ("eBay", "dbt Labs", "Acme Corp") is returned unchanged.
 *
 * Deterministic and dependency-free. Job ids are computed from the RAW name
 * (see normalizeJob), so changing how a name is shown never re-keys a job.
 */

/** Slugs whose brand casing cannot be derived by rule. Public company names only. */
const BRANDS = Object.freeze({
  openai: 'OpenAI',
  shieldai: 'Shield AI',
  capitalone: 'Capital One',
  clickhouse: 'ClickHouse',
  clickup: 'ClickUp',
  spoton: 'SpotOn',
  gopuff: 'Gopuff',
  thinkahead: 'AHEAD',
  matchgroup: 'Match Group',
  lyrahealth: 'Lyra Health',
  extremenetworks: 'Extreme Networks',
  gendigital: 'Gen Digital',
  'gen-digital': 'Gen Digital',
  doordash: 'DoorDash',
  databricks: 'Databricks',
  hubspot: 'HubSpot',
  github: 'GitHub',
  gitlab: 'GitLab',
  linkedin: 'LinkedIn',
  paypal: 'PayPal',
  youtube: 'YouTube',
  servicenow: 'ServiceNow',
  launchdarkly: 'LaunchDarkly',
  pagerduty: 'PagerDuty',
  smartsheet: 'Smartsheet',
  mongodb: 'MongoDB',
  elevenlabs: 'ElevenLabs',
  scaleai: 'Scale AI',
  anduril: 'Anduril',
});

/** Words a concatenated slug commonly ends with, and how each is written. */
const TAIL_WORDS = Object.freeze({
  ai: 'AI', health: 'Health', networks: 'Networks', network: 'Network', group: 'Group',
  labs: 'Labs', lab: 'Lab', systems: 'Systems', technologies: 'Technologies', technology: 'Technology',
  software: 'Software', bank: 'Bank', capital: 'Capital', energy: 'Energy', security: 'Security',
  therapeutics: 'Therapeutics', bio: 'Bio', pharma: 'Pharma', cloud: 'Cloud', robotics: 'Robotics',
  digital: 'Digital', media: 'Media', financial: 'Financial', one: 'One', data: 'Data',
  analytics: 'Analytics', solutions: 'Solutions', partners: 'Partners', ventures: 'Ventures',
  inc: 'Inc.', llc: 'LLC', ltd: 'Ltd.', corp: 'Corp.', co: 'Co.',
});

/** Legal suffixes written as separate words. */
const WORD_CASE = Object.freeze({ inc: 'Inc.', llc: 'LLC', ltd: 'Ltd.', corp: 'Corp.', co: 'Co.', ai: 'AI', usa: 'USA', us: 'US', it: 'IT' });

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** Does `name` look like a board token rather than a written name? */
export function looksLikeSlug(name) {
  const s = String(name ?? '').trim();
  return s.length > 1 && SLUG.test(s) && /[a-z]/.test(s);
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const word = (w) => WORD_CASE[w] ?? cap(w);

/** Split a single concatenated token at one known tail word ("lyrahealth"). */
function splitTail(token) {
  for (const [tail, shown] of Object.entries(TAIL_WORDS)) {
    if (token.length > tail.length + 2 && token.endsWith(tail)) {
      return `${cap(token.slice(0, -tail.length))} ${shown}`;
    }
  }
  return cap(token);
}

/**
 * The name to show for an employer.
 * @param {unknown} name company as the source gave it
 * @returns {string}
 */
export function displayCompany(name) {
  const s = String(name ?? '').trim();
  if (!looksLikeSlug(s)) return s;
  if (BRANDS[s]) return BRANDS[s];
  const parts = s.split(/[-_]+/).filter(Boolean);
  if (parts.length > 1) return parts.map(word).join(' ');
  return splitTail(s);
}
