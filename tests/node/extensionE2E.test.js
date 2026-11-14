import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('Chromium extension assisted-fill E2E', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('fills approved truthful fields while leaving demographics, attestations, and submit untouched', async () => {
    const page = await browser.newPage();
    await page.evaluate(() => {
      globalThis.__submitClicks = 0;
      globalThis.chrome = {
        runtime: {
          onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } },
          sendMessage: async () => ({ ok: false, error: 'not used in this fixture' }),
        },
      };
    });
    await page.setContent(`
      <style>input,select,button{display:block;width:240px;height:28px;margin:8px}</style>
      <form id="application"><label>First name <input id="first"></label>
      <label>Email <input id="email" type="email" required></label>
      <label>Will you require sponsorship now or in the future?
        <select id="sponsor"><option value="">Choose</option><option>No</option><option>Yes</option></select>
      </label>
      <label>Race / ethnicity <input id="race"></label>
      <label><input id="attest" type="checkbox"> I certify that this application is accurate</label>
      <button id="submit" type="submit">Submit application</button></form>
      <script>document.querySelector('#submit').addEventListener('click',e=>{e.preventDefault();globalThis.__submitClicks++})</script>
    `);
    await page.addScriptTag({ path: resolve('extension/content.js') });
    const result = await page.evaluate(() => new Promise((resolveResult) => {
      globalThis.__jobAgentListener({
        type: 'JOB_AGENT_FILL',
        payload: {
          job: { id: 'j1' }, artifacts: {},
          profile: { identity: { fullName: 'Ada Lovelace' }, contact: { email: 'ada@example.test' } },
          screeningAnswers: [{ id: 'sponsor', patterns: ['require sponsorship'], answer: 'Yes. H-1B transfer required.' }],
        },
        connection: { trustedHost: true },
      }, null, resolveResult);
    }));

    expect(await page.inputValue('#first')).toBe('Ada');
    expect(await page.inputValue('#email')).toBe('ada@example.test');
    // Work-authorization questions are never answered by the extension, even
    // with a matching stored answer — they go to the human.
    expect(await page.inputValue('#sponsor')).toBe('');
    expect(await page.inputValue('#race')).toBe('');
    expect(await page.isChecked('#attest')).toBe(false);
    expect(await page.evaluate(() => globalThis.__submitClicks)).toBe(0);
    expect(result.filled).toHaveLength(2);
    expect(result.blockers.join(' ')).toMatch(/protected|attestation/i);
    expect(result.blockers.join(' ')).toMatch(/work-authorization question yourself/);
    await page.close();
  }, 30_000);

  it('never answers an INVERTED sponsorship question, and honours server decisions', async () => {
    // Regression: "…without requiring sponsorship?" matched the pattern
    // `require sponsorship` and was answered "Yes" for a candidate who needs it.
    const page = await browser.newPage();
    await page.evaluate(() => {
      globalThis.chrome = { runtime: { onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } } } };
    });
    await page.setContent(`
      <style>input,select{display:block;width:240px;height:28px;margin:8px}</style>
      <form><h2>Job application</h2><label>Email <input id="email" type="email"></label>
      <label>Are you able to work in the US without requiring sponsorship?
        <select id="inv"><option value="">Choose</option><option>Yes</option><option>No</option></select></label>
      <label>Desired salary <input id="salary"></label>
      <label>Notice period <input id="notice"></label></form>`);
    await page.addScriptTag({ path: resolve('extension/content.js') });
    const result = await page.evaluate(() => new Promise((done) => globalThis.__jobAgentListener({
      type: 'JOB_AGENT_FILL',
      payload: {
        job: { id: 'j1' }, artifacts: {},
        profile: { contact: { email: 'ada@example.test' } },
        screeningAnswers: [
          { id: 'sponsor', patterns: ['requiring sponsorship', 'require sponsorship'], answer: 'Yes' },
          { id: 'salary', patterns: ['salary'], answer: '999,999' },
          { id: 'notice', patterns: ['notice'], answer: 'stale answer' },
        ],
        screeningDecisions: {
          'Desired salary': { action: 'ask_user', answer: null },
          'Notice period': { action: 'fill', answer: 'Two weeks', matchedId: 'notice' },
        },
      },
      connection: { trustedHost: true },
    }, null, done)));
    expect(await page.inputValue('#inv')).toBe('');
    expect(await page.inputValue('#salary')).toBe('');
    expect(await page.inputValue('#notice')).toBe('Two weeks');
    expect(result.filled.map((f) => f.label)).toEqual(['Email', 'Notice period']);
    await page.close();
  }, 30_000);

  it('asks the service worker for artifacts by job and kind, never with the key', async () => {
    const page = await browser.newPage();
    await page.evaluate(() => {
      globalThis.__sent = [];
      globalThis.chrome = { runtime: {
        onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } },
        sendMessage: async (msg) => { globalThis.__sent.push(msg); return { ok: true, base64: btoa('pdf'), name: 'r.pdf', type: 'application/pdf' }; },
      } };
    });
    await page.setContent(`<style>input{display:block;width:240px;height:28px}</style>
      <form><h2>Job application</h2><label>Resume/CV <input id="cv" type="file"></label><label>Email <input id="e"></label></form>`);
    await page.addScriptTag({ path: resolve('extension/content.js') });
    await page.evaluate(() => new Promise((done) => globalThis.__jobAgentListener({
      type: 'JOB_AGENT_FILL',
      payload: { job: { id: 'j1' }, profile: {}, artifacts: { resume: { name: 'r.pdf', available: true } } },
      connection: { trustedHost: true, key: 'k'.repeat(32), serverUrl: 'https://evil.test' },
    }, null, done)));
    const sent = await page.evaluate(() => globalThis.__sent);
    expect(sent).toEqual([{ type: 'JOB_AGENT_FETCH_ARTIFACT', jobId: 'j1', kind: 'resume', name: 'r.pdf' }]);
    await page.close();
  }, 30_000);

  it('service worker builds a loopback URL itself and serves only this extension', async () => {
    const page = await browser.newPage();
    await page.addScriptTag({ path: resolve('extension/service-worker.js') });
    const out = await page.evaluate(() => {
      const { artifactRequest } = globalThis.__jobAgentWorker;
      const key = 'k'.repeat(32);
      const me = { id: 'self' };
      return {
        ok: artifactRequest({ jobId: 'a b', kind: 'resume' }, me, 'self', { serverUrl: 'http://127.0.0.1:4646', key }),
        foreignSender: artifactRequest({ jobId: 'a', kind: 'resume' }, { id: 'other' }, 'self', { serverUrl: 'http://127.0.0.1:4646', key }),
        remote: artifactRequest({ jobId: 'a', kind: 'resume' }, me, 'self', { serverUrl: 'https://evil.test', key }),
        badKind: artifactRequest({ jobId: 'a', kind: '../../x' }, me, 'self', { serverUrl: 'http://localhost:4646', key }),
      };
    });
    expect(out.ok).toEqual({ ok: true, url: 'http://127.0.0.1:4646/api/extension/jobs/a%20b/files/resume', key: 'k'.repeat(32) });
    expect(out.foreignSender.ok).toBe(false);
    expect(out.remote.ok).toBe(false);
    expect(out.badKind.ok).toBe(false);
    await page.close();
  }, 30_000);

  it('does not fill ordinary page/search fields when no application form is open', async () => {
    const page = await browser.newPage();
    await page.evaluate(() => {
      globalThis.chrome = { runtime: { onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } } } };
    });
    await page.setContent('<style>input{width:240px;height:28px}</style><label>Location <input id="search-location"></label>');
    await page.addScriptTag({ path: resolve('extension/content.js') });
    const result = await page.evaluate(() => new Promise((done) => globalThis.__jobAgentListener({
      type: 'JOB_AGENT_FILL', payload: { job: { id: 'j1' }, profile: { location: { city: 'Springfield' } } }, connection: { trustedHost: true },
    }, null, done)));
    expect(await page.inputValue('#search-location')).toBe('');
    expect(result.filled).toHaveLength(0);
    expect(result.blockers.join(' ')).toMatch(/no application form is open/i);
    await page.close();
  }, 30_000);

  it('verifies an aggregator redirect and clicks only the initial Apply control', async () => {
    const page = await browser.newPage();
    await page.evaluate(() => {
      globalThis.__applyClicks = 0;
      globalThis.chrome = { runtime: { onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } } } };
    });
    await page.setContent(`
      <style>button{width:180px;height:32px}</style>
      <h1>The Coca-Cola Company</h1><h2>Data Analyst Data Solutions</h2>
      <button id="apply">Apply Now</button>
      <script>document.querySelector('#apply').addEventListener('click',()=>globalThis.__applyClicks++)</script>
    `);
    await page.addScriptTag({ path: resolve('extension/content.js') });
    const result = await page.evaluate(() => new Promise((done) => globalThis.__jobAgentListener({
      type: 'JOB_AGENT_FILL',
      payload: { job: { id: 'j1', company: 'The Coca-Cola Company', title: 'Data Analyst Data Solutions' }, profile: {} },
      connection: { expectedHost: 'www.linkedin.com', trustedHost: false, allowStart: true },
    }, null, done)));
    expect(result.contextVerified).toBe(true);
    expect(result.startedApplication).toBe(true);
    expect(result.formDetected).toBe(false);
    expect(await page.evaluate(() => globalThis.__applyClicks)).toBe(1);
    await page.close();
  }, 30_000);

  it('automatically takes the selected dashboard job ID and opens its direct application', async () => {
    const page = await browser.newPage();
    const jobId = 'apify:acme::data engineer::123';
    await page.addInitScript(({ selected }) => {
      globalThis.__updatedUrl = '';
      globalThis.chrome = {
        storage: { local: {
          get: async (defaults) => ({ ...defaults, serverUrl: 'http://127.0.0.1:4646', key: 'k'.repeat(32) }),
          set: async () => {},
        } },
        tabs: {
          query: async () => [{ id: 7, url: `http://127.0.0.1:4646/#job=${encodeURIComponent(selected)}` }],
          // The dashboard tab must stay where it is: the posting opens in a new tab.
          update: async () => { globalThis.__dashboardReplaced = true; },
          create: async (props) => { globalThis.__updatedUrl = props.url; },
        },
      };
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ job: { id: selected, company: 'Acme', title: 'Data Engineer', url: 'https://careers.acme.test/jobs/123' } }),
      });
    }, { selected: jobId });
    await page.goto(pathToFileURL(resolve('extension/popup.html')).href);
    await expect.poll(() => page.inputValue('#jobId')).toBe(jobId);
    await expect.poll(() => page.textContent('#jobSummary')).toContain('Acme — Data Engineer');
    expect(await page.textContent('#fill')).toBe('Open application');
    await page.click('#fill');
    await expect.poll(() => page.evaluate(() => globalThis.__updatedUrl)).toBe('https://careers.acme.test/jobs/123');
    expect(await page.evaluate(() => globalThis.__dashboardReplaced ?? false)).toBe(false);
    // Only the top frame, the job's own host and known ATS embeds get the payload.
    const frames = await page.evaluate(() => globalThis.__jobAgentPopup.selectFillFrames([
      { frameId: 0, result: 'careers.acme.test' },
      { frameId: 3, result: 'ads.doubleclick.net' },
      { frameId: 4, result: 'job-boards.greenhouse.io' },
      { frameId: 5, result: 'careers.acme.test' },
      { frameId: 6, result: '' },
    ], { expectedHost: 'careers.acme.test', pageHost: 'careers.acme.test' }));
    expect(frames).toEqual([0, 4, 5]);
    await page.close();
  }, 30_000);
});
