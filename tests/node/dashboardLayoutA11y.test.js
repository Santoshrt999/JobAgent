/**
 * Layout and keyboard contracts measured in a real browser (audit 2026-11-13:
 * BUG-11, BUG-12 and the "vertical chrome" findings).
 *
 * Measured before the fix at 1280x800: the first job row started at 369px,
 * selecting one row covered every column name and sort control, and reaching
 * the pager took 300 Tab presses. Jobs here are fictional.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchBrowser, startTestDashboard, waitUntilConnected, FIRST_LOAD_TIMEOUT_MS } from './helpers/dashboardPage.js';
import { browserUnavailable } from './helpers/browser.js';

let browser; let dash; let skip = false;

beforeAll(async () => {
  try { browser = await launchBrowser(); } catch (err) { skip = !browserUnavailable(err); return; }
  dash = await startTestDashboard();
  const now = Date.now();
  const statuses = ['scored', 'scored', 'scored', 'submitted', 'prepared'];
  for (let i = 0; i < 40; i += 1) {
    const status = statuses[i % statuses.length];
    dash.db.upsertJob({
      id: `job-${i}`, title: `Data Engineer ${i}`, company: `Northwind ${i % 7}`, location: 'Remote, US',
      source: 'greenhouse', url: `https://example.com/jobs/${i}`, score: 95 - i, tier: 'Apply', status,
      applied: status === 'submitted' ? 1 : 0, sponsorship: 'Likely', discovery_mode: 'profile',
      posted_at: new Date(now - (i % 10) * 86_400_000).toISOString(), jd_text: 'Python and SQL.',
    });
  }
}, FIRST_LOAD_TIMEOUT_MS);
afterAll(async () => { await browser?.close(); await dash?.stop(); });

async function openJobs(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${dash.url}/`);
  await waitUntilConnected(page);
  await page.click('[data-action="set-view"][data-view="board"]');
  await page.waitForSelector('#rows tr.job');
  return page;
}

describe('the Jobs board at 1280x800', () => {
  it('starts the first row within 300px, keeps the ticked row still, and keeps column headers visible', async () => {
    if (skip) return;
    const page = await openJobs(1280, 800);
    // 369px before the audit; the toolbar takes no room until rows are ticked.
    const rowTop = () => page.evaluate(() => document.querySelectorAll('#rows tr.job')[2].getBoundingClientRect().top);
    expect(await page.evaluate(() => document.querySelector('#rows tr.job').getBoundingClientRect().top)).toBeLessThanOrEqual(300);

    const before = await rowTop();
    await page.locator('#rows tr.job input[type=checkbox]').nth(2).check();
    await expect.poll(() => page.evaluate(() => document.getElementById('selbar').dataset.open)).toBe('true');
    // Opening the toolbar scrolls the page by its height: the clicked row does not move.
    expect(Math.abs((await rowTop()) - before)).toBeLessThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => document.getElementById('selbar').dataset.open)).toBe('true');
    const covered = await page.evaluate(() => {
      const th = document.querySelector('thead th.sortable');
      const r = th.getBoundingClientRect();
      return !document.elementFromPoint(r.left + 8, r.top + r.height / 2)?.closest('thead');
    });
    expect(covered).toBe(false);
    // The toolbar sits directly above the headers and overlaps no job row.
    const geo = await page.evaluate(() => ({
      bar: document.getElementById('selbar').getBoundingClientRect().bottom,
      head: document.querySelector('thead th').getBoundingClientRect().top,
      row: document.querySelector('#rows tr.job').getBoundingClientRect().top,
    }));
    expect(Math.abs(geo.bar - geo.head)).toBeLessThanOrEqual(1);
    expect(geo.row).toBeGreaterThanOrEqual(geo.bar);
    await page.close();
  });

  it('puts the whole board behind one tab stop, moved with arrows and j/k', async () => {
    if (skip) return;
    const page = await openJobs(1280, 800);
    const stops = await page.evaluate(() => [...document.querySelectorAll('#rows tr.job, #rows a[href], #rows button, #rows input')]
      .filter((e) => e.tabIndex >= 0 && !e.disabled).length);
    expect(stops).toBeLessThanOrEqual(4);
    await page.locator('#rows tr.job').first().focus();
    await page.keyboard.press('j');
    const second = await page.evaluate(() => document.activeElement?.dataset.id);
    expect(second).toBe(await page.evaluate(() => document.querySelectorAll('#rows tr.job')[1].dataset.id));
    expect(await page.evaluate(() => document.activeElement.tabIndex)).toBe(0);
    await page.close();
  });

  it('names every input and lands pagination in a navigation landmark', async () => {
    if (skip) return;
    const page = await openJobs(1280, 800);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
      .filter((e) => !(e.getAttribute('aria-label') || e.labels?.length || e.getAttribute('aria-labelledby') || e.title))
      .map((e) => e.id || e.name || e.type));
    expect(unnamed).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('pager').closest('nav[aria-label="Pagination"]') !== null)).toBe(true);
    await page.close();
  });

  it('leaves jobs already applied to off the Jobs list', async () => {
    if (skip) return;
    const page = await openJobs(1280, 800);
    const statuses = await page.evaluate(() => [...document.querySelectorAll('#rows tr.job')].map((r) => r.dataset.id));
    const submitted = Array.from({ length: 40 }, (_, i) => i).filter((i) => i % 5 === 3).map((i) => `job-${i}`);
    for (const id of submitted) expect(statuses).not.toContain(id);
    await page.close();
  });
});

describe('switching views keeps the detail rail honest (BUG-11)', () => {
  it('a discovery job open in Jobs does not stay open beside Applications', async () => {
    if (skip) return;
    const page = await openJobs(1440, 900);
    const scoredRow = page.locator('#rows tr.job[data-id="job-0"]');
    await scoredRow.click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#detail [data-job-id]')?.dataset.jobId)).toBe('job-0');
    await page.click('[data-action="set-view"][data-view="applications"]');
    await expect.poll(() => page.evaluate(() => document.querySelector('#detail [data-job-id]')?.dataset.jobId ?? null))
      .not.toBe('job-0');
    await page.close();
  });
});

describe('the command palette (⌘K / Ctrl+K)', () => {
  it('opens on Ctrl+K, finds a command by typing, and runs it with Enter', async () => {
    if (skip) return;
    const page = await openJobs(1280, 800);
    await page.keyboard.press('Control+k');
    await expect.poll(() => page.evaluate(() => document.getElementById('dlgPalette').open)).toBe(true);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('paletteInput');
    await page.keyboard.type('data qual');
    await expect.poll(() => page.evaluate(() => document.querySelector('#paletteList [aria-selected="true"]')?.textContent)).toContain('Data quality');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.getElementById('dlgPalette').open)).toBe(false);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join(','))).toMatch(/Quality|quality/i);
    await page.close();
  });

  it('finds a loaded job by its title and opens it in the rail', async () => {
    if (skip) return;
    const page = await openJobs(1440, 900);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Data Engineer 7');
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#paletteList [role="option"]')].some((o) => o.textContent.includes('Data Engineer 7')))).toBe(true);
    await page.evaluate(() => [...document.querySelectorAll('#paletteList [role="option"]')].find((o) => o.textContent.includes('Data Engineer 7')).click());
    await expect.poll(() => page.evaluate(() => document.querySelector('#detail [data-job-id]')?.dataset.jobId)).toBe('job-7');
    await page.close();
  });
});
