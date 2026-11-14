/**
 * Board tokens are never shown, or written into a letter, as an employer's
 * name (audit BUG-13) — and cleaning a name never changes a job's id.
 */
import { describe, it, expect } from 'vitest';
import { displayCompany, looksLikeSlug } from '../../src/utils/companyName.js';
import { normalizeJob, makeJobId } from '../../src/search/normalize.js';

describe('displayCompany', () => {
  it('turns board tokens into names', () => {
    expect(displayCompany('shieldai')).toBe('Shield AI');
    expect(displayCompany('capitalone')).toBe('Capital One');
    expect(displayCompany('openai')).toBe('OpenAI');
    expect(displayCompany('zoox')).toBe('Zoox');
    expect(displayCompany('lyrahealth')).toBe('Lyra Health');
    expect(displayCompany('apex-technology-inc')).toBe('Apex Technology Inc.');
    expect(displayCompany('anavationllc')).toBe('Anavation LLC');
  });

  it('leaves names a person or employer wrote exactly as written', () => {
    for (const name of ['eBay', 'dbt Labs', 'Acme Corp', 'Capital One', 'blueStone', 'Northwind & Co.', '', 'x']) {
      expect(displayCompany(name)).toBe(name);
    }
    expect(looksLikeSlug('Acme')).toBe(false);
    expect(looksLikeSlug('acme-corp')).toBe(true);
  });
});

describe('ingestion', () => {
  it('shows the cleaned name but keys the job by the name the source gave', () => {
    const raw = { source: 'lever', company: 'shieldai', title: 'Data Engineer', sourceJobId: 'abc' };
    const job = normalizeJob(raw);
    expect(job.company).toBe('Shield AI');
    expect(job.id).toBe(makeJobId({ source: 'lever', company: 'shieldai', title: 'Data Engineer', sourceJobId: 'abc' }));
  });
});
