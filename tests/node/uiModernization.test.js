/**
 * P1B-1 — the modernized dashboard: three views, grouped Today, explainable
 * rows, and a detail panel with one primary action. Pure helpers are tested
 * directly; DOM-bound modules are checked as shipped source, like
 * workbenchUi.test.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

import { ageDays, freshnessOf, withoutTitleTerms } from '../../src/dashboard/public/assets/js/format.js';
import { skillMatchOf, BOARD_FIELDS, todayQueue } from '../../src/dashboard/data.js';
import { openDatabase } from '../../src/logging/db.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
const jsDir = new URL('../../src/dashboard/public/assets/js/', import.meta.url);
const js = (f) => readFileSync(new URL(f, jsDir), 'utf8');
const app = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort().map(js).join('\n');

const NOW = Date.parse('2026-09-22T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();

describe('freshness and skill helpers', () => {
  it('grades posting age as fresh / aging / stale, and unknown as null', () => {
    expect(ageDays(daysAgo(3), NOW)).toBe(3);
    expect(freshnessOf(daysAgo(2), NOW)).toEqual({ days: 2, tone: 'fresh' });
    expect(freshnessOf(daysAgo(20), NOW)).toEqual({ days: 20, tone: 'aging' });
    expect(freshnessOf(daysAgo(45), NOW)).toEqual({ days: 45, tone: 'stale' });
    expect(freshnessOf(null, NOW)).toBeNull();
    expect(freshnessOf('not a date', NOW)).toBeNull();
  });

  it('drops terms that are part of the role title, for any profession', () => {
    expect(withoutTitleTerms(['registered nurse', 'icu', 'bls'], 'Registered Nurse - ICU Nights')).toEqual(['bls']);
    expect(withoutTitleTerms(['data engineer', 'python', 'sql'], 'Senior Data Engineer')).toEqual(['python', 'sql']);
    expect(withoutTitleTerms(['c++'], 'Software Engineer')).toEqual(['c++']);
  });
});

describe('skillMatch on board rows', () => {
  it('is a projected board field', () => {
    expect(BOARD_FIELDS).toContain('skillMatch');
  });

  it('counts skills, not title words, and never claims a skill the scorer also lists as missing', () => {
    const m = skillMatchOf({
      title: 'Senior Data Engineer',
      matchedKeywords: ['data engineer', 'python', 'sql', 'kafka', 'airflow'],
      missingKeywords: ['kafka', 'airflow', 'dbt'],
    });
    expect(m).toEqual({ matched: 2, missing: 3, top: ['python', 'sql'] });
  });

  it('is null when the scorer recorded nothing', () => {
    expect(skillMatchOf({ title: 'X', matchedKeywords: [], missingKeywords: [] })).toBeNull();
  });
});

describe('Today items carry display signals and a reason that adds information', () => {
  it('includes fit, posting date, the sponsorship gate and link state, and names matched skills', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'm', title: 'Accountant', company: 'Acme', status: 'scored', score: 70, tier: 'Queue',
      posted_at: daysAgo(3), matched_keywords: ['excel', 'gaap', 'reconciliation', 'netsuite', 'audit'],
      missing_keywords: ['cpa'], discovery_mode: 'profile',
    });
    const [item] = todayQueue(db, { now: new Date(NOW) }).items;
    expect(item).toMatchObject({ id: 'm', postedAt: daysAgo(3), sponsorshipGated: expect.any(Boolean), linkState: null });
    expect(item.fit).toBeTruthy();
    expect(item.reason).toBe('Asks for excel, gaap, reconciliation, netsuite and 1 more of your skills · 1 asked-for skill not in your resume.');
    db.close();
  });
});

describe('navigation: three views, stages inside the view', () => {
  it('derives Jobs vs Applications from the active stage', () => {
    const today = js('today.js');
    expect(today).toContain("export const VIEWS = ['today', 'board', 'applications'];");
    expect(today).toContain("view = 'applications';");
    expect(js('filters.js')).toMatch(/APP_TABS = TABS\.filter\(\(\[key\]\) => \['needs_review', 'ready_apply', 'needs_you', 'submitted'\]/);
    expect(js('analytics.js')).toContain('if (APP_TAB_KEYS.has(key) !== inApps) continue;');
    expect(html).toContain('id="appsCount"');
  });

  it('keeps the header on one line until phone width', () => {
    expect(css).not.toMatch(/@media \(max-width: 1360px\) \{\s*\.stages \{ order: 3/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.stages \{ order: 3; flex: 1 0 100%; \}/);
  });
});

describe('filters: three always visible, the rest in an in-place panel', () => {
  it('discloses the panel with aria-expanded/controls and counts only hidden filters', () => {
    expect(html).toContain('aria-controls="filterPanel"');
    expect(html).toContain('id="filterPanel"');
    expect(css).toContain('.filterbar[data-collapsed="true"] .filter-panel { display: none; }');
    expect(app).toContain("const ALWAYS_VISIBLE_FILTERS = new Set(['q', 'fit', 'appStatus']);");
    // Every filter control still exists.
    for (const id of ['q', 'fit', 'appStatus', 'state', 'city', 'sponsorship', 'employmentType', 'source', 'ats',
      'resumeStatus', 'postedWithinHours', 'remoteOnly', 'sponsorshipGated', 'undated', 'includeClosed']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });
});

describe('Today: grouped by the kind of work', () => {
  it('groups finish / decide / tidy and fills only the finish buttons', () => {
    const today = js('today.js');
    expect(today).toContain("{ key: 'finish', title: 'Finish applications'");
    expect(today).toContain("{ key: 'decide', title: 'Decide on matches'");
    expect(today).toContain("{ key: 'tidy', title: 'Tidy up'");
    expect(today).toContain("class: `small ${group.primary ? 'primary' : ''} tcard-go`");
    expect(today).toContain("text: 'Verify sponsorship'");
  });
});

describe('job detail: one primary action, evidence first, actions grouped', () => {
  const detail = js('detail.js');

  it('demotes every primary after the first in "Do this next"', () => {
    expect(detail).toContain('if (primarySeen) button.classList.remove(\'primary\');');
  });

  it('places the fit card before the resume card and the action buttons', () => {
    const fit = detail.indexOf("out.push(railSection('fit', fitCard(job)));");
    expect(fit).toBeGreaterThan(-1);
    expect(fit).toBeLessThan(detail.indexOf("out.push(railSection('resume', resumeCard(job)));"));
    expect(fit).toBeLessThan(detail.indexOf("out.push(railSection('actions', actions"));
    // The scorer's raw breakdown is kept, behind a disclosure.
    expect(detail).toContain("el('summary', { text: 'How this score was calculated' })");
  });

  it('keeps every secondary action reachable inside "More actions"', () => {
    const block = detail.slice(detail.indexOf("const more = el('div', { class: 'actions more-actions-list' });"),
      detail.indexOf("el('summary', { class: 'small', text: 'More actions' })"));
    for (const action of ['check-link', 'open-link-dialog', 'reject-packet', 'open-submit-dialog']) {
      expect(block, action).toContain(`'data-action': '${action}'`);
    }
    // Archive stays a secondary action. Undoing a decision is deliberately NOT
    // tucked away: it is shown in view, named for what it undoes (UNDO_LABEL).
    expect(block).toContain("['archived', 'Archive', false], ['clear', UNDO_LABEL[current], true]");
    expect(detail).toMatch(/UNDO_LABEL = Object\.freeze\(\{[\s\S]*archived: 'Unarchive'/);
  });
});

describe('branding', () => {
  it('keeps the cursive "Designed and Engineered by" signature', () => {
    expect(html).toContain('Atresh Somayajula');
    expect(css).toContain('--signature-font: "Alex Brush"');
  });
});
