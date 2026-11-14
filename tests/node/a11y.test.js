/**
 * Accessibility, checked with axe-core in a real browser against the real
 * dashboard (P1-9). Each state a person reaches is scanned for WCAG 2.0, 2.1
 * and 2.2 A/AA problems: the board with jobs in both themes, a job's detail,
 * the stage tabs, and every dialog that opens from a menu.
 *
 * The gate: no "serious" or "critical" violation anywhere. Known "moderate"
 * or "minor" findings must be listed in KNOWN_MINOR with a reason, so a new
 * one fails the run instead of joining a silent pile.
 *
 * Self-skips when no browser can launch, like the other browser suites.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** rule id -> why it is accepted for now. Only moderate/minor rules may be listed. */
const KNOWN_MINOR = {};

const HOOK_TIMEOUT = 60_000;
let browser;
let dash;
let available = true;

function seed(db) {
  const now = new Date().toISOString();
  db.upsertJob({
    id: 'a11y-1', company: 'Acme Analytics', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse', score: 88, tier: 'Priority', sponsorship: 'Confirmed', status: 'scored',
    location: 'Remote, US', posted_at: now, created_at: now, jd_text: 'Build pipelines with Python and SQL.',
  });
  db.upsertJob({
    id: 'a11y-2', company: 'Globex', title: 'BI Engineer', url: 'https://jobs.lever.co/globex/2',
    source: 'lever', score: 64, tier: 'Queue', status: 'scored', location: 'Austin, TX', posted_at: now, created_at: now,
  });
}

beforeAll(async () => {
  try {
    browser = await launchBrowser();
  } catch (err) {
    available = browserUnavailable(err);
    return;
  }
  // The inbox is set up here, so its menu item is listed (it is hidden until configured).
  dash = await startTestDashboard({ deps: { inboxSettings: { enabled: true, reason: null } } });
  seed(dash.db);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
}, HOOK_TIMEOUT);

/** A page on the dashboard. axe is injected as a script, so the context bypasses CSP for the test only. */
async function withPage(fn, { theme } = {}) {
  // reducedMotion: dialogs fade in, and a scan taken mid-fade measured text at
  // 85% opacity (4.36:1) instead of its real colour. The app honours reduced
  // motion, so the page settles at once and axe sees the final colours.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, bypassCSP: true, colorScheme: theme, reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  // A stuck wait must fail the test quickly, not outlive it.
  page.setDefaultTimeout(20_000);
  try {
    await page.goto(`${dash.url}/`);
    await waitUntilConnected(page);
    await page.addScriptTag({ path: AXE_PATH });
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** Violations as compact records. */
async function scan(page) {
  return page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, count: v.nodes.length,
      targets: v.nodes.slice(0, 4).map((n) => {
        const d = n.any?.[0]?.data;
        const colors = d && d.fgColor ? ` [${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1]` : '';
        return `${n.target.join(' ')}${colors}`;
      }),
    }));
  }, TAGS);
}

function assertAccessible(violations, where) {
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const unlisted = violations.filter((v) => !blocking.includes(v) && !KNOWN_MINOR[v.id]);
  const report = (list) => list.map((v) => `${v.impact} ${v.id} (${v.count}): ${v.help} -> ${v.targets.join(' | ')}`).join('\n');
  expect(blocking, `${where}: serious/critical\n${report(blocking)}`).toEqual([]);
  expect(unlisted, `${where}: moderate/minor not in KNOWN_MINOR\n${report(unlisted)}`).toEqual([]);
}

async function openMenuItem(page, toggleAction, itemName) {
  await page.locator(`[data-action="${toggleAction}"]`).first().click();
  await page.getByRole('menuitem', { name: itemName }).click();
}

describe('accessibility (axe, WCAG 2.2 A/AA)', { timeout: 120_000 }, () => {
  for (const theme of ['dark', 'light']) {
    for (const [view, label] of [['today', 'Today'], ['board', 'Jobs'], ['applications', 'Applications']]) {
      it(`the ${label} view in the ${theme} theme`, async (ctx) => {
        if (!available) return ctx.skip();
        await withPage(async (page) => {
          await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
          await page.locator(`header [data-action="set-view"][data-view="${view}"], [data-action="set-view"][data-view="${view}"]`).first().click();
          if (view === 'board') await page.locator('#boardwrap').getByText('Senior Data Engineer').first().waitFor({ timeout: 10_000 });
          assertAccessible(await scan(page), `${label} (${theme})`);
        }, { theme });
      });
    }
  }

  it('every stage tab of the Jobs board', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await page.locator('[data-action="set-view"][data-view="board"]').first().click();
      const tabs = page.locator('#tabs [role="tab"]:visible');
      await tabs.first().waitFor({ timeout: 10_000 });
      const count = await tabs.count();
      for (let i = 0; i < count; i += 1) {
        await tabs.nth(i).click({ timeout: 5_000 });
        assertAccessible(await scan(page), `tab ${i + 1} of ${count}`);
      }
    });
  });

  it("a job's detail panel", async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await page.getByText('Senior Data Engineer').first().click();
      await page.locator('#detail, .detail, [data-detail]').first().waitFor({ state: 'visible' }).catch(() => {});
      assertAccessible(await scan(page), 'job detail');
    });
  });

  const dialogs = [
    ['Application profile', 'toggle-account-menu', 'Application profile', 'dlgProfile'],
    ['Add profile', 'toggle-account-menu', 'Add profile', null],
    ['Keyboard shortcuts', 'toggle-account-menu', 'Keyboard shortcuts', null],
    ['Master cover letter', 'toggle-account-menu', 'Master cover letter', null],
    ['Run history', 'toggle-activity-menu', 'Run history', null],
    ['System health', 'toggle-activity-menu', 'System health', null],
    ['Email these jobs', 'toggle-activity-menu', 'Email these jobs', 'dlgEmail'],
    ['Email replies', 'toggle-activity-menu', 'Email replies', 'dlgInbox'],
  ];
  for (const [label, toggle, item] of dialogs) {
    it(`the ${label} dialog`, async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openMenuItem(page, toggle, item);
        await page.locator('dialog[open]').first().waitFor();
        assertAccessible(await scan(page), `${label} dialog`);
      });
    });
  }

  it('the changelog dialog', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await page.locator('[data-action="open-changelog"]').click();
      await page.locator('#dlgChangelog[open]').waitFor();
      assertAccessible(await scan(page), 'changelog dialog');
    });
  });
});
