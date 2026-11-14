import { describe, it, expect } from 'vitest';
import { deduplicate, jdSimilarity, keyFor } from '../../src/search/deduplicator.js';
import { normalizeJob } from '../../src/search/normalize.js';

const job = (over) => normalizeJob({ source: 's', ...over });

describe('deduplicator', () => {
  it('drops same company+title+id duplicates, keeping richer JD', () => {
    const a = job({ company: 'Acme', title: 'SDE', sourceJobId: '1', jdText: 'short' });
    const b = job({ company: 'ACME', title: 'sde', sourceJobId: '1', jdText: 'a much longer description with detail' });
    const { unique, duplicates } = deduplicate([a, b]);
    expect(unique).toHaveLength(1);
    expect(unique[0].jdText).toContain('longer');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toBe('duplicate_in_batch');
  });

  it('keeps distinct jobs', () => {
    const a = job({ company: 'Acme', title: 'SDE', sourceJobId: '1' });
    const b = job({ company: 'Globex', title: 'SDE', sourceJobId: '2' });
    expect(deduplicate([a, b]).unique).toHaveLength(2);
  });

  it('collapses the same role posted across many locations (distinct ids)', () => {
    const cities = ['Houston, TX', 'Dallas, TX', 'New York, NY', 'Seattle, WA'];
    const jobs = cities.map((location, i) => job({
      company: 'Deloitte',
      title: 'ConvergeHEALTH - Data Operations Engineer',
      sourceJobId: `gh-${i}`,
      location,
      url: `https://deloitte.com/job/${i}`,
    }));
    const { unique, duplicates } = deduplicate(jobs);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(cities.length - 1);
    expect(duplicates.every((d) => d.reason === 'duplicate_in_batch')).toBe(true);
  });

  it('uses existsInDb to drop known jobs from prior runs', () => {
    const a = job({ company: 'Acme', title: 'SDE', sourceJobId: '1' });
    const known = new Set([keyFor(a)]);
    const { unique, duplicates } = deduplicate([a], { existsInDb: (_j, key) => known.has(key) });
    expect(unique).toHaveLength(0);
    expect(duplicates[0].reason).toBe('exists_in_db');
  });

  it('never merges different postings just because the company is missing', () => {
    const { unique } = deduplicate([
      { company: '', title: 'Data Engineer', url: 'https://a.example.com/1', source: 'adzuna' },
      { company: '', title: 'Data Engineer', url: 'https://b.example.com/2', source: 'adzuna' },
      { company: 'Acme', title: '', url: 'https://acme.example.com/3', source: 'json-ld' },
      { company: 'Acme', title: '', url: 'https://acme.example.com/4', source: 'json-ld' },
    ]);
    expect(unique).toHaveLength(4);
  });

  it('still collapses the same untitled posting by its URL', () => {
    const { unique } = deduplicate([
      { company: '', title: 'Data Engineer', url: 'https://a.example.com/1?utm_source=x', source: 'adzuna' },
      { company: '', title: 'Data Engineer', url: 'https://a.example.com/1', source: 'adzuna' },
    ]);
    expect(unique).toHaveLength(1);
  });
});

describe('distinct requisitions with the same title (P1-4)', () => {
  const platformJd = 'We are hiring a data engineer for our platform team to build streaming pipelines with Kafka and Flink, '
    + 'own the ingestion layer, operate Airflow, partner with analytics on modeling, and improve reliability, observability, '
    + 'cost and on-call health across the data platform. You will design schemas, review code, mentor engineers and write '
    + 'design documents for new ingestion sources while keeping latency low for downstream consumers in finance and sales.';
  const marketingJd = 'Join the marketing analytics group as a data engineer: build the customer data warehouse in Snowflake '
    + 'with dbt, integrate ad platforms and the CRM, deliver attribution and lifetime value models to marketers, maintain '
    + 'Looker dashboards, run experiments with the growth team, and own data quality checks for campaign reporting. You '
    + 'will work closely with product marketing, sales operations and finance to answer questions about spend and return.';
  const job = (id, jdText, extra = {}) => ({
    id: `greenhouse:${id}`, source: 'greenhouse', sourceJobId: id, company: 'Acme', title: 'Data Engineer',
    location: 'Remote, US', url: `https://boards.greenhouse.io/acme/jobs/${id}`, jdText, ...extra,
  });

  it('keeps two openings with different ids and different descriptions', () => {
    const { unique } = deduplicate([job('1', platformJd), job('2', marketingJd)]);
    expect(unique.map((j) => j.sourceJobId).sort()).toEqual(['1', '2']);
  });

  it('still collapses one role posted in many cities (different ids, same description)', () => {
    const cities = ['Austin, TX', 'Denver, CO', 'Chicago, IL', 'Remote, US'];
    const { unique, duplicates } = deduplicate(cities.map((c, i) => job(String(i + 10), platformJd, { location: c })));
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(3);
  });

  it('merges when a description is missing or a stub (no evidence they differ)', () => {
    expect(deduplicate([job('1', platformJd), job('2', '')]).unique).toHaveLength(1);
    expect(deduplicate([job('1', platformJd), job('2', 'See our website.')]).unique).toHaveLength(1);
  });

  it('merges the same id, and copies from different sources', () => {
    expect(deduplicate([job('1', platformJd), job('1', marketingJd)]).unique).toHaveLength(1);
    expect(deduplicate([job('1', platformJd), job('2', marketingJd, { source: 'lever' })]).unique).toHaveLength(1);
  });

  it('dedupes each kept opening against its own copies', () => {
    const { unique } = deduplicate([
      job('1', platformJd), job('2', marketingJd),
      job('3', platformJd, { location: 'Denver, CO' }), job('4', marketingJd, { location: 'Austin, TX' }),
    ]);
    expect(unique).toHaveLength(2);
  });

  it('can be switched off (the old company + title behaviour)', () => {
    expect(deduplicate([job('1', platformJd), job('2', marketingJd)], { splitRequisitions: false }).unique).toHaveLength(1);
  });

  it('measures description similarity', () => {
    expect(jdSimilarity(platformJd, platformJd)).toBe(1);
    expect(jdSimilarity(platformJd, marketingJd)).toBeLessThan(0.1);
  });
});
