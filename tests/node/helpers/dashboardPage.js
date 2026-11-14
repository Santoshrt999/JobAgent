/**
 * A real dashboard on a PRIVATE copy of the test workspace, plus a real browser.
 *
 * The profile dialogs are interaction bugs (a dialog that closes, a field that
 * resets), so they can only be tested in a browser against the real front-end
 * modules — pulling functions out of the source text and running them in a blank
 * page cannot see a re-render, a focus change or a backdrop click.
 *
 * Why a private workspace: the suite-wide one from globalSetup is shared by every
 * test file running in parallel, and these tests SAVE (they edit candidate.json
 * and screening_answers.json). A private copy keeps those writes from changing
 * what another file reads.
 *
 * Launching honours BROWSER_CHANNEL (the same variable the product uses), so a
 * machine with Chrome but no downloaded Chromium can run them:
 *   BROWSER_CHANNEL=chrome npx vitest run tests/node/profileDialogStability.test.js
 */

import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { buildTestRoot } from '../globalSetup.js';
import { loadConfig } from '../../../src/config/loadConfig.js';
import { openDatabase } from '../../../src/logging/db.js';
import { startDashboard } from '../../../src/dashboard/server.js';

export function launchBrowser() {
  const channel = process.env.BROWSER_CHANNEL;
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

/**
 * @param {object} [options]
 * @param {(root: string) => void} [options.prepare] edit the private workspace before the server reads it
 * @returns {Promise<{ url: string, root: string, stop: () => Promise<void> }>}
 */
export async function startTestDashboard({ prepare, deps: extraDeps = {} } = {}) {
  const root = buildTestRoot();
  prepare?.(root);
  const loadHere = (opts = {}) => loadConfig({ ...opts, root });
  const config = loadHere({ loadEnv: false });
  const db = openDatabase({ path: ':memory:' });
  const dash = await startDashboard({
    config, db, logger: null, port: 0, deps: { loadConfigImpl: loadHere, ...extraDeps },
  });
  return {
    url: dash.url,
    root,
    db,
    async stop() {
      await dash.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Rewrite one JSON file of the private workspace. */
export function editJson(root, relPath, mutate) {
  const file = join(root, relPath);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  mutate(doc);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * How long the FIRST load may take: the page fetches every front-end module and
 * makes its first request. Generous on purpose: on a busy CI runner, with
 * several test files each driving its own Chromium, this took over 15 s on
 * Windows / Node 22 (2026-11-11) while the same page loads in under 1 s alone.
 * Only this wait is long; every later step keeps the test's own short timeout,
 * so a real bug still fails fast.
 */
export const FIRST_LOAD_TIMEOUT_MS = 45_000;

/**
 * Wait until the page says "Connected". That appears only after the page's
 * scripts have run (and attached their click handlers) and the first request
 * came back. The menu EXISTS in the HTML long before that, and a click on it in
 * between is silently lost.
 */
export async function waitUntilConnected(page) {
  await page.locator('#conn.ok').waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
}

/** A page on the dashboard, with the board loaded. */
export async function openDashboard(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${url}/`);
  await waitUntilConnected(page);
  return { page, context };
}

/** Header menu -> Application profile, the way a person gets there. */
export async function openApplicationProfile(page) {
  await page.locator('[data-action="toggle-account-menu"]').click();
  await page.getByRole('menuitem', { name: 'Application profile' }).click();
  await page.locator('#dlgProfile[open] .pf-section').first().waitFor();
}

/** Expand the collapsed "Saved answers" list, as a person does before editing one. */
export async function expandSavedAnswers(page) {
  const summary = page.locator('#dlgProfile summary', { hasText: 'Saved answers' });
  if (!(await page.locator('#dlgProfile details.pf-saved[open]').count())) await summary.click();
}

export const answerBox = (page, id) => page.locator(`[data-a-answer="${id}"]`);

/** Header menu -> "Add profile…", the way a person gets to the Add form. */
export async function openAddProfileDialog(page) {
  await page.locator('[data-action="toggle-account-menu"]').click();
  await page.getByRole('menuitem', { name: /Add profile/ }).click();
  await page.locator('#dlgPerson[open]').waitFor();
}

/** Header menu -> Master resume -> the first profile's Edit button. */
export async function openEditProfileDialog(page) {
  await page.locator('[data-action="toggle-account-menu"]').click();
  await page.getByRole('menuitem', { name: 'Master resume' }).click();
  await page.locator('#dlgMaster [data-action="open-edit-profile"]').first().click();
  await page.locator('#dlgPerson[open]').waitFor();
}

/** Save a search profile through the API, so there is someone to edit. */
export async function createProfile(url, fields) {
  const res = await fetch(`${url}/api/search-profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Job-Agent': '1' },
    body: JSON.stringify({ fields, activate: true }),
  });
  if (!res.ok) throw new Error(`could not create the test profile: HTTP ${res.status}`);
}

/** A click on the dimmed area outside every dialog (the corner is always backdrop). */
export const clickBackdrop = (page) => page.mouse.click(4, 4);

export const isOpen = (page, id) => page.evaluate((d) => document.getElementById(d)?.open === true, id);

/** Every PATCH the page sends (the Edit profile form saves with PATCH). */
export function watchPatches(page) {
  const sent = [];
  page.on('request', (r) => { if (r.method() === 'PATCH') sent.push(r.url()); });
  return sent;
}

/**
 * Run `action`, then wait until the Application profile dialog has REBUILT its
 * body. A test that asserts "my text survived the re-render" must know the
 * re-render happened first; asserting straight after the click passes by
 * accident, because the save's toast appears before the rebuild finishes.
 */
export async function afterRerender(page, action) {
  await page.evaluate(() => {
    document.querySelector('#profileBody').firstElementChild.dataset.stale = '1';
  });
  await action();
  await page.waitForFunction(() => {
    const body = document.querySelector('#profileBody');
    return body.children.length > 0 && !body.querySelector(':scope > [data-stale]');
  });
}
