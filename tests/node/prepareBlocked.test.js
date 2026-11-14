/**
 * A refused Prepare must say why, where Prepare is clicked, and keep saying it.
 *
 * Measured 2026-11-12: with template text left in the profile, "Prepare resume"
 * started a run that the placeholder guard refused in the background. The page
 * showed a passing toast and "Prepared 0 packet(s)", so it looked as if the
 * click did nothing; the reason (four named fields) was only in the server log.
 * These tests drive the real dashboard in Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import {
  answerBox, editJson, expandSavedAnswers, launchBrowser, openApplicationProfile, startTestDashboard, waitUntilConnected,
} from './helpers/dashboardPage.js';

const HOOK_TIMEOUT = 60_000;
const TEMPLATE_STATUS = 'US Citizen | Green Card | H-1B | OPT | ...';

/** Template text in the status AND in the answer it is filled from: nothing can fill it. */
function unanswered(root) {
  editJson(root, 'config/candidate.json', (doc) => { doc.workAuthorization.status = TEMPLATE_STATUS; });
  editJson(root, 'config/screening_answers.json', (doc) => {
    doc.answers.find((a) => a.id === 'work_authorization').answer = 'YOUR truthful authorization status.';
  });
}

/** What saving the answer under Application profile → Saved answers writes. */
function answer(root) {
  editJson(root, 'config/screening_answers.json', (doc) => {
    doc.answers.find((a) => a.id === 'work_authorization').answer = 'Authorized to work in the United States on an H-1B visa.';
  });
}
let browser;
let dash;
let available = true;

beforeAll(async () => {
  try {
    browser = await launchBrowser();
  } catch (err) {
    available = browserUnavailable(err);
    return;
  }
  dash = await startTestDashboard({ prepare: unanswered });
  seedJob(dash.db);
}, HOOK_TIMEOUT);

function seedJob(db) {
  const now = new Date().toISOString();
  db.upsertJob({
    id: 'pb-1', company: 'Acme Analytics', title: 'Senior Platform Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse', score: 88, tier: 'Priority', sponsorship: 'Confirmed', status: 'scored',
    location: 'Remote, US', posted_at: now, created_at: now, jd_text: 'Build services and APIs.',
  });
}

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
}, HOOK_TIMEOUT);

/** `setup` runs before the page loads, so a stubbed route sees the first request. */
async function withPage(fn, setup, which = dash) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await setup?.(page);
    await page.goto(`${which.url}/`);
    await waitUntilConnected(page);
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function openJob(page) {
  await page.getByText('Senior Platform Engineer').first().click();
  await page.locator('.resume-card').first().waitFor();
}

describe('a refused Prepare says why, in the job, until it is fixed', { timeout: 60_000 }, () => {
  it('lists each template value with the answer that fixes it, and keeps Prepare off', async (ctx) => {
    if (!available) return ctx.skip();
    unanswered(dash.root);
    await withPage(async (page) => {
      await openJob(page);
      const box = page.locator('.resume-card .prepare-problem');
      await box.waitFor();
      const text = await box.innerText();
      expect(text).toMatch(/template text/);
      expect(text).toMatch(/work authorization status/);
      expect(text).toContain(TEMPLATE_STATUS);
      // A screen, never a file: the Saved answer this value is filled from.
      expect(text).toContain('Application profile → Saved answers');
      expect(text).toContain('"work_authorization"');
      expect(text).not.toMatch(/\.json/);
      expect(await page.locator('.resume-card [data-action="prepare-one"]').isDisabled()).toBe(true);
      expect(await page.locator('#systemNotices .notice-items').innerText()).toContain('Saved answers');
    });
  });

  it('giving the Saved answer clears the box without restarting the dashboard', async (ctx) => {
    if (!available) return ctx.skip();
    unanswered(dash.root);
    answer(dash.root);
    await withPage(async (page) => {
      await openJob(page);
      await page.locator('#systemNotices .notice-items').waitFor({ state: 'detached' }).catch(() => {});
      expect(await page.locator('.resume-card .prepare-problem').count()).toBe(0);
      expect(await page.locator('.resume-card [data-action="prepare-one"]').isDisabled()).toBe(false);
    });
  });

  it('answering in Application profile turns Prepare back on, with no reload', async (ctx) => {
    if (!available) return ctx.skip();
    // Its own dashboard, booted with the answer missing, as a person's would be.
    const own = await startTestDashboard({ prepare: unanswered });
    seedJob(own.db);
    try {
      await withPage(async (page) => {
        await openJob(page);
        await page.locator('.resume-card .prepare-problem').waitFor();

        await openApplicationProfile(page);
        await expandSavedAnswers(page);
        await answerBox(page, 'work_authorization').fill('Authorized to work in the United States on an H-1B visa.');
        await page.getByRole('button', { name: 'Save all answers' }).click();
        await page.locator('.toast', { hasText: 'Saved' }).first().waitFor();
        await page.keyboard.press('Escape');

        await page.locator('.resume-card .prepare-problem').waitFor({ state: 'detached' });
        expect(await page.locator('.resume-card [data-action="prepare-one"]').isDisabled()).toBe(false);
        expect(await page.locator('#systemNotices .notice-items').count()).toBe(0);
      }, null, own);
    } finally {
      await own.stop();
    }
  });

  it('a Prepare that failed for another reason stays in that job until retried', async (ctx) => {
    if (!available) return ctx.skip();
    // No template text, so the box is about THIS failure, whatever ran first.
    answer(dash.root);
    await withPage(async (page) => {
      await openJob(page);
      const box = page.locator('.resume-card .prepare-problem');
      await box.waitFor();
      expect(await box.innerText()).toMatch(/last Prepare of this job failed[\s\S]*the employer closed this posting/);
    }, (page) => page.route('**/api/run/status', async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({
        json: {
          ...real,
          running: false,
          lastResult: {
            phase: 'prepare-selected', counters: { jobs_prepared: 0 }, prepared: [],
            failed: [{ jobId: 'pb-1', error: 'the employer closed this posting' }],
          },
        },
      });
    }));
  });
});
