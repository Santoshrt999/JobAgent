/**
 * The live filler must never commit the wrong sponsorship / authorization
 * option.
 *
 * Reproduced before the fix: for "Will you now or in the future require
 * sponsorship?" (a typeahead), a candidate who REQUIRES sponsorship had
 * "I am authorized to work and will not require sponsorship" clicked for them —
 * nothing matched "Yes", so the top option was committed; and a raw substring
 * test let "No" match inside "not" / "now".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import {
  applyValue, fillScannedFields, isSensitiveChoiceLabel, matchOption, sponsorshipChoiceConflict,
} from '../../src/automation/fieldFiller.js';
import { mapToChoice } from '../../src/apply/screeningQA.js';

const SPONSOR_Q = 'Will you now or in the future require sponsorship for employment visa status?';

function comboboxPage(options, { keyboard = true } = {}) {
  const calls = [];
  const page = {
    calls,
    keyboard: keyboard ? { press: async (key) => { calls.push({ action: 'press', key }); } } : undefined,
    locator: (selector) => ({
      count: async () => (selector === '#sponsor' ? 1 : selector.endsWith('[role="option"]') ? options.length : 0),
      first: () => ({
        click: async () => calls.push({ selector, action: 'click' }),
        fill: async (value) => calls.push({ selector, action: 'fill', value }),
      }),
      allTextContents: async () => (selector.endsWith('[role="option"]') ? options : []),
      nth: (i) => ({ click: async () => calls.push({ action: 'optionClick', text: options[i] }) }),
    }),
  };
  return page;
}

describe('sensitive typeahead commits', () => {
  it('does not click the top option or press Enter when nothing matches a sponsorship answer', async () => {
    const page = comboboxPage([
      'I am authorized to work and will not require sponsorship',
      'I will require sponsorship now or in the future',
    ]);
    const res = await applyValue(page, { kind: 'combobox', selector: '#sponsor', label: SPONSOR_Q },
      'Yes, I require sponsorship (H-1B transfer).', { requiresSponsorship: true });
    expect(res.ok).toBe(false);
    expect(page.calls.some((c) => c.action === 'optionClick')).toBe(false);
    expect(page.calls.some((c) => c.action === 'press')).toBe(false);
  });

  it('still auto-picks the top result for an ordinary short value inside the field\'s own list', async () => {
    const page = comboboxPage(['Durham, North Carolina, United States']);
    const res = await applyValue(page, {
      kind: 'combobox', selector: '#sponsor', label: 'Location (City)', listboxSelector: '#sponsor-list',
    }, 'Durhm');
    expect(res).toMatchObject({ ok: true, chosen: 'Durham, North Carolina, United States' });
  });

  it('never trusts a top result found outside the field\'s own list (audit AF-05)', async () => {
    const page = comboboxPage(['Durham, North Carolina, United States']);
    const res = await applyValue(page, { kind: 'combobox', selector: '#sponsor', label: 'Location (City)' }, 'Durhm');
    expect(res.ok).toBe(false);
    expect(page.calls.some((c) => c.action === 'optionClick')).toBe(false);
  });

  it('classifies legal, immigration and EEO labels as sensitive', () => {
    for (const label of [SPONSOR_Q, 'Are you legally authorized to work?', 'US citizen?', 'Security clearance',
      'I consent to the privacy policy', 'I certify the above', 'Veteran status', 'Gender', 'Race/Ethnicity']) {
      expect(isSensitiveChoiceLabel(label), label).toBe(true);
    }
    expect(isSensitiveChoiceLabel('Location (City)')).toBe(false);
  });
});

describe('whole-word option matching', () => {
  it('never matches "No" inside "not" or "now"', () => {
    expect(matchOption([{ label: 'I am authorized and will not require sponsorship', value: 'a' }], 'No')).toBeNull();
    expect(matchOption([{ label: 'Now or in the future', value: 'f' }, { label: 'No', value: 'n' }], 'No'))
      .toEqual({ label: 'No', value: 'n' });
    expect(mapToChoice('No', 'text', ['Now or in the future', 'Maybe'])).toBeNull();
    expect(mapToChoice('No, I do not require sponsorship', 'text', ['Yes', 'No'])).toBe('No');
    expect(mapToChoice('United States', 'text', ['United States of America'])).toBe('United States of America');
  });
});

describe('read-back contradiction check', () => {
  it('flags a committed option that contradicts the candidate', () => {
    expect(sponsorshipChoiceConflict({
      label: SPONSOR_Q, intended: 'Yes', chosen: 'I am authorized to work and will not require sponsorship',
      requiresSponsorship: true,
    })).toMatch(/contradicts your profile/);
    expect(sponsorshipChoiceConflict({ label: SPONSOR_Q, intended: 'No', chosen: 'Yes', requiresSponsorship: false }))
      .toMatch(/opposite/);
    expect(sponsorshipChoiceConflict({
      label: 'Can you work in the US without sponsorship?', intended: 'Yes', chosen: 'Yes',
    })).toMatch(/inverted/);
    expect(sponsorshipChoiceConflict({ label: SPONSOR_Q, intended: 'Yes', chosen: 'Yes', requiresSponsorship: true }))
      .toBeNull();
    expect(sponsorshipChoiceConflict({ label: 'Favourite colour', intended: 'x', chosen: 'y' })).toBeNull();
  });

  it('turns a contradicted radio commit into a required question for the human', async () => {
    const calls = [];
    const page = {
      locator: (selector) => ({
        count: async () => 1,
        first: () => ({
          check: async () => calls.push({ selector, action: 'check' }),
          // The widget reports the committed option differently from its label.
          evaluate: async () => 'No, I will not require sponsorship',
        }),
      }),
    };
    const scanned = [{
      kind: 'radio', selector: null, label: SPONSOR_Q, name: 'sp', required: false,
      options: [{ label: 'Yes', value: 'y', selector: '#y' }, { label: 'No', value: 'n', selector: '#n' }],
    }];
    const res = await fillScannedFields(page, scanned, {
      candidate: { workAuthorization: { requiresSponsorship: true } },
      screeningAnswers: { answers: [{ id: 'sp', patterns: ['require sponsorship'], answer: 'Yes, I require sponsorship.' }] },
    });
    expect(res.filled).toHaveLength(0);
    expect(res.errors[0].error).toMatch(/refused to keep this answer/);
    expect(res.needsUser).toContainEqual(expect.objectContaining({ label: SPONSOR_Q, required: true }));
  });
});

describe('read-back against a live DOM', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('clears a select whose widget committed the opposite answer', async () => {
    const page = await browser.newPage();
    // A widget that "helpfully" flips to the other option on change.
    await page.setContent(`
      <label for="sp">${SPONSOR_Q}</label>
      <select id="sp"><option value="">Select…</option><option value="y">Yes</option><option value="n">No</option></select>
      <script>document.getElementById('sp').addEventListener('change', (e) => {
        if (e.target.value === 'y') e.target.value = 'n';
      });</script>`);
    const field = {
      kind: 'select', selector: '#sp', label: SPONSOR_Q,
      options: [{ label: 'Select…', value: '' }, { label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }],
    };
    const res = await applyValue(page, field, 'Yes', { requiresSponsorship: true });
    expect(res.ok).toBe(false);
    expect(res.chosen).toBe('No');
    expect(await page.inputValue('#sp')).toBe('');
    await page.close();
  }, 30_000);
});
