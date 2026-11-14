/**
 * The changelog: a link at the very bottom of the page opens a dialog listing
 * each release by date. The data is plain and tested directly; the dialog is
 * checked as shipped source, like uiGlassRefinement.test.js.
 */
import { describe, it, expect } from 'vitest';


import { CHANGELOG, CHANGELOG_GROUPS } from '../../src/dashboard/public/assets/js/changelog-data.js';
import { readText } from './helpers/readText.js';

const read = (rel) => readText(new URL(`../../src/dashboard/public/${rel}`, import.meta.url));
const html = read('index.html');
const css = read('assets/css/app.css');

describe('changelog data', () => {
  it('is newest first, with real calendar dates', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    const dates = CHANGELOG.map((r) => r.date);
    for (const date of dates) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
    expect(dates).toEqual([...dates].sort().reverse());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('uses only the three known groups, each with short non-empty lines', () => {
    const known = new Set(CHANGELOG_GROUPS.map(([key]) => key));
    expect(CHANGELOG_GROUPS.map(([, title]) => title)).toEqual(['New', 'Improvements', 'Fixes']);
    for (const release of CHANGELOG) {
      expect(release.summary).toBeTruthy();
      const keys = Object.keys(release.groups);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(known.has(key), key).toBe(true);
        for (const line of release.groups[key]) {
          expect(line.trim().length).toBeGreaterThan(10);
          expect(line.length, line).toBeLessThanOrEqual(320);
        }
      }
    }
  });

  it('is written for users: no file names, code or internal terms', () => {
    const text = JSON.stringify(CHANGELOG);
    expect(text).not.toMatch(/\.(js|css|json|html)\b|src\/|config\/|\bAPI\b|\bCSS\b|backdrop|refactor|vitest/i);
  });

  it('carries the safety promise unchanged', () => {
    expect(CHANGELOG[0].safety).toBe('Nothing is submitted without your review. That has not changed.');
  });
});

describe('changelog dialog and link', () => {
  it('puts the link at the very end of the page footer, as a real button', () => {
    const footer = html.slice(html.indexOf('<footer class="signature"'), html.indexOf('</footer>'));
    expect(footer).toContain('data-action="open-changelog"');
    expect(footer).toContain('aria-haspopup="dialog" aria-controls="dlgChangelog">Changelog</button>');
    // After the colophon's own lines: it is the last thing in the footer.
    expect(footer.indexOf('sig-meta')).toBeLessThan(footer.indexOf('open-changelog'));
    // And the footer is the last content before the toasts and dialogs.
    expect(html.indexOf('</footer>')).toBeLessThan(html.indexOf('id="dlgChangelog"'));
  });

  it('is a labelled native dialog with a close button, and does nothing but open', () => {
    const dialog = html.slice(html.indexOf('<dialog id="dlgChangelog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="dlgChangelog"')));
    expect(dialog).toContain('aria-labelledby="dlgChangelogTitle"');
    expect(dialog).toContain('id="changelogBody"');
    expect(dialog.match(/data-action="close-dialog"/g).length).toBe(2);
    const actions = read('assets/js/actions.js');
    expect(actions).toContain("'open-changelog': openChangelog,");
    expect(actions).not.toMatch(/'open-changelog': \(\) =>[^\n]*(postJson|api\()/);
  });

  it('renders the date as a <time> heading from plain text (no innerHTML)', () => {
    const js = read('assets/js/changelog.js');
    expect(js).toContain("el('time', { datetime: release.date");
    expect(js).not.toMatch(/innerHTML/);
    // Built from parts, not `new Date('YYYY-MM-DD')`, which is UTC and reads a day early in the Americas.
    expect(js).toContain('new Date(y, m - 1, d, 12)');
  });

  it('is styled from tokens, scrolls inside the dialog and hides the link when printed', () => {
    expect(css).toMatch(/#dlgChangelog \.dlg-body \{[^}]*overflow: auto/);
    expect(css).toContain('.sig-rule, .sig-links { display: none; }');
    const block = css.slice(css.indexOf('/* ─────────────────── changelog'), css.indexOf('/* ─────────────────── keyboard shortcut sheet'));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|font-style: italic/i);
  });
});
