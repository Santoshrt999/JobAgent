/**
 * The profile dialogs must be stable while someone fills them in.
 *
 * Reported as "the popup closes and nothing is saved". Reproduced in a real
 * browser, the causes were three separate things:
 *
 *   1. Application profile: every save rebuilt the WHOLE dialog from the
 *      server's copy, so text typed into any other section was thrown away
 *      (and the "Saved answers" list snapped shut).
 *   2. Every dialog: a click on the backdrop, or Esc, closed it instantly,
 *      with no check for unsaved text.
 *   3. Add/Edit profile: Enter in ANY field submitted the form and the save
 *      then closed the dialog; a second Enter after adding a job title did it
 *      without the person ever pressing Save.
 *
 * These drive the real dashboard in a real browser (see helpers/dashboardPage.js).
 * They self-skip when no browser can launch, like the other browser suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import {
  afterRerender, answerBox, clickBackdrop, createProfile, editJson, expandSavedAnswers, isOpen, launchBrowser,
  openAddProfileDialog, openApplicationProfile, openDashboard, openEditProfileDialog, startTestDashboard,
  watchPatches,
} from './helpers/dashboardPage.js';

let browser;
let dash;
let available = true;

// Launching a browser and booting a dashboard can take longer than vitest's 10s
// default hook limit on a busy machine; that is slowness, not a failure.
const HOOK_TIMEOUT = 60_000;

beforeAll(async () => {
  try {
    browser = await launchBrowser();
  } catch (err) {
    available = browserUnavailable(err);
    return;
  }
  dash = await startTestDashboard();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
}, HOOK_TIMEOUT);

/** Run `fn` on a fresh page of a dashboard (the shared one by default), always cleaning up. */
async function withPage(fn, which = dash) {
  const { page, context } = await openDashboard(browser, which.url);
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

describe('Application profile: unsaved edits survive a re-render', { timeout: 30_000 }, () => {
  it('keeps an unsaved answer, and the open list, when the details section is saved', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      await answerBox(page, 'work_authorization').fill('Typed here, not saved yet');
      await page.locator('#pf-city').fill('Denver');

      await afterRerender(page, () => page.getByRole('button', { name: 'Save details' }).click());

      // The city WAS saved, so the rebuilt form shows it ...
      expect(await page.locator('#pf-city').inputValue()).toBe('Denver');
      // ... and the answer that was never saved is still what the person typed.
      expect(await answerBox(page, 'work_authorization').inputValue()).toBe('Typed here, not saved yet');
      // The list they had open is still open (it used to snap shut).
      expect(await page.locator('#dlgProfile details.pf-saved[open]').count()).toBe(1);
    });
  });

  it('keeps an unsaved details edit when the answers are saved', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      await page.locator('#pf-phone').fill('555 0100 typed');
      await answerBox(page, 'relocation').fill('Yes, open to relocating within the US.');

      await afterRerender(page, () => page.getByRole('button', { name: 'Save all answers' }).click());

      expect(await answerBox(page, 'relocation').inputValue()).toBe('Yes, open to relocating within the US.');
      expect(await page.locator('#pf-phone').inputValue()).toBe('555 0100 typed');
    });
  });
});

describe('Unsaved text is never thrown away by closing', { timeout: 30_000 }, () => {
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard();
    await createProfile(own.url, {
      fullName: 'Casey Fixture', email: 'casey@example.com', targetRoles: ['Data Engineer'], city: 'Austin', state: 'TX',
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  const typeAnAnswer = async (page) => {
    await openApplicationProfile(page);
    await expandSavedAnswers(page);
    await answerBox(page, 'work_authorization').fill('Typed, not saved yet');
  };

  it('ignores a click on the backdrop while there is unsaved text', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await typeAnAnswer(page);
      await clickBackdrop(page);
      expect(await isOpen(page, 'dlgProfile')).toBe(true);
      expect(await answerBox(page, 'work_authorization').inputValue()).toBe('Typed, not saved yet');
    }, own);
  });

  it('still closes on a backdrop click when nothing was changed', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await clickBackdrop(page);
      expect(await isOpen(page, 'dlgProfile')).toBe(false);
    }, own);
  });

  it('asks before discarding on Esc, and "Keep editing" returns to the same text', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await typeAnAnswer(page);
      await page.keyboard.press('Escape');
      await page.locator('#dlgConfirm[open]').waitFor();
      expect(await page.locator('#dlgConfirmTitle').innerText()).toBe('Discard unsaved changes?');

      await page.getByRole('button', { name: 'Keep editing' }).click();
      expect(await isOpen(page, 'dlgConfirm')).toBe(false);
      expect(await isOpen(page, 'dlgProfile')).toBe(true);
      expect(await answerBox(page, 'work_authorization').inputValue()).toBe('Typed, not saved yet');
    }, own);
  });

  it('"Discard changes" closes it, and the next visit starts from what is saved', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await typeAnAnswer(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Discard changes' }).click();
      expect(await isOpen(page, 'dlgProfile')).toBe(false);

      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      expect(await answerBox(page, 'work_authorization').inputValue()).not.toBe('Typed, not saved yet');
    }, own);
  });

  it('asks on the Close button too, but closes straight away when nothing changed', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await page.locator('#dlgProfile .dlg-foot').getByRole('button', { name: 'Close' }).click();
      expect(await isOpen(page, 'dlgProfile')).toBe(false); // clean: no prompt

      await typeAnAnswer(page);
      await page.locator('#dlgProfile .dlg-foot').getByRole('button', { name: 'Close' }).click();
      await page.locator('#dlgConfirm[open]').waitFor();
      expect(await isOpen(page, 'dlgProfile')).toBe(true);
    }, own);
  });

  it('Add profile: a click outside and Esc both protect what was typed', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openAddProfileDialog(page);
      await page.locator('#personName').fill('Jordan Fixture');
      await clickBackdrop(page);
      expect(await isOpen(page, 'dlgPerson')).toBe(true);
      await page.keyboard.press('Escape');
      await page.locator('#dlgConfirm[open]').waitFor();
      expect(await page.locator('#personName').inputValue()).toBe('Jordan Fixture');
    }, own);
  });
});

describe('Edit profile: Enter never saves or closes by accident', { timeout: 30_000 }, () => {
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard();
    await createProfile(own.url, {
      fullName: 'Casey Fixture', email: 'casey@example.com', targetRoles: ['Data Engineer'], city: 'Austin', state: 'TX',
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  it('Enter in a field leaves the dialog open and saves nothing', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const patches = watchPatches(page);
      await openEditProfileDialog(page);
      await page.locator('#personCity').fill('Denver');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      expect(await isOpen(page, 'dlgPerson')).toBe(true);
      expect(patches).toEqual([]);
      expect(await page.locator('#personCity').inputValue()).toBe('Denver');
    }, own);
  });

  it('a second Enter after adding a job title does not save or close either', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const patches = watchPatches(page);
      await openEditProfileDialog(page);
      await page.locator('#personRoleInput').fill('Analytics Engineer');
      await page.keyboard.press('Enter'); // adds the chip
      expect(await page.locator('#personRoleList li').count()).toBe(2);
      await page.keyboard.press('Enter'); // the press that used to save and close
      await page.waitForTimeout(600);
      expect(await isOpen(page, 'dlgPerson')).toBe(true);
      expect(patches).toEqual([]);
    }, own);
  });

  it('Ctrl+Enter is the deliberate keyboard save', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const patches = watchPatches(page);
      await openEditProfileDialog(page);
      await page.locator('#personCity').fill('Denver');
      await page.keyboard.press('Control+Enter');
      await page.locator('#dlgPerson').waitFor({ state: 'hidden' });
      expect(patches.length).toBe(1);
    }, own);
  });

  it('in the Application profile details, Enter does not save but Ctrl+Enter does', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      let saves = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/profile')) saves += 1; });
      await openApplicationProfile(page);
      await page.locator('#pf-city').fill('Denver');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      expect(saves).toBe(0);
      await afterRerender(page, () => page.keyboard.press('Control+Enter'));
      expect(saves).toBe(1);
    }, own);
  });
});

describe('Template text is a placeholder, never a saved value', { timeout: 30_000 }, () => {
  const TEMPLATE_YEARS = 'YOUR total years of professional experience.';
  const TEMPLATE_CHECK = 'YOUR answer about background checks.';
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard({
      prepare: (root) => {
        editJson(root, 'config/screening_answers.json', (doc) => {
          doc.answers.find((a) => a.id === 'years_experience').answer = TEMPLATE_YEARS;
          doc.answers.find((a) => a.id === 'background_check').answer = TEMPLATE_CHECK;
        });
        editJson(root, 'config/candidate.json', (c) => { c.location.city = 'Your City'; });
      },
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  /** Record every POST the page sends, with its parsed JSON body. */
  const watchPosts = (page) => {
    const sent = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') sent.push({ url: new URL(r.url()).pathname, body: JSON.parse(r.postData() || '{}') });
    });
    return sent;
  };

  it('shows template text as grey placeholder text in an empty box', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      const years = answerBox(page, 'years_experience');
      expect(await years.inputValue()).toBe('');
      expect(await years.getAttribute('placeholder')).toBe(TEMPLATE_YEARS);
      expect(await page.locator('#pf-city').inputValue()).toBe('');
      expect(await page.locator('#pf-city').getAttribute('placeholder')).toBe('Your City');

      // Grey: the placeholder's colour is not the colour typed text would have.
      const [placeholder, typed] = await years.evaluate((n) => [
        getComputedStyle(n, '::placeholder').color, getComputedStyle(n).color,
      ]);
      expect(placeholder).not.toBe(typed);
    }, own);
  });

  it('saves an untouched template exactly as stored, and sends no template detail at all', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const posts = watchPosts(page);
      await openApplicationProfile(page);
      await expandSavedAnswers(page);

      await page.locator('#pf-phone').fill('9195550199');
      await afterRerender(page, () => page.getByRole('button', { name: 'Save details' }).click());
      const details = posts.find((p) => p.url === '/api/profile');
      // The city is still template text and was never touched: it is not sent.
      expect(Object.keys(details.body.values)).not.toContain('location.city');
      expect(details.body.values['contact.phone']).toBe('9195550199');

      await afterRerender(page, () => page.getByRole('button', { name: 'Save all answers' }).click());
      const answers = posts.find((p) => p.url === '/api/profile/answers').body.answers;
      // An untouched template answer is the entry as it already is on disk,
      // not an answer the person typed.
      expect(answers.find((a) => a.id === 'years_experience').answer).toBe(TEMPLATE_YEARS);
    }, own);
  });

  it('typing replaces the placeholder, and the typed text is what is saved and shown next time', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const posts = watchPosts(page);
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      await answerBox(page, 'background_check').fill('Yes, willing to complete one.');
      await afterRerender(page, () => page.getByRole('button', { name: 'Save all answers' }).click());
      const sent = posts.find((p) => p.url === '/api/profile/answers').body.answers;
      expect(sent.find((a) => a.id === 'background_check').answer).toBe('Yes, willing to complete one.');
    }, own);

    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      const box = answerBox(page, 'background_check');
      expect(await box.inputValue()).toBe('Yes, willing to complete one.');
      expect(await box.getAttribute('placeholder')).toBeNull();
    }, own);
  });

  it('Add profile: boxes carry grey examples and the level starts on a "Select" prompt', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openAddProfileDialog(page);
      for (const id of ['personName', 'personEmail', 'personCity', 'personState']) {
        expect(await page.locator(`#${id}`).inputValue()).toBe('');
        expect(await page.locator(`#${id}`).getAttribute('placeholder')).toMatch(/^e\.g\., /);
      }
      const level = page.locator('#personSeniority');
      expect(await level.evaluate((n) => n.selectedOptions[0].textContent)).toBe('Select a level (optional)');
      const prompt = await level.evaluate((n) => getComputedStyle(n).color);
      await level.selectOption('senior');
      expect(await level.evaluate((n) => getComputedStyle(n).color)).not.toBe(prompt);
    }, own);
  });
});

describe('Edit profile: clear rules, specific messages, honest save states', { timeout: 40_000 }, () => {
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard();
    await createProfile(own.url, {
      fullName: 'Casey Fixture', email: 'casey@example.com', targetRoles: ['Data Engineer'], city: 'Austin', state: 'TX',
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  const visible = (page, selector) => page.locator(selector).isVisible();
  const text = (page, selector) => page.locator(selector).innerText();
  const jsonRoute = (status, body) => (route) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  describe('Add / Edit profile', () => {
    it('marks what is required and what is optional', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openAddProfileDialog(page);
        expect(await text(page, '#personLegend')).toMatch(/Required/);
        expect(await page.locator('#dlgPerson label .req').count()).toBe(3);
        for (const id of ['personCity', 'personState', 'personSeniority']) {
          expect(await text(page, `label[for="${id}"]`), id).toMatch(/optional/i);
        }
      }, own);
    });

    it('keeps Save off until the required fields are valid, and says what is missing', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openAddProfileDialog(page);
        expect(await page.locator('#personSave').isDisabled()).toBe(true);
        const why = await text(page, '#personSaveWhy');
        expect(why).toMatch(/first and last name/);
        expect(why).toMatch(/email/);
        expect(why).toMatch(/job title/);

        await page.locator('#personName').fill('Alex Morgan');
        expect(await text(page, '#personSaveWhy')).not.toMatch(/first and last name/);
        await page.locator('#personEmail').fill('alex@example.com');
        await page.locator('#personRoleInput').fill('Data Engineer');
        // A title typed but not yet turned into a chip already counts.
        expect(await page.locator('#personSave').isDisabled()).toBe(false);
        expect(await text(page, '#personSaveWhy')).toBe('');
      }, own);
    });

    it('shows a problem when the field is left, not on every keystroke', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openAddProfileDialog(page);
        await page.locator('#personName').pressSequentially('Al');
        expect(await visible(page, '#personNameError')).toBe(false); // still typing

        await page.keyboard.press('Tab'); // leaving the field
        expect(await text(page, '#personNameError')).toBe('Enter a first and last name.');
        expect(await page.locator('#personName').getAttribute('aria-invalid')).toBe('true');

        // Back in the box, the caret is NOT where typing stopped: refocusing puts it at the start,
        // so typing straight away would make " MorganAl". Move to the end, as a person would.
        await page.locator('#personName').focus();
        await page.keyboard.press('End');
        await page.keyboard.type(' Morgan');
        expect(await page.locator('#personName').inputValue()).toBe('Al Morgan');
        expect(await visible(page, '#personNameError')).toBe(false); // fixed: cleared at once

        await page.locator('#personEmail').pressSequentially('alex@');
        await page.keyboard.press('Tab');
        expect(await text(page, '#personEmailError')).toBe('Enter a valid email address, like name@example.com.');
      }, own);
    });

    it('Edit: Save stays off until something actually changes', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openEditProfileDialog(page);
        expect(await page.locator('#personSave').isDisabled()).toBe(true);
        expect(await text(page, '#personSaveWhy')).toBe('No changes to save yet.');
        await page.locator('#personCity').fill('Denver');
        expect(await page.locator('#personSave').isDisabled()).toBe(false);
      }, own);
    });

    it('a failed save keeps what was typed, says why, and leaves Save usable', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await page.route(/\/api\/search-profiles\/[^/]+$/, (route) => (route.request().method() === 'PATCH'
          ? jsonRoute(500, { error: 'disk full' })(route) : route.continue()));
        await openEditProfileDialog(page);
        await page.locator('#personCity').fill('Denver');
        await page.locator('#personSave').click();
        await page.locator('#personFormError:not([hidden])').waitFor();

        expect(await text(page, '#personFormError')).toMatch(/disk full/);
        expect(await isOpen(page, 'dlgPerson')).toBe(true);
        expect(await page.locator('#personCity').inputValue()).toBe('Denver');
        expect(await page.locator('#personSave').isDisabled()).toBe(false);
        expect(await text(page, '#personSave')).toBe('Save changes');
      }, own);
    });

    it('shows Saving… while the save is in flight, then confirms it', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await page.route(/\/api\/search-profiles\/[^/]+$/, async (route) => {
          if (route.request().method() !== 'PATCH') return route.continue();
          await new Promise((resolve) => { setTimeout(resolve, 800); });
          return route.continue();
        });
        await openEditProfileDialog(page);
        await page.locator('#personCity').fill('Boulder');
        await page.locator('#personSave').click();

        await page.waitForFunction(() => document.getElementById('personSave').textContent === 'Saving…');
        expect(await page.locator('#personSave').getAttribute('aria-busy')).toBe('true');

        await page.locator('#dlgPerson').waitFor({ state: 'hidden' });
        expect(await page.locator('.toast', { hasText: 'Saved' }).count()).toBeGreaterThan(0);
      }, own);
    });
  });

  describe('Application profile', () => {
    it('years of experience: the message appears on leaving the box, and Save all answers says why it is off', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openApplicationProfile(page);
        await expandSavedAnswers(page);
        const years = answerBox(page, 'years_experience');
        await years.pressSequentially('lots');
        expect(await visible(page, '#answer-err-years_experience')).toBe(false); // still typing

        await page.keyboard.press('Tab');
        expect(await text(page, '#answer-err-years_experience'))
          .toBe('Years of experience must be a number between 0 and 50, like 8 or 8+.');
        const save = page.getByRole('button', { name: 'Save all answers' });
        expect(await save.isDisabled()).toBe(true);
        expect(await text(page, '#saveAnswersWhy')).toMatch(/1 answer/);

        await years.fill('8+');
        await page.keyboard.press('Tab');
        expect(await visible(page, '#answer-err-years_experience')).toBe(false);
        expect(await save.isDisabled()).toBe(false);
        expect(await text(page, '#saveAnswersWhy')).toBe('');
      }, own);
    });

    it('a required detail that is emptied is called out by name, and Save details says why it is off', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openApplicationProfile(page);
        await page.locator('#pf-city').fill('');
        await page.keyboard.press('Tab');
        expect(await text(page, '#pf-err-city')).toBe('City is required.');
        const save = page.getByRole('button', { name: 'Save details' });
        expect(await save.isDisabled()).toBe(true);
        expect(await text(page, '#saveDetailsWhy')).toMatch(/City/);

        await page.locator('#pf-city').fill('Austin');
        expect(await save.isDisabled()).toBe(false);
      }, own);
    });

    it('marks required and optional details', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openApplicationProfile(page);
        expect(await text(page, '#pfLegend')).toMatch(/Required/);
        expect(await text(page, 'label[for="pf-portfolio"]')).toMatch(/optional/i);
        expect(await text(page, 'label[for="pf-email"]')).not.toMatch(/optional/i);
      }, own);
    });

    it('the server refusing ONE answer is shown on that answer, with the typed text kept', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        const refusal = 'answer "require_sponsorship": that answer contains "need visa sponsorship", which contradicts '
          + 'the work authorization in your profile (you do not require sponsorship). State your real status instead.';
        await page.route('**/api/profile/answers', jsonRoute(400, { error: refusal }));
        await openApplicationProfile(page);
        await expandSavedAnswers(page);
        await answerBox(page, 'require_sponsorship').fill('Need visa sponsorship now or in the future.');
        await page.getByRole('button', { name: 'Save all answers' }).click();
        await page.locator('#answer-err-require_sponsorship:not([hidden])').waitFor();

        expect(await text(page, '#answer-err-require_sponsorship')).toMatch(/contradicts the work authorization/);
        expect(await answerBox(page, 'require_sponsorship').inputValue()).toBe('Need visa sponsorship now or in the future.');
        expect(await isOpen(page, 'dlgProfile')).toBe(true);
        // The cursor is put on the answer that needs fixing.
        expect(await page.evaluate(() => document.activeElement?.dataset?.aAnswer)).toBe('require_sponsorship');
      }, own);
    });

    it('explains how work authorization and sponsorship relate, right where they are answered', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await openApplicationProfile(page);
        await expandSavedAnswers(page);
        const row = (id) => page.locator(`[data-answer-id="${id}"]`);
        expect(await row('work_authorization').innerText()).toMatch(/work in the US today/i);
        expect(await row('require_sponsorship').innerText()).toMatch(/search profile/i);
        expect(await row('years_experience').innerText()).toMatch(/0 to 50/);
      }, own);
    });

    it('shows Saving… and then Saved while answers are written', async (ctx) => {
      if (!available) return ctx.skip();
      await withPage(async (page) => {
        await page.route('**/api/profile/answers', async (route) => {
          await new Promise((resolve) => { setTimeout(resolve, 700); });
          return route.continue();
        });
        await openApplicationProfile(page);
        await expandSavedAnswers(page);
        await answerBox(page, 'relocation').fill('Yes, within the US.');
        const save = page.getByRole('button', { name: 'Save all answers' });
        await afterRerender(page, async () => {
          await save.click();
          await page.waitForFunction(() => [...document.querySelectorAll('#profileBody button')].some((b) => b.textContent === 'Saving…'));
        });
        expect(await text(page, '#profileMsg')).toMatch(/Saved/);
      }, own);
    });
  });
});
