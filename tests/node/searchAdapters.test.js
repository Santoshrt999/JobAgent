import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as greenhouse from '../../src/search/adapters/greenhouse.js';
import * as lever from '../../src/search/adapters/lever.js';
import * as workday from '../../src/search/adapters/workday.js';
import * as careers from '../../src/search/adapters/careersPage.js';
import * as generic from '../../src/search/adapters/genericPublicPage.js';
import * as manualUrls from '../../src/search/adapters/manualUrls.js';
import * as apify from '../../src/search/adapters/apify.js';
import * as oracleRecruiting from '../../src/search/adapters/oracleRecruiting.js';
import * as amazonJobs from '../../src/search/adapters/amazonJobs.js';
import { runSearch } from '../../src/search/index.js';
import { adapterKind, sourceKind, isDiscoveryAdapter } from '../../src/search/sources.js';
import { extractReadableContent } from '../../src/search/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });
const htmlResponse = (html) => ({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

describe('greenhouse adapter', () => {
  it('maps official board API jobs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jobs: [{ id: 5, title: 'Senior Data Engineer', company_name: 'Acme',
        location: { name: 'Remote' }, absolute_url: 'http://x', content: '<p>Azure</p>',
        updated_at: '2026-05-30' }],
    }));
    const { jobs, errors } = await greenhouse.run({ boards: ['acme'] }, { fetchImpl });
    expect(errors).toHaveLength(0);
    expect(jobs[0]).toMatchObject({ source: 'greenhouse', title: 'Senior Data Engineer', company: 'Acme' });
    expect(jobs[0].jdText).toBe('Azure');
  });

  it('captures per-board errors without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const { jobs, errors } = await greenhouse.run({ boards: ['missing'] }, { fetchImpl, maxRetries: 0 });
    expect(jobs).toHaveLength(0);
    expect(errors[0].board).toBe('missing');
  });

  it('decodes the HTML-ESCAPED content the real board API returns', async () => {
    // The live Greenhouse boards API escapes `content` (&lt;p&gt;…&lt;/p&gt;);
    // the JD text must come out clean, with no literal tags left behind.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jobs: [{ id: 9, title: 'Data Engineer', company_name: 'Acme',
        location: { name: 'Remote' }, absolute_url: 'http://x',
        content: '&lt;p&gt;Build &amp;amp; run Azure pipelines&lt;/p&gt;&lt;ul&gt;&lt;li&gt;PySpark&lt;/li&gt;&lt;/ul&gt;' }],
    }));
    const { jobs } = await greenhouse.run({ boards: ['acme'] }, { fetchImpl });
    expect(jobs[0].jdText).not.toMatch(/<\/?(p|ul|li)>/);
    expect(jobs[0].jdText).toContain('Build & run Azure pipelines');
    expect(jobs[0].jdText).toContain('PySpark');
  });

  it('leaves already-unescaped content untouched', () => {
    expect(greenhouse.unescapeHtmlPayload('<p>Azure</p>')).toBe('<p>Azure</p>');
    expect(greenhouse.unescapeHtmlPayload('plain text, no markup')).toBe('plain text, no markup');
  });
});

describe('lever adapter', () => {
  it('maps official postings API jobs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([
      { id: 'abc', text: 'Lead Data Engineer', hostedUrl: 'http://l',
        categories: { location: 'Remote', commitment: 'Full-time' },
        descriptionPlain: 'PySpark', createdAt: 1716000000000 },
    ]));
    const { jobs } = await lever.run({ boards: ['acme'] }, { fetchImpl });
    expect(jobs[0]).toMatchObject({ source: 'lever', title: 'Lead Data Engineer', employmentType: 'Full-time' });
  });

  it('names the company from the board slug and keeps team in metadata (no dead branch)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([
      { id: 'x', text: 'Data Engineer', hostedUrl: 'http://l',
        categories: { location: 'Remote', team: 'Platform' }, descriptionPlain: 'SQL' },
    ]));
    const { jobs } = await lever.run({ boards: ['globex'] }, { fetchImpl });
    // The board token is shown as a name (BUG-13), never as "globex".
    expect(jobs[0].company).toBe('Globex');
    expect(jobs[0].rawMetadata.team).toBe('Platform');
  });
});

describe('workday adapter', () => {
  it('maps CXS postings into the normalized shape', async () => {
    const data = JSON.parse(fixture('workday_jobs.json'));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(data));
    const { jobs, errors } = await workday.run(
      { tenants: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', pageSize: 50, fetchDetails: false }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(errors).toHaveLength(0);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ source: 'workday', company: 'Acme', title: 'Senior Data Engineer' });
    expect(jobs[0].url).toContain('acme.wd1.myworkdayjobs.com');
    expect(jobs[0].jdText).toContain('Azure Databricks');
    expect(jobs[0].rawMetadata.summaryOnly).toBe(true);
  });

  it('paginates using limit/offset until total is reached', async () => {
    const page1 = { total: 2, jobPostings: [{ title: 'A', externalPath: '/x/A', bulletFields: ['R1'] }] };
    const page2 = { total: 2, jobPostings: [{ title: 'B', externalPath: '/x/B', bulletFields: ['R2'] }] };
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call += 1;
      return jsonResponse(call === 1 ? page1 : page2);
    });
    const { jobs } = await workday.run(
      { tenants: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', pageSize: 1, fetchDetails: false }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs.map((j) => j.title)).toEqual(['A', 'B']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a config error when host/tenant/site are missing (no throw)', async () => {
    const fetchImpl = vi.fn();
    const { jobs, errors } = await workday.run({ tenants: [{ tenant: 'acme' }] }, { fetchImpl });
    expect(jobs).toHaveLength(0);
    expect(errors[0].error).toMatch(/host, tenant, and site/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clamps pageSize to 20 (Workday public CXS rejects limit > 20 with HTTP 400)', async () => {
    let sentLimit = null;
    const fetchImpl = vi.fn().mockImplementation(async (_url, opts) => {
      sentLimit = JSON.parse(opts.body).limit;
      return jsonResponse({ total: 1, jobPostings: [{ title: 'A', externalPath: '/x/A', bulletFields: ['R1'] }] });
    });
    await workday.run(
      { tenants: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', pageSize: 30, fetchDetails: false }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(sentLimit).toBe(20);
  });

  it('uses the configured company display name (falls back to the tenant slug)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      total: 1, jobPostings: [{ title: 'Data Engineer', externalPath: '/x/DE', bulletFields: ['R1'] }],
    }));
    const { jobs } = await workday.run(
      { tenants: [{ host: 'tmobile.wd1.myworkdayjobs.com', tenant: 'tmobile', site: 'External', company: 'T-Mobile', fetchDetails: false }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs[0].company).toBe('T-Mobile');
  });

  it('captures HTTP errors without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { jobs, errors } = await workday.run(
      { tenants: [{ host: 'h', tenant: 't', site: 's' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(0);
    expect(errors[0].error).toMatch(/Workday HTTP 503/);
  });

  it('enriches the summary with the full JD from the public detail endpoint', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).endsWith('/jobs')) {
        return jsonResponse({ total: 1, jobPostings: [
          { title: 'Senior Data Engineer', externalPath: '/job/Remote/Senior-Data-Engineer_R-1', bulletFields: ['R-1'] },
        ] });
      }
      // Public per-job CXS detail endpoint returns the full description.
      return jsonResponse({ jobPostingInfo: {
        jobDescription: '<p>Build <b>Azure Databricks</b> medallion lakehouses with PySpark and Delta Lake. We sponsor H-1B.</p>',
        startDate: '2026-05-01', jobReqId: 'R-1',
      } });
    });
    const { jobs, errors } = await workday.run(
      { tenants: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', pageSize: 50 }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(errors).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jdText).toContain('Build Azure Databricks medallion lakehouses');
    expect(jobs[0].rawMetadata.summaryOnly).toBe(false);
    expect(jobs[0].rawMetadata.detailFetched).toBe(true);
    expect(jobs[0].rawMetadata.jobReqId).toBe('R-1');
    // One list call + one detail call.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to summaryOnly and reports when detail fetch is unavailable', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).endsWith('/jobs')) {
        return jsonResponse({ total: 1, jobPostings: [
          { title: 'Staff Data Engineer', externalPath: '/job/Remote/Staff_R-2', bulletFields: ['Azure', 'PySpark'] },
        ] });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { jobs, errors } = await workday.run(
      { tenants: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', pageSize: 50 }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawMetadata.summaryOnly).toBe(true);
    expect(jobs[0].rawMetadata.detailError).toMatch(/Workday detail HTTP 404/);
    // Summary JD is preserved as the fallback.
    expect(jobs[0].jdText).toContain('Azure');
    expect(errors[0].error).toMatch(/kept summaryOnly/);
  });

  it('fetches remaining list pages in parallel after learning the total', async () => {
    const seenOffsets = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      seenOffsets.push(body.offset);
      return jsonResponse({
        total: 6,
        jobPostings: Array.from({ length: 2 }, (_, i) => ({
          title: `Role ${body.offset + i}`,
          externalPath: `/x/Role-${body.offset + i}`,
          bulletFields: [`R${body.offset + i}`],
        })),
      });
    });
    const { jobs } = await workday.run(
      { tenants: [{ host: 'h.wd1.myworkdayjobs.com', tenant: 't', site: 's', pageSize: 2, fetchDetails: false }] },
      { fetchImpl, maxRetries: 0, pageConcurrency: 4 },
    );
    // total 6 / pageSize 2 => 3 pages at offsets 0, 2, 4 (gathered in any order).
    expect([...seenOffsets].sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect(jobs).toHaveLength(6);
  });

  it('fetches per-job details concurrently instead of serializing them', async () => {
    let detailInFlight = 0;
    let detailMaxInFlight = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).endsWith('/jobs')) {
        return jsonResponse({
          total: 4,
          jobPostings: Array.from({ length: 4 }, (_, i) => ({
            title: `Data Engineer ${i}`,
            externalPath: `/job/Remote/DE-${i}_R-${i}`,
            bulletFields: [`R-${i}`],
          })),
        });
      }
      detailInFlight += 1;
      detailMaxInFlight = Math.max(detailMaxInFlight, detailInFlight);
      await new Promise((r) => setTimeout(r, 5));
      detailInFlight -= 1;
      return jsonResponse({ jobPostingInfo: { jobDescription: '<p>Azure Databricks PySpark</p>' } });
    });
    const { jobs, errors } = await workday.run(
      { tenants: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', pageSize: 20 }], hostSpacingMs: 0 },
      { fetchImpl, maxRetries: 0, detailConcurrency: 4 },
    );
    expect(errors).toHaveLength(0);
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j) => j.jdText.includes('Azure Databricks'))).toBe(true);
    // The old code serialized every detail fetch; now they overlap.
    expect(detailMaxInFlight).toBeGreaterThan(1);
  });

  it('bounds optional detail requests and reuses a stored full description', async () => {
    const postings = Array.from({ length: 5 }, (_, i) => ({
      title: `Data Engineer ${i}`,
      externalPath: `/job/Remote/DE-${i}_R-${i}`,
      bulletFields: [`R-${i}`],
    }));
    const cfg = { host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External', company: 'acme', locale: '' };
    const cachedJob = workday.mapJob(postings[0], cfg);
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).endsWith('/jobs')) return jsonResponse({ total: 5, jobPostings: postings });
      return jsonResponse({ jobPostingInfo: { jobDescription: '<p>New full description from Workday</p>' } });
    });
    const { jobs } = await workday.run(
      { tenants: [{ ...cfg, pageSize: 20 }], maxDetailFetches: 2, hostSpacingMs: 0 },
      {
        fetchImpl, maxRetries: 0,
        workdayDetailCache: new Map([[cachedJob.id, {
          jdText: 'Previously stored full description '.repeat(10),
          postedAt: '2026-06-01',
        }]]),
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // one list + only two uncached details
    expect(jobs[0].rawMetadata.detailReused).toBe(true);
    expect(jobs[0].jdText).toContain('Previously stored');
    expect(jobs.filter((job) => job.rawMetadata.detailFetched)).toHaveLength(2);
  });
});

describe('genericPublicPage adapter', () => {
  it('parses JSON-LD from a fetched public page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(fixture('jobposting.html')));
    const jobs = await generic.fetchUrl('http://x', { fetchImpl });
    expect(jobs[0].title).toBe('Senior Data Engineer');
  });

  it('falls back to title-only when no JSON-LD present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse('<title>Some Data Role</title><body>hi</body>'));
    const jobs = await generic.fetchUrl('http://x', { fetchImpl });
    expect(jobs[0].title).toBe('Some Data Role');
    expect(jobs[0].rawMetadata.fallback).toBe('title-only');
  });

  it('extracts a job-description container when JSON-LD is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(fixture('jobposting_article.html')));
    const jobs = await generic.fetchUrl('http://x', { fetchImpl });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawMetadata.fallback).toBe('container');
    expect(jobs[0].jdText).toContain('Azure Databricks');
    expect(jobs[0].jdText).toContain('medallion');
    // The crude meta description must NOT be what we captured.
    expect(jobs[0].jdText).not.toContain('should not be used');
  });
});

describe('manualUrls adapter', () => {
  it('imports jobs from CSV without network', async () => {
    const readFileImpl = () => fixture('manual_jobs.csv');
    const { jobs } = await manualUrls.run(
      { options: { csvImportPath: 'whatever.csv' } },
      { readFileImpl, root: '/' },
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source: 'manual', company: 'Globex' });
  });

  it('treats a missing CSV as non-fatal', async () => {
    const readFileImpl = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
    const { jobs, errors } = await manualUrls.run(
      { options: { csvImportPath: 'missing.csv' } },
      { readFileImpl, root: '/' },
    );
    expect(jobs).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('skips malformed CSV rows and reports them without crashing', async () => {
    const readFileImpl = () => fixture('manual_jobs_malformed.csv');
    const { jobs, errors } = await manualUrls.run(
      { options: { csvImportPath: 'whatever.csv' } },
      { readFileImpl, root: '/' },
    );
    // Two good rows kept (Globex, Umbrella); the empty middle row is reported.
    expect(jobs.map((j) => j.company)).toEqual(['Globex', 'Umbrella']);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(3);
    expect(errors[0].error).toMatch(/missing/);
  });
});

describe('apify adapter', () => {
  const actorRun = (items) => ({ ok: true, status: 200, json: async () => items, text: async () => '' });

  it('runs a configured actor and maps dataset items to normalized jobs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      { positionName: 'Senior Data Engineer', companyName: 'Acme', location: 'Remote, US',
        url: 'https://www.linkedin.com/jobs/view/123', descriptionText: 'Azure Databricks PySpark. H-1B sponsorship.',
        postedAt: '2026-06-01', employmentType: 'Full-time', id: 'li-123' },
    ]));
    const source = { options: { actors: [{ actorId: 'bebity~linkedin-jobs-scraper', label: 'linkedin', source: 'linkedin', input: { title: 'x' } }] } };
    const { jobs, errors } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(errors).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: 'apify', title: 'Senior Data Engineer', company: 'Acme', location: 'Remote, US' });
    expect(jobs[0].url).toBe('https://www.linkedin.com/jobs/view/123');
    expect(jobs[0].jdText).toContain('Azure Databricks');
    expect(jobs[0].rawMetadata.provider).toBe('linkedin');
  });

  it('sends the token as a Bearer header and never in the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([{ title: 'Data Engineer', url: 'http://x' }]));
    const source = { options: { actors: [{ actorId: 'user~actor', input: {} }] } };
    await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'secret-tok' }, maxRetries: 0 });
    // Every call, including the free credit check that precedes the actor run,
    // must carry the token in a header and never in the URL.
    for (const [calledUrl, init] of fetchImpl.mock.calls) {
      expect(String(calledUrl)).not.toContain('secret-tok');
      expect(init.headers.authorization ?? init.headers.Authorization).toBe('Bearer secret-tok');
    }
    const [actorUrl, actorInit] = fetchImpl.mock.calls
      .find(([url]) => !String(url).includes('/users/me/limits'));
    expect(String(actorUrl)).toContain('run-sync-get-dataset-items');
    expect(actorInit.method).toBe('POST');
  });

  it('reports a config error (no throw) when the token is missing', async () => {
    const fetchImpl = vi.fn();
    const source = { options: { actors: [{ actorId: 'user~actor' }] } };
    const { jobs, errors } = await apify.run(source, { fetchImpl, env: {}, maxRetries: 0 });
    expect(jobs).toHaveLength(0);
    expect(errors[0].error).toMatch(/Missing Apify token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads items from an existing datasetId via GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([{ jobTitle: 'Lead Data Engineer', companyName: 'Globex', jobUrl: 'http://g/jobs/7' }]));
    const source = { options: { actors: [{ datasetId: 'ds-1', source: 'indeed' }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(String(calledUrl)).toContain('/datasets/ds-1/items');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(jobs[0]).toMatchObject({ title: 'Lead Data Engineer', company: 'Globex', url: 'http://g/jobs/7' });
  });

  it('captures HTTP errors per-actor without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 402, json: async () => ({}) });
    const source = { options: { actors: [{ actorId: 'user~actor', label: 'li' }] } };
    const { jobs, errors } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs).toHaveLength(0);
    expect(errors[0].actor).toBe('li');
    expect(errors[0].error).toMatch(/Apify HTTP 402/);
  });

  it('drops a bare-host apply URL instead of storing an unusable link', async () => {
    // Actors emit the aggregator's own host when a row has no link field. Stored
    // as an apply URL it cannot be applied to, and every row carrying it shares
    // one dedup key — so a whole batch collapses into a single job.
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      { title: 'Data Engineer', companyName: 'Acme', url: 'https://indeed.com' },
      { title: 'BI Developer', companyName: 'Acme', url: 'https://indeed.com/viewjob?jk=9' },
    ]));
    const source = { options: { actors: [{ actorId: 'user~actor' }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs.find((j) => j.title === 'Data Engineer').url).toBe('');
    expect(jobs.find((j) => j.title === 'BI Developer').url).toBe('https://indeed.com/viewjob?jk=9');
  });

  it('expands a forEachTargetTitle actor across the candidate profile', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([]));
    const source = { options: { actors: [{ actorId: 'user~actor', label: 'li', forEachTargetTitle: true }] } };
    await apify.run(source, {
      fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0, checkUsage: false,
      candidate: { targetTitles: ['Data Engineer', 'BI Developer'] },
    });
    // One billed run per target title, each carrying its own query.
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).title);
    expect(bodies.sort()).toEqual(['BI Developer', 'Data Engineer']);
  });

  it('reports target titles that no pinned actor ever searches for', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([]));
    const source = { options: { actors: [{ actorId: 'user~actor', input: { title: 'Data Engineer' } }] } };
    const { errors } = await apify.run(source, {
      fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0, checkUsage: false,
      candidate: { targetTitles: ['Data Engineer', 'ETL Developer'] },
    });
    const note = errors.find((e) => e.degraded);
    expect(note.error).toMatch(/ETL Developer/);
    expect(note.error).not.toMatch(/Data Engineer,/);
  });

  it('applies per-actor fieldMap overrides and skips unusable rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      { role: 'Staff Data Engineer', org: 'Initech', href: 'http://i/careers/42', body: 'SQL dbt' },
      { nothing: 'useful' },
    ]));
    const source = { options: { actors: [{ actorId: 'user~actor',
      fieldMap: { title: 'role', company: 'org', url: 'href', jdText: 'body' } }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Staff Data Engineer', company: 'Initech', url: 'http://i/careers/42' });
  });

  it('coerces nested object/array fields (Indeed-shape employer/location/jobTypes)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      {
        title: 'Senior Data Engineer',
        url: 'https://www.indeed.com/viewjob?jk=abc',
        employer: { name: 'Switch', companyPageUrl: 'http://x' },
        location: { city: 'Remote', admin1Code: 'CA', countryName: 'United States' },
        jobTypes: ['Full-time', 'Contract'],
        description: 'Build pipelines with SQL and Python',
      },
    ]));
    const source = { options: { actors: [{ actorId: 'valig~indeed-jobs-scraper' }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].company).toBe('Switch');
    expect(jobs[0].location).toBe('Remote, CA, United States');
    expect(jobs[0].employmentType).toBe('Full-time, Contract');
    expect(jobs[0].company).not.toContain('[object Object]');
  });

  it('prefers the direct company apply link over the Indeed viewjob wall page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      {
        title: 'Senior Data Engineer',
        // Indeed returns BOTH: the gated viewjob page AND the direct company link.
        url: 'https://www.indeed.com/viewjob?jk=abc',
        jobUrl: 'https://jobs.merck.com/us/en/job/MERCUSR401498ENUS/apply',
        employer: { name: 'Merck' },
        description: 'Build pipelines with SQL and Python',
      },
    ]));
    const source = { options: { actors: [{ actorId: 'valig~indeed-jobs-scraper' }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe('https://jobs.merck.com/us/en/job/MERCUSR401498ENUS/apply');
    expect(jobs[0].url).not.toContain('indeed.com');
  });

  it('falls back to the Indeed url only when no direct company link exists', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      { title: 'Data Engineer', url: 'https://www.indeed.com/viewjob?jk=zzz', employer: { name: 'Acme' } },
    ]));
    const source = { options: { actors: [{ actorId: 'valig~indeed-jobs-scraper' }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs[0].url).toBe('https://www.indeed.com/viewjob?jk=zzz');
  });

  it('maps a LinkedIn-shaped item and carries its posting date (postedDate -> postedAt)', async () => {
    // Real valig~linkedin-jobs-scraper output shape. The critical assertion is
    // that postedDate is captured: an undated job is shunted to the unknown-date
    // review bucket and never scored, so losing this date silently breaks
    // LinkedIn discovery.
    const fetchImpl = vi.fn().mockResolvedValue(actorRun([
      {
        id: 4376433358,
        title: 'Data Engineer (Python/Spark)',
        companyName: 'Take-Two Interactive',
        location: 'Austin, TX',
        url: 'https://www.linkedin.com/jobs/view/data-engineer-python-spark-at-take-two-interactive-4376433358',
        postedDate: '2026-06-12T00:00:00.000Z',
        postedTimeAgo: '2 hours ago',
        applyType: 'EXTERNAL',
        applyUrl: '',
        applicationsCount: 'Over 200 applicants',
        descriptionHtml: '<p>Build <b>Spark</b> pipelines with Python.</p>',
      },
    ]));
    const source = { options: { actors: [{ actorId: 'valig~linkedin-jobs-scraper', source: 'linkedin' }] } };
    const { jobs } = await apify.run(source, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: 'apify',
      title: 'Data Engineer (Python/Spark)',
      company: 'Take-Two Interactive',
      location: 'Austin, TX',
    });
    expect(jobs[0].postedAt).toBe('2026-06-12T00:00:00.000Z');
    expect(jobs[0].jdText).toContain('Spark');
    expect(jobs[0].rawMetadata.provider).toBe('linkedin');
    // No external apply link present -> keep the LinkedIn posting URL.
    expect(jobs[0].url).toContain('linkedin.com/jobs/view/');
  });

  it('reuses a successful configured actor result and stops queued actors on cancel', async () => {
    apify.clearApifyResultCache();
    let cancel = false;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      cancel = true;
      return actorRun([{ title: 'Data Engineer', url: 'https://jobs.acme.com/1' }]);
    });
    const source = {
      id: 'cached-actors',
      options: {
        cacheMinutes: 15,
        actors: [{ actorId: 'user~one' }, { actorId: 'user~two' }],
      },
    };
    const first = await apify.run(source, {
      fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0,
      actorConcurrency: 1, shouldCancel: () => cancel,
    });
    expect(first.cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    cancel = false;
    const cacheableSource = { ...source, options: { ...source.options, actors: [source.options.actors[0]] } };
    await apify.run(cacheableSource, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    const calls = fetchImpl.mock.calls.length;
    const cached = await apify.run(cacheableSource, { fetchImpl, env: { APIFY_TOKEN: 'tok' }, maxRetries: 0 });
    expect(cached.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });
});

describe('runSearch orchestration', () => {
  it('runs enabled sources in priority order, dedups, and isolates failures', async () => {
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [
        { id: 'gh', adapter: 'greenhouse', enabled: true, priority: 2, boards: ['acme'] },
        { id: 'bad', adapter: 'greenhouse', enabled: true, priority: 3, boards: ['x'] },
        { id: 'off', adapter: 'lever', enabled: false, priority: 1, boards: ['y'] },
      ],
    };
    // Key responses by URL (NOT a global call counter): sources now run
    // concurrently, so a counter would be racy. The 'acme' board succeeds, the
    // 'x' board fails — deterministically, whichever finishes first.
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('/boards/acme/')) {
        return jsonResponse({ jobs: [{ id: 1, title: 'SDE', company_name: 'Acme', content: 'Azure' }] });
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    const { jobs, errors, perSource } = await runSearch({ jobboards, ctx: { fetchImpl } });
    expect(jobs).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(1); // the 'bad' source failed
    expect(perSource.find((p) => p.source === 'gh').found).toBe(1);
    // Results are gathered in priority order regardless of completion order.
    expect(perSource.map((p) => p.source)).toEqual(['gh', 'bad']);
    expect(perSource.every((p) => Number.isFinite(p.durationMs))).toBe(true);
  });

  it('emits source lifecycle hooks with timing and result counts', async () => {
    const events = [];
    await runSearch({
      jobboards: {
        defaults: { rateLimitMs: 0, maxRetries: 0 },
        sources: [{ id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] }],
      },
      ctx: { fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ jobs: [] })) },
      hooks: { onSource: (event) => events.push(event) },
    });
    expect(events.map((event) => event.phase)).toEqual(['start', 'end']);
    expect(events[1]).toMatchObject({ source: 'gh', found: 0, errors: 0 });
    expect(Number.isFinite(events[1].durationMs)).toBe(true);
  });

  it('dedupes across sources and attaches permissive discovery signals', async () => {
    const candidate = {
      targetTitles: ['Senior Data Engineer'],
      seniority: 'senior',
      technicalStack: { de: ['Azure', 'Delta Lake', 'PySpark'], lang: ['Python', 'SQL'] },
      locationPreferences: { remote: true },
    };
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [
        { id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] },
        { id: 'lv', adapter: 'lever', enabled: true, priority: 2, boards: ['acme'] },
      ],
    };
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('greenhouse')) {
        return jsonResponse({ jobs: [{ title: 'Senior Data Engineer', company_name: 'Acme',
          location: { name: 'Remote' }, content: 'Azure Delta Lake PySpark Python SQL' }] });
      }
      // Lever returns the same company+title (board slug 'acme') -> should dedupe to one.
      return jsonResponse([{ text: 'Senior Data Engineer',
        categories: { location: 'Remote' }, descriptionPlain: 'Azure Delta Lake PySpark' }]);
    });
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl }, candidate });
    // Greenhouse "Acme" vs Lever board slug "acme", same title, no source id =>
    // identical dedup key => collapses to a single job.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawMetadata.discovery).toBeDefined();
    expect(jobs[0].rawMetadata.discovery.match).toBe('strong');
  });

  it('tags every job with its source kind (discovery vs url-reader)', async () => {
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [
        { id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jobs: [{ id: 7, title: 'Data Engineer', company_name: 'Acme', content: 'SQL' }],
    }));
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl } });
    expect(jobs[0].rawMetadata.sourceKind).toBe('discovery');
  });
});

describe('sources registry', () => {
  it('classifies real discovery adapters', () => {
    expect(adapterKind('greenhouse')).toBe('discovery');
    expect(adapterKind('lever')).toBe('discovery');
    expect(adapterKind('workday')).toBe('discovery');
    expect(adapterKind('careers')).toBe('discovery');
    expect(adapterKind('apify')).toBe('discovery');
    expect(isDiscoveryAdapter('careers')).toBe(true);
    expect(isDiscoveryAdapter('apify')).toBe(true);
  });

  it('classifies url-reader adapters (Dice/LinkedIn/Indeed/generic) as NOT discovery', () => {
    for (const a of ['dice', 'linkedin', 'indeed', 'genericPublicPage']) {
      expect(adapterKind(a)).toBe('url-reader');
      expect(isDiscoveryAdapter(a)).toBe(false);
    }
  });

  it('classifies the manual fallback distinctly', () => {
    expect(adapterKind('manualUrls')).toBe('manual');
  });

  it('maps normalized job.source strings to a kind', () => {
    expect(sourceKind('greenhouse')).toBe('discovery');
    expect(sourceKind('careers')).toBe('discovery');
    expect(sourceKind('apify')).toBe('discovery');
    expect(sourceKind('dice')).toBe('url-reader');
    expect(sourceKind('public')).toBe('url-reader');
    expect(sourceKind('manual')).toBe('manual');
    expect(sourceKind('mystery')).toBe('unknown');
  });
});

describe('careers adapter (public discovery)', () => {
  it('delegates ats:greenhouse entries to the greenhouse adapter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jobs: [{ id: 1, title: 'Senior Data Engineer', company_name: 'Acme', content: 'Azure' }],
    }));
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Acme', ats: 'greenhouse', slug: 'acme' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(errors).toHaveLength(0);
    expect(jobs[0]).toMatchObject({ source: 'greenhouse', title: 'Senior Data Engineer' });
    expect(jobs[0].rawMetadata.via).toBe('careers');
  });

  it('extracts job-like links from a public careers page and parses each', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).endsWith('/careers')) return htmlResponse(fixture('careers_page.html'));
      // Each discovered posting URL returns a JSON-LD posting.
      return htmlResponse(fixture('jobposting.html'));
    });
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Acme', careersUrl: 'https://acme.com/careers' }], maxLinksPerCompany: 10 },
      { fetchImpl, maxRetries: 0 },
    );
    expect(errors).toHaveLength(0);
    // 3 distinct job-like links (greenhouse dup collapses, nav/footer/# excluded).
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.source === 'careers')).toBe(true);
    expect(jobs[0].rawMetadata.company).toBe('Acme');
  });

  it('reads job-like URLs from a public sitemap and parses each', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if (String(url).endsWith('sitemap.xml')) return htmlResponse(fixture('sitemap.xml'));
      return htmlResponse(fixture('jobposting.html'));
    });
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Globex', sitemap: 'https://globex.com/sitemap.xml' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(errors).toHaveLength(0);
    // 3 job-like locs (2 /careers/job/ + 1 greenhouse); blog/about/home excluded.
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.source === 'careers')).toBe(true);
  });

  it('follows a sitemap index one level deep', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('sitemap.xml')) return htmlResponse(fixture('sitemap_index.xml'));
      if (u.endsWith('sitemap-jobs.xml')) return htmlResponse(fixture('sitemap.xml'));
      if (u.endsWith('sitemap-pages.xml')) return htmlResponse('<urlset></urlset>');
      return htmlResponse(fixture('jobposting.html'));
    });
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Globex', sitemap: 'https://globex.com/sitemap.xml' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(errors).toHaveLength(0);
    expect(jobs).toHaveLength(3);
  });

  it('treats a blocked page as skip-and-log, never bypassing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'Access denied', json: async () => ({}),
    });
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Locked', careersUrl: 'https://locked.com/careers' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(0);
    expect(errors[0].error).toMatch(/blocked/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry, no evasion
  });

  it('reports (does not throw) when no companies are configured', async () => {
    const { jobs, errors } = await careers.run({ companies: [] }, { fetchImpl: vi.fn() });
    expect(jobs).toHaveLength(0);
    expect(errors[0].note).toMatch(/no companies configured/);
  });
});

describe('careers helpers', () => {
  it('isJobLikeUrl accepts ATS hosts and job-ish paths, rejects the rest', () => {
    expect(careers.isJobLikeUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe(true);
    expect(careers.isJobLikeUrl('https://jobs.lever.co/acme/abc')).toBe(true);
    expect(careers.isJobLikeUrl('https://x.com/careers/job/5')).toBe(true);
    expect(careers.isJobLikeUrl('https://x.com/about')).toBe(false);
    expect(careers.isJobLikeUrl('mailto:a@b.com')).toBe(false);
    expect(careers.isJobLikeUrl('not a url')).toBe(false);
  });

  it('blockReason flags status codes and challenge markers', () => {
    expect(careers.blockReason(403, '')).toBe('http-403-forbidden');
    expect(careers.blockReason(429, '')).toBe('http-429-rate-limited');
    expect(careers.blockReason(200, 'Please solve this CAPTCHA')).toBe('captcha');
    expect(careers.blockReason(200, 'Verify you are human')).toBe('human-verification');
    expect(careers.blockReason(200, 'normal page')).toBeNull();
  });

  it('extractLocs and isSitemapIndex parse sitemap XML', () => {
    expect(careers.isSitemapIndex(fixture('sitemap_index.xml'))).toBe(true);
    expect(careers.isSitemapIndex(fixture('sitemap.xml'))).toBe(false);
    expect(careers.extractLocs(fixture('sitemap.xml')).length).toBe(6);
  });
});

describe('generic JD extraction enrichment', () => {
  it('uses meta description when the body is thin and there is no JSON-LD', async () => {
    const html = '<html><head><title>Data Engineer Role</title>' +
      '<meta name="description" content="Build Azure Databricks medallion pipelines with PySpark and Delta Lake."></head>' +
      '<body><h1>Data Engineer Role</h1></body></html>';
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(html));
    const jobs = await generic.fetchUrl('http://x', { fetchImpl });
    expect(jobs[0].rawMetadata.fallback).toBe('meta-description');
    expect(jobs[0].jdText).toContain('Delta Lake');
  });
});

describe('extractReadableContent fallback order', () => {
  const longText = (lead) => `${lead} ` + (
    'We are hiring a data engineer to build and operate large scale Azure ' +
    'Databricks medallion lakehouse pipelines with PySpark Delta Lake and ' +
    'Microsoft Fabric across finance analytics workloads requiring strong ' +
    'Python and SQL plus visa sponsorship for qualified candidates today.'
  );

  it('prefers a hinted job-description container', () => {
    const html = `<html><body><nav>Home About</nav>` +
      `<div class="job-description"><p>${longText('CONTAINER')}</p></div></body></html>`;
    const { text, method } = extractReadableContent(html);
    expect(method).toBe('container');
    expect(text).toContain('CONTAINER');
  });

  it('falls back to <article> when no container hint is present', () => {
    const html = `<html><body><nav>Home About Careers</nav>` +
      `<article><p>${longText('ARTICLE')}</p></article>` +
      `<footer>Copyright</footer></body></html>`;
    const { text, method } = extractReadableContent(html);
    expect(method).toBe('article');
    expect(text).toContain('ARTICLE');
  });

  it('falls back to <main> when there is no container or article', () => {
    const html = `<html><body><nav>Home</nav>` +
      `<main><p>${longText('MAIN')}</p></main>` +
      `<footer>x</footer></body></html>`;
    const { text, method } = extractReadableContent(html);
    expect(method).toBe('main');
    expect(text).toContain('MAIN');
  });

  it('falls back to the largest meaningful text block', () => {
    const html = `<html><body>` +
      `<div><p>Short intro.</p></div>` +
      `<div><p>${longText('LARGEST')}</p></div>` +
      `<div><p>Footer note.</p></div></body></html>`;
    const { text, method } = extractReadableContent(html);
    expect(method).toBe('largest-block');
    expect(text).toContain('LARGEST');
  });

  it('returns empty for content with no meaningful text', () => {
    const { text, method } = extractReadableContent('<html><body><nav>a b c</nav></body></html>');
    expect(method).toBe('empty');
    expect(text).toBe('');
  });
});

describe('discovery signal tagging (Greenhouse & Lever via runSearch)', () => {
  const candidate = {
    targetTitles: ['Senior Data Engineer', 'Lead Data Engineer'],
    seniority: 'senior',
    technicalStack: { de: ['Azure', 'Delta Lake', 'PySpark'], lang: ['Python', 'SQL'] },
    locationPreferences: { remote: true },
  };

  it('attaches discovery match/signals/reasons to Greenhouse jobs', async () => {
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [{ id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jobs: [{ id: 1, title: 'Senior Data Engineer', company_name: 'Acme',
        location: { name: 'Remote' }, content: 'Azure Delta Lake PySpark Python SQL' }],
    }));
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl }, candidate });
    const d = jobs[0].rawMetadata.discovery;
    expect(d.match).toBe('strong');
    expect(Array.isArray(d.signals)).toBe(true);
    expect(Array.isArray(d.reasons)).toBe(true);
    expect(jobs[0].rawMetadata.sourceKind).toBe('discovery');
  });

  it('keeps a weak Greenhouse match visible (never discarded at discovery)', async () => {
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [{ id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] }],
    };
    // Title matches a role token but only one stack hit -> weak, still returned.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jobs: [{ id: 2, title: 'Data Engineer', company_name: 'Acme', content: 'Azure only' }],
    }));
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl }, candidate });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawMetadata.discovery.match).toBe('weak');
  });

  it('attaches discovery match/signals/reasons to Lever jobs', async () => {
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [{ id: 'lv', adapter: 'lever', enabled: true, priority: 1, boards: ['globex'] }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([
      { id: 'x', text: 'Lead Data Engineer', hostedUrl: 'http://l',
        categories: { location: 'Remote' }, descriptionPlain: 'Azure Delta Lake PySpark Python SQL' },
    ]));
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl }, candidate });
    const d = jobs[0].rawMetadata.discovery;
    expect(d.match).toBe('strong');
    expect(jobs[0].rawMetadata.sourceKind).toBe('discovery');
  });

  it('labels an off-target Lever job as no_match when the early title gate is off', async () => {
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [{
        id: 'lv', adapter: 'lever', enabled: true, priority: 1, boards: ['globex'],
        options: { strictTitleMatch: false },
      }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([
      { id: 'y', text: 'Marketing Manager', hostedUrl: 'http://l',
        categories: { location: 'Remote' }, descriptionPlain: 'Brand campaigns and SEO' },
    ]));
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl }, candidate });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawMetadata.discovery.match).toBe('no_match');
  });

  it('title-gates Greenhouse/Lever/Ashby postings before mapping them (M7)', async () => {
    // Previously every posting on every board was mapped and carried through
    // the whole run; now a title that positively names another family is
    // dropped at the adapter, like SmartRecruiters and Oracle already did.
    const listing = [
      { id: 'y', text: 'Marketing Manager', hostedUrl: 'http://l/y', descriptionPlain: 'Brand campaigns' },
      { id: 'z', text: 'Senior Data Engineer', hostedUrl: 'http://l/z', descriptionPlain: 'Spark and SQL' },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(listing));
    const jobboards = {
      defaults: { rateLimitMs: 0, maxRetries: 0 },
      sources: [{ id: 'lv', adapter: 'lever', enabled: true, priority: 1, boards: ['globex'] }],
    };
    const { jobs } = await runSearch({ jobboards, ctx: { fetchImpl }, candidate });
    expect(jobs.map((j) => j.title)).toEqual(['Senior Data Engineer']);
  });
});

describe('oracleRecruiting adapter', () => {
  // The list envelope this API actually returns: jobs are nested one level
  // deeper than they look, under items[0].requisitionList.
  const orcPage = (rows, total) => jsonResponse({
    // The OUTER envelope lies about pagination on purpose — it describes the
    // single search-result object, not the jobs. A regression that reads these
    // instead of the inner TotalJobsCount stops after one page.
    count: 1, hasMore: false, limit: 200, offset: 0,
    items: [{ TotalJobsCount: total, requisitionList: rows }],
  });
  const row = (id, title) => ({
    Id: id, Title: title, PrimaryLocation: 'New York, NY, United States',
    PostedDate: '2026-08-01', ShortDescriptionStr: '<p>teaser</p>',
    secondaryLocations: [{ Name: 'Jersey City, NJ' }],
  });

  it('reads jobs from items[0].requisitionList and builds a direct apply URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(orcPage([row('123', 'Senior Data Engineer')], 1));
    const { jobs, errors } = await oracleRecruiting.run(
      { tenants: [{ host: 'acme.fa.us2.oraclecloud.com', siteNumber: 'CX_1001', company: 'Acme', fetchDetails: false }] },
      { fetchImpl, candidate: { targetTitles: ['Data Engineer'] } },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Senior Data Engineer');
    expect(jobs[0].company).toBe('Acme');
    // The employer's own ORC application page, not an aggregator hop.
    expect(jobs[0].url).toBe(
      'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/123',
    );
    expect(jobs[0].location).toBe('New York, NY, United States; Jersey City, NJ');
    expect(jobs[0].postedAt).toBe('2026-08-01');
  });

  it('paginates off items[0].TotalJobsCount, not the envelope hasMore', async () => {
    // hasMore:false on every page. Trusting it would return 2 of 5 jobs.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(orcPage([row('1', 'Data Engineer'), row('2', 'Data Engineer')], 5))
      .mockResolvedValueOnce(orcPage([row('3', 'Data Engineer'), row('4', 'Data Engineer')], 5))
      .mockResolvedValueOnce(orcPage([row('5', 'Data Engineer')], 5));
    const { jobs } = await oracleRecruiting.run(
      {
        tenants: [{
          host: 'h.fa.us2.oraclecloud.com', siteNumber: 'CX_1', pageSize: 2, fetchDetails: false,
        }],
        options: { keywords: [''] },
      },
      { fetchImpl },
    );
    expect(jobs).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('puts limit/offset inside the finder string and requires expand=requisitionList', () => {
    const cfg = oracleRecruiting.validateTenant({ host: 'h.example.com', siteNumber: 'CX_7' });
    const url = oracleRecruiting.listUrl(cfg, 400, 'data engineer');
    // Dropping this expand returns HTTP 200 with no jobs key at all.
    expect(url).toContain('expand=requisitionList');
    expect(url).toContain('finder=findReqs;siteNumber=CX_7,limit=200,offset=400');
    expect(url).toContain('keyword=data%20engineer');
    // NOT sibling query params — the API ignores those.
    expect(url).not.toMatch(/[?&]limit=/);
    expect(url).not.toMatch(/[?&]offset=/);
  });

  it('clamps pageSize to the server-side cap of 200', () => {
    const cfg = oracleRecruiting.validateTenant({ host: 'h', siteNumber: 'CX_1', pageSize: 500 });
    expect(cfg.pageSize).toBe(200);
  });

  it('rejects a tenant missing siteNumber rather than guessing one', async () => {
    const fetchImpl = vi.fn();
    const { jobs, errors } = await oracleRecruiting.run(
      { tenants: [{ host: 'h.fa.us2.oraclecloud.com' }] },
      { fetchImpl },
    );
    expect(jobs).toEqual([]);
    expect(errors[0].error).toMatch(/requires host and siteNumber/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dedupes a requisition returned by more than one keyword', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(orcPage([row('same', 'Data Engineer')], 1));
    const { jobs } = await oracleRecruiting.run(
      {
        tenants: [{ host: 'h.fa.us2.oraclecloud.com', siteNumber: 'CX_1', fetchDetails: false }],
        options: { keywords: ['data engineer', 'bi developer'] },
      },
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(1);
  });

  it('applyDetail puts requisition text ahead of corporate boilerplate', () => {
    const job = { jdText: 'teaser', rawMetadata: { summaryOnly: true } };
    oracleRecruiting.applyDetail(job, {
      ExternalDescriptionStr: '<p>Role body</p>',
      CorporateDescriptionStr: '<p>About the company</p>',
      ExternalPostedStartDate: '2026-08-01T10:00:00+00:00',
    });
    expect(job.jdText.indexOf('Role body')).toBeLessThan(job.jdText.indexOf('About the company'));
    expect(job.rawMetadata.summaryOnly).toBe(false);
    // The detail's full timestamp supersedes the list's date-only value.
    expect(job.postedAt).toBe('2026-08-01T10:00:00+00:00');
  });

  it('is registered as a real discovery adapter', () => {
    expect(isDiscoveryAdapter('oracleRecruiting')).toBe(true);
    expect(sourceKind('oracleRecruiting')).toBe('discovery');
  });
});

describe('amazonJobs adapter', () => {
  const page = (jobs, hits) => jsonResponse({ hits, jobs });
  const row = (id, title, extra = {}) => ({
    id: `uuid-${id}`, id_icims: id, title,
    location: 'US, VA, Herndon', normalized_location: 'Herndon, Virginia, USA',
    posted_date: 'August  5, 2026', description: '<p>Build pipelines</p>',
    company_name: 'Amazon Web Services, Inc.',
    job_path: `/en/jobs/${id}/${title.toLowerCase().replace(/\s+/g, '-')}`,
    ...extra,
  });

  it('maps a search row, preferring the public numeric id and job_path URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page([row('10493150', 'Data Engineer')], 1));
    const { jobs, errors } = await amazonJobs.run(
      { options: { queries: ['data engineer'] } },
      { fetchImpl, candidate: { targetTitles: ['Data Engineer'] } },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    // id_icims, not the uuid — it is what the public URL shows.
    expect(jobs[0].sourceJobId).toBe('10493150');
    expect(jobs[0].url).toBe('https://www.amazon.jobs/en/jobs/10493150/data-engineer');
    // The row's own employer, not a hardcoded "Amazon".
    expect(jobs[0].company).toBe('Amazon Web Services, Inc.');
    expect(jobs[0].location).toBe('Herndon, Virginia, USA');
  });

  it('parses the irregular double-spaced posted_date rather than dropping the job', () => {
    // "August  5, 2026" has two spaces. Left uncollapsed this is NaN, the job
    // arrives undated, and the freshness stage drops undated jobs by default —
    // so this quirk decides whether the posting exists at all.
    // Anchored to UTC so the result does not depend on the machine's timezone —
    // parsed locally, this same input lands on a different DATE near a month
    // boundary in CI than on a laptop.
    expect(amazonJobs.parsePostedDate('August  5, 2026')).toBe('2026-08-05T00:00:00.000Z');
    expect(amazonJobs.parsePostedDate('August 5, 2026')).toBe('2026-08-05T00:00:00.000Z');
    // Never invents a date.
    expect(amazonJobs.parsePostedDate('not a date')).toBeNull();
    expect(amazonJobs.parsePostedDate('')).toBeNull();
  });

  it('paginates on hits and dedupes a job returned by two queries', async () => {
    const fetchImpl = vi.fn()
      // query 1, page 1 of 2
      .mockResolvedValueOnce(page([row('1', 'Data Engineer')], 2))
      .mockResolvedValueOnce(page([row('2', 'Data Engineer')], 2))
      // query 2 returns one already-seen job
      .mockResolvedValueOnce(page([row('1', 'Data Engineer')], 1));
    const { jobs } = await amazonJobs.run(
      { options: { queries: ['data engineer', 'bi developer'], pageSize: 1 } },
      { fetchImpl, candidate: { targetTitles: ['Data Engineer'] } },
    );
    expect(jobs).toHaveLength(2);
  });

  it('reports clearly when there are no phrases to search rather than silently finding nothing', async () => {
    const fetchImpl = vi.fn();
    const { jobs, errors } = await amazonJobs.run({}, { fetchImpl, candidate: { targetTitles: [] } });
    expect(jobs).toEqual([]);
    expect(errors[0].note).toMatch(/no search phrases/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is registered as a real discovery adapter', () => {
    expect(isDiscoveryAdapter('amazonJobs')).toBe(true);
    expect(sourceKind('amazonJobs')).toBe('discovery');
  });
});
