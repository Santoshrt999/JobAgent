/**
 * docs/SUPPORT_MATRIX.md is the honest capability statement, so its
 * "On by default" column must agree with config/jobboards.json. It drifted
 * twice (Adzuna "enabled by default" while disabled; Oracle "0 rows" while
 * producing); this test catches the first kind mechanically.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const matrix = readFileSync(new URL('../../docs/SUPPORT_MATRIX.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const jobboards = JSON.parse(readFileSync(new URL('../../config/jobboards.json', import.meta.url), 'utf8'));
const enabled = new Map(jobboards.sources.map((s) => [s.id, s.enabled === true]));

/** Matrix row name -> the config source ids it describes. */
const ROWS = {
  Greenhouse: ['greenhouse-boards'],
  Lever: ['lever-boards'],
  Ashby: ['ashby-boards'],
  SmartRecruiters: ['smartrecruiters-companies'],
  '**Workable — all companies**': ['ats-search'],
  '**SmartRecruiters — all companies**': ['ats-search'],
  '**Adzuna**': ['adzuna-aggregator'],
  Workday: ['workday-public'],
  iCIMS: ['icims-portals'],
  Rippling: ['rippling-boards'],
  'Amazon Jobs': ['amazon-jobs'],
  'Oracle Recruiting': ['oracle-recruiting'],
  'The Muse': ['ats-search'],
  'Company career pages': ['company-careers'],
  'LinkedIn — direct': ['linkedin-public'],
  'Indeed — direct': ['indeed-public'],
  'Dice — direct': ['dice-public'],
  'LinkedIn / Indeed / Dice / Glassdoor — via Apify provider': ['apify-scrapers', 'apify-linkedin'],
  'Manual CSV / Add-by-URL': ['manual-urls'],
};

function discoveryRows() {
  const start = matrix.indexOf('| Source | Kind | On by default |');
  expect(start, 'discovery table header').toBeGreaterThan(-1);
  const rows = [];
  for (const line of matrix.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ name: cells[0], onByDefault: cells[2] });
  }
  return rows;
}

describe('support matrix agrees with config (P2-8)', () => {
  it('states a default for every mapped source, matching jobboards.json', () => {
    const rows = discoveryRows();
    for (const [name, ids] of Object.entries(ROWS)) {
      const row = rows.find((r) => r.name === name);
      expect(row, `matrix row "${name}"`).toBeTruthy();
      for (const id of ids) expect(enabled.has(id), `config source ${id}`).toBe(true);
      const configOn = ids.some((id) => enabled.get(id));
      const docOn = /^yes\b/i.test(row.onByDefault);
      expect(docOn, `${name}: matrix says "${row.onByDefault}", config enabled=${configOn}`).toBe(configOn);
    }
  });

  it('describes every configured source somewhere in the table', () => {
    const covered = new Set(Object.values(ROWS).flat());
    for (const id of enabled.keys()) {
      if (id === 'generic-public-pages') continue; // the reader behind Add-by-URL, not a discovery source
      expect(covered.has(id), `config source ${id} has no matrix row`).toBe(true);
    }
  });

  it('no longer claims Adzuna is on by default', () => {
    expect(matrix).not.toMatch(/now\s+enabled by default/);
  });
});
