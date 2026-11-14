/**
 * The browser extension on modern application forms (audit BUG-06).
 *
 * Greenhouse, Ashby, Lever and Workday mark custom selects and radio groups
 * with aria-required="true" and no native `required`. The content script only
 * checked [required], so it reported readyForReview with required answers still
 * empty. And the popup replaced the dashboard tab with the posting, losing the
 * person's place there, without checking the address was a web address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAYLOAD = {
  job: { id: 'j1' }, artifacts: {},
  profile: { identity: { fullName: 'Ada Lovelace' }, contact: { email: 'ada@example.test' } },
  screeningAnswers: [],
};

async function fill(page, html) {
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } },
        sendMessage: async () => ({ ok: false }),
      },
    };
  });
  await page.setContent(`<style>input,select,button,div[role]{display:block;width:240px;min-height:28px;margin:8px}</style>
    <form id="application">${html}<button type="submit">Submit application</button></form>`);
  await page.addScriptTag({ path: resolve('extension/content.js') });
  return page.evaluate((payload) => new Promise((done) => {
    globalThis.__jobAgentListener({ type: 'JOB_AGENT_FILL', payload, connection: { trustedHost: true } }, null, done);
  }), PAYLOAD);
}

describe('required fields the way modern forms mark them', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('an empty aria-required custom select and radio group block "ready for review"', async () => {
    const page = await browser.newPage();
    const result = await fill(page, `
      <label>First name <input id="first"></label>
      <label>Email <input id="email" type="email"></label>
      <div class="select__container">
        <span id="lbl-degree">Highest degree</span>
        <input role="combobox" aria-required="true" aria-labelledby="lbl-degree" id="degree">
      </div>
      <div role="radiogroup" aria-required="true" aria-label="Are you over 18?">
        <label><input type="radio" name="adult" value="yes"> Yes</label>
        <label><input type="radio" name="adult" value="no"> No</label>
      </div>`);
    expect(result.filled.length).toBeGreaterThan(0);
    expect(result.requiredMissing).toEqual(expect.arrayContaining(['Highest degree', 'Are you over 18?']));
    expect(result.readyForReview).toBe(false);
    await page.close();
  }, 30_000);

  it('a custom select showing its chosen value, and an answered group, count as answered', async () => {
    const page = await browser.newPage();
    const result = await fill(page, `
      <label>First name <input id="first"></label>
      <div class="select__container">
        <span id="lbl-degree">Highest degree</span>
        <input role="combobox" aria-required="true" aria-labelledby="lbl-degree">
        <div class="select__single-value">Master's</div>
        <input type="hidden" name="degree" value="masters">
      </div>
      <div role="radiogroup" aria-required="true" aria-label="Are you over 18?">
        <label><input type="radio" name="adult" value="yes" checked> Yes</label>
      </div>`);
    expect(result.requiredMissing).toEqual([]);
    expect(result.readyForReview).toBe(true);
    await page.close();
  }, 30_000);
});

describe('opening the posting from the dashboard tab', () => {
  const popup = readFileSync(resolve('extension/popup.js'), 'utf8');

  it('opens a new tab and never replaces the dashboard', () => {
    expect(popup).toMatch(/chrome\.tabs\.create\(\{ url: payload\.job\.url/);
    expect(popup).not.toMatch(/chrome\.tabs\.update\(tab\.id, \{ url: payload\.job\.url/);
  });

  it('opens only http(s) addresses', () => {
    const src = popup.match(/function isWebUrl\(value\) \{[^\n]+\}/)[0];
    const isWebUrl = new Function(`${src}; return isWebUrl;`)();
    expect(isWebUrl('https://boards.example.com/job/1')).toBe(true);
    expect(isWebUrl('http://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x', '', null]) {
      expect(isWebUrl(bad)).toBe(false);
    }
  });
});
