/**
 * Auto-fill, end to end, from the dashboard button to "ready for your Submit".
 *
 * Everything real except the website: the dashboard server, the approval, the
 * runner, the scanner, the filler, the uploader and the status it records.
 * The site copies what broke on Oracle Recruiting Cloud (2026-11-11):
 *   - the posting draws late, and a cookie banner draws (and holds still)
 *     before the posting and its Apply control exist;
 *   - "Apply" is a link that opens a new tab;
 *   - step 1 has a hidden "honey-pot" box and a STYLED required consent
 *     checkbox (the real input is invisible; the label draws the box);
 *   - step 2 ends in "Submit application", which must never be clicked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { editJson, launchBrowser, startTestDashboard } from './helpers/dashboardPage.js';

const ORIGIN = 'https://careers.fixture.test';

const POSTING = `<!doctype html><title>Loading…</title><body><div id="app"></div>
<script>
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.id = 'cookie-consent';
    banner.setAttribute('role', 'dialog'); // like Oracle's: a dialog that is NOT the way in
    banner.innerHTML = '<p>We use cookies.</p><button type="button">Accept all</button><button type="button">Reject all</button>';
    document.body.append(banner);
  }, 200);
  setTimeout(() => {
    document.title = 'Lead Data Engineer';
    document.getElementById('app').innerHTML = '<h1>Lead Data Engineer</h1><p>Build pipelines.</p>'
      + '<button type="button">Next</button>'
      + '<a href="${ORIGIN}/apply" target="_blank">Apply for this job</a>';
  }, 2600);
</script></body>`;

const APPLY = `<!doctype html><title>Apply</title>
<style>
  label, input, button, select { display: block; margin: 6px 0; }
  .styled input { position: absolute; opacity: 0; width: 0; height: 0; }
  .styled span::before { content: ''; display: inline-block; width: 14px; height: 14px; border: 1px solid #333; margin-right: 6px; }
  .styled input:checked + span::before { background: #333; }
  .trap { height: 0; overflow: hidden; }
</style>
<main id="app">
  <form id="step1">
    <label for="fn">First name *</label><input id="fn" name="first_name" required>
    <label for="ln">Last name *</label><input id="ln" name="last_name" required>
    <label for="em">Email *</label><input id="em" name="email" type="email" required>
    <div class="trap"><input name="honey-pot" id="hp" aria-hidden="true" tabindex="-1"></div>
    <label for="cv">Resume/CV *</label><input id="cv" name="resume" type="file" required>
    <label class="styled" for="privacy"><input id="privacy" type="checkbox" aria-required="true"><span>I have read the Important Privacy Information *</span></label>
    <button type="button" id="next">Next</button>
    <p id="err" role="alert" hidden></p>
  </form>
</main>
<script>
  document.getElementById('next').addEventListener('click', () => {
    const ok = ['fn', 'ln', 'em'].every((id) => document.getElementById(id).value.trim())
      && document.getElementById('cv').files.length === 1
      && document.getElementById('privacy').checked
      && !document.getElementById('hp').value;
    if (!ok) {
      const err = document.getElementById('err');
      err.hidden = false; err.textContent = 'Please complete every required field.';
      return;
    }
    window.__step1 = { file: document.getElementById('cv').files[0].name };
    history.pushState({}, '', '/apply/questions');
    document.getElementById('app').innerHTML = '<form><label for="src">How did you hear about us?</label>'
      + '<input id="src" name="source"><button type="button" id="submit">Submit application</button></form>';
    document.getElementById('submit').addEventListener('click', () => { window.__submitted = true; });
  });
</script>`;

describe('Auto-fill from the dashboard button', () => {
  let dash;
  let browser;
  let siteContext;
  let sitePage;

  beforeAll(async () => {
    browser = await launchBrowser();
    siteContext = await browser.newContext();
    await siteContext.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ status: 200, contentType: 'text/html', body: path.startsWith('/apply') ? APPLY : POSTING });
    });
    sitePage = await siteContext.newPage();

    dash = await startTestDashboard({
      prepare: (root) => editJson(root, 'config/screening_answers.json', (doc) => {
        doc.answers = [...(doc.answers ?? []), {
          id: 'privacy_notice', patterns: ['important privacy information'], answer: 'Yes', type: 'checkbox',
        }];
      }),
      deps: {
        // The one stand-in: the browser session opens the fixture site.
        createSession: async () => ({ page: sitePage, close: async () => {} }),
        loadPacketImpl: () => packet(),
      },
    });
    dash.db.upsertJob({
      id: 'j7', company: 'Northwind', title: 'Lead Data Engineer', url: `${ORIGIN}/job/7`,
      source: 'oracleRecruiting', score: 88, tier: 'Priority', sponsorship: 'Confirmed', status: 'prepared',
      application_packet_path: 'packet-j7.json', resume_path: resumePath(),
      posted_at: new Date().toISOString(), jd_text: 'Build pipelines. '.repeat(40),
    });
    dash.db.insertApproval({
      id: 'approval-j7', job_id: 'j7', packet_path: 'packet-j7.json',
      approval_status: 'pending_review', approved_by_user: 0,
    });
  }, 60_000);

  afterAll(async () => {
    await siteContext?.close();
    await browser?.close();
    await dash?.stop();
  }, 30_000);

  const resumePath = () => join(dash.root, 'resumes', 'base', 'MASTER_RESUME.docx');
  const packet = () => ({
    id: 'packet-j7',
    owner: {},
    job: { id: 'j7', company: 'Northwind', title: 'Lead Data Engineer', url: `${ORIGIN}/job/7` },
    ats: { platform: 'generic' },
    blockers: [],
    resumePath: resumePath(),
    resumeTailored: true,
    resumeValidation: { ok: true, word_count: 650 },
    tailoring: { changes: [], gaps: [] },
    atsReport: { match_score: 84, band: 'strong', ats_safety: { ok: true, issues: [] } },
    prefill: { plan: [], needsUser: [] },
    screeningPlan: { answered: [], needsUser: [] },
    uploads: { blockers: [] },
    fillPlan: {
      platform: 'generic', steps: [], needsUser: [], submitSelector: null,
      uploads: [{ type: 'resume', path: resumePath(), selector: 'input[type="file"]', resolved: true, required: true }],
      stopBeforeSubmit: true, submitReady: false,
    },
    stopBeforeSubmit: true,
    submitReady: false,
  });

  it('opens the posting, finds Apply, fills and uploads, and stops before Submit', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(dash.url, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Jobs', exact: true }).click();
      await page.getByRole('row', { name: /Northwind.*Lead Data Engineer/ }).click();
      await page.getByRole('button', { name: /Auto-fill application/ }).first().click();

      await expect.poll(() => dash.db.getJob('j7').status, { timeout: 60_000, interval: 500 }).toBe('ready_for_submit');

      // It got through the posting and step 1 into the last step…
      expect(new URL(sitePage.url()).pathname).toBe('/apply/questions');
      expect(siteContext.pages()).toHaveLength(1);
      // …with the resume attached, the bot trap empty and the consent ticked…
      expect(await sitePage.evaluate(() => window.__step1)).toEqual({ file: 'MASTER_RESUME.docx' });
      // …and the final Submit left for the human.
      expect(await sitePage.evaluate(() => window.__submitted === true)).toBe(false);
      const job = dash.db.getJob('j7');
      expect(Number(job.applied)).toBe(0);
      expect(dash.db.getApprovalByJob('j7').approval_status).toBe('approved');
      expect(JSON.parse(job.assist_blockers ?? '[]')).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});
