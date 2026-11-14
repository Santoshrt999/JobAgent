/**
 * Getting from a job posting INTO its application form.
 *
 * Regression (Oracle Recruiting Cloud, 2026-11-11): the posting is a
 * single-page app. At `domcontentloaded` it is an empty shell; "Apply Now"
 * appears ~1.5 s later. The runner read the page at once, found no way in,
 * and stopped with "resume: upload input not found" on the job description.
 * Also covered: an Apply LINK that opens a new tab, an Apply button that pops
 * a window, and the hidden "honey-pot" box Oracle puts next to the email.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { applicationFields, detectValidationErrors, scanFields } from '../../src/automation/domScanner.js';
import { findAdvanceControl, APPLY_START_RE, NOT_APPLY_START_RE } from '../../src/automation/navigator.js';
import { assistApply } from '../../src/automation/applyRunner.js';

const ORIGIN = 'https://careers.acme.test';

const FORM = `<!doctype html><title>Apply</title>
<style>input,button{display:block;width:220px;height:26px;margin:4px}
  .invisible{height:0;overflow:hidden;position:relative}</style>
<form><label for="email">Email Address</label><input id="email" type="email">
  <div class="invisible"><div style="position:absolute"><input name="honey-pot" id="hp1" type="text" aria-hidden="true" tabindex="-1"></div></div>
  <button type="button">Next</button></form>`;

/** A posting that draws itself late, like Oracle's candidate experience. */
const SPA_POSTING = `<!doctype html><title>Loading</title><body><div id="app"></div>
<script>
  setTimeout(() => {
    document.title = 'Lead Data Engineer';
    document.getElementById('app').innerHTML =
      '<h1>Lead Data Engineer</h1><p>Build pipelines.</p>' +
      '<button type="button" class="carousel">Next</button>' +
      '<button type="button" id="go"><span>Apply Now</span></button>';
    document.getElementById('go').addEventListener('click', () => {
      setTimeout(() => {
        history.pushState({}, '', '/job/1/apply/email');
        document.getElementById('app').innerHTML = ${JSON.stringify(FORM)};
      }, 600);
    });
  }, 1500);
</script></body>`;

const LINK_POSTING = `<!doctype html><title>Job</title><h1>Data Engineer</h1>
<nav><a href="/jobs">All jobs</a><a href="/apply-filters">Apply filters</a></nav>
<a href="https://www.linkedin.com/apply" target="_blank">Apply with LinkedIn</a>
<a class="postings-btn" href="${ORIGIN}/form" target="_blank">Apply for this job</a>`;

/** Workday-style: Apply opens a start dialog over the posting; then a sign-in page. */
const DIALOG_POSTING = `<!doctype html><title>Job</title>
<div role="alert" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Data Engineer page is loaded</div>
<h1>Data Engineer</h1><button type="button" id="apply">Apply</button>
<div id="dlg" role="dialog" aria-modal="true" hidden>
  <h2>Start Your Application</h2>
  <button type="button">Autofill with Resume</button>
  <button type="button" id="manual">Apply Manually</button>
  <button type="button">Apply With LinkedIn</button>
</div>
<script>
  document.getElementById('apply').addEventListener('click', () => { document.getElementById('dlg').hidden = false; });
  document.getElementById('manual').addEventListener('click', () => {
    history.pushState({}, '', '/dialog/apply/applyManually');
    document.body.innerHTML = '<h2>Sign In</h2><button type="button">Sign in with Google</button>'
      + '<button type="button">Sign in with email</button>';
  });
</script>`;

const POPUP_POSTING = `<!doctype html><title>Job</title><h1>Data Engineer</h1>
<button type="button" onclick="window.open('${ORIGIN}/form', '_blank')">Apply</button>`;

function serve(page) {
  return page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.startsWith('/form') ? FORM
      : path.startsWith('/link') ? LINK_POSTING
        : path.startsWith('/popup') ? POPUP_POSTING
          : path.startsWith('/dialog') ? DIALOG_POSTING
          : SPA_POSTING;
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

const config = {
  candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test' } },
  screeningAnswers: {}, runtime: {},
};
const packetFor = (url) => ({
  job: { id: 'j', url }, blockers: [], owner: { candidateName: 'Dana Okafor' },
  fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
});

describe('from a posting into its application', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  async function run(url, maxSteps = 2) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await serve(context);
    const result = await assistApply({
      packet: packetFor(url),
      config,
      options: { headless: true, statePath: false, maxSteps },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    return { result, page, context };
  }

  it('waits for a late-drawn posting, clicks Apply Now (not the carousel Next), and fills the form', async () => {
    const { result, page, context } = await run(`${ORIGIN}/job/1`);
    expect(page.url()).toBe(`${ORIGIN}/job/1/apply/email`);
    expect(await page.inputValue('#email')).toBe('dana@example.test');
    expect(await page.inputValue('#hp1')).toBe('');
    expect(result.filled.map((f) => f.selector)).toContain('#email');
    expect(result.blockers.join(' ')).not.toMatch(/upload input not found/);
    await context.close();
  }, 60_000);

  it('follows an Apply link that opens a new tab in the same tab, skipping LinkedIn and filter links', async () => {
    const { page, context } = await run(`${ORIGIN}/link`);
    expect(page.url()).toBe(`${ORIGIN}/form`);
    expect(context.pages()).toHaveLength(1);
    expect(await page.inputValue('#email')).toBe('dana@example.test');
    await context.close();
  }, 60_000);

  it('brings a popped-up application back into the run tab', async () => {
    const { page, context } = await run(`${ORIGIN}/popup`);
    expect(page.url()).toBe(`${ORIGIN}/form`);
    expect(context.pages()).toHaveLength(1);
    expect(await page.inputValue('#email')).toBe('dana@example.test');
    await context.close();
  }, 60_000);

  it('chooses "Apply Manually" in a start dialog, and stops at sign-in instead of calling it ready', async () => {
    const { result, page, context } = await run(`${ORIGIN}/dialog`, 4);
    expect(new URL(page.url()).pathname).toBe('/dialog/apply/applyManually');
    expect(result.status).toBe('assist_blocked');
    expect(result.blockers.join(' ')).toMatch(/^sign-in required/);
    await context.close();
  }, 60_000);

  it('does not read a screen-reader "page is loaded" announcement as a form error', async () => {
    const page = await browser.newPage();
    await page.setContent(DIALOG_POSTING);
    expect(await detectValidationErrors(page)).toEqual([]);
    await page.setContent('<p role="alert">Please enter a valid email address.</p>');
    expect(await detectValidationErrors(page)).toEqual(['Please enter a valid email address.']);
    await page.close();
  }, 30_000);

  it('tags the hidden honey-pot box as not part of the application', async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const fields = await scanFields(page);
    expect(fields.find((f) => f.selector === '#hp1')?.incidental).toBe('honeypot');
    expect(applicationFields(fields).map((f) => f.selector)).toEqual(['#email']);
    // On a filled page the way in is never offered, and "Next" still advances.
    expect((await findAdvanceControl(page))?.text).toBe('Next');
    await page.close();
  }, 30_000);
});

describe('Apply wording', () => {
  it.each(['Apply', 'Apply Now', 'APPLY NOW', 'Apply online', 'Apply for this position', 'Apply to this job',
    "I'm interested", 'Start application', 'Start your application'])('"%s" opens an application', (text) => {
    expect(APPLY_START_RE.test(text) && !NOT_APPLY_START_RE.test(text)).toBe(true);
  });
  it.each(['Apply with LinkedIn', 'Apply filters', 'Applied', 'Apply changes', 'Similar jobs'])('"%s" does not', (text) => {
    expect(APPLY_START_RE.test(text) && !NOT_APPLY_START_RE.test(text)).toBe(false);
  });
});
