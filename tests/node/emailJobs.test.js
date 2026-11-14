/**
 * "Email these jobs": the draft is built as data (emailDraft.js) and tested
 * directly; the dialog and its entry points are checked as shipped source,
 * like the other DOM-bound modules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  buildJobEmail, cleanRecipients, EMAIL_MAX_JOBS, emailItem, emlFile, emlFileName,
  MAILTO_MAX, mailtoHref, safePostingUrl,
} from '../../src/dashboard/public/assets/js/emailDraft.js';
import { CHANGELOG } from '../../src/dashboard/public/assets/js/changelog-data.js';

// Windows checkouts get CRLF (.gitattributes text=auto); the assertions below are written against LF.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
const js = (f) => read(`../../src/dashboard/public/assets/js/${f}`);

// Noon UTC: the same calendar day in every CI timezone.
const NOW = new Date('2026-11-10T12:00:00Z');

const job = (over = {}) => ({
  id: 'j1', title: 'Senior Data Engineer', company: 'Northwind', location: 'Denver, CO',
  url: 'https://boards.example.com/jobs/1', score: 87.6, postedAt: '2026-11-09T15:00:00Z', ...over,
});

const decodeB64Part = (eml, type) => {
  const part = eml.split(`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1];
  return Buffer.from(part.split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
};

describe('the email draft', () => {
  it('lists every job in board order with its link, company and details', () => {
    const draft = buildJobEmail([job(), job({ id: 'j2', title: 'Analytics Engineer', company: 'Contoso', score: 70 })],
      { scope: 'hand-picked', filters: ['Remote only'], now: NOW });
    expect(draft.count).toBe(2);
    expect(draft.linked).toBe(2);
    expect(draft.subject).toBe('2 job postings from JobAgent (Nov 10, 2026)');
    expect(draft.text).toContain('2 job postings from JobAgent, hand-picked, as of Tue, Nov 10, 2026.');
    expect(draft.text).toContain('Filters: Remote only');
    expect(draft.text).toMatch(/1\. Senior Data Engineer at Northwind\n {3}Denver, CO · Posted Nov 9, 2026 · Fit 88\/100\n {3}https:\/\/boards\.example\.com\/jobs\/1/);
    expect(draft.text.indexOf('Senior Data Engineer')).toBeLessThan(draft.text.indexOf('Analytics Engineer'));
    expect(draft.html).toContain('<a href="https://boards.example.com/jobs/1"');
    expect(draft.html).toContain('<ol');
  });

  it('says "1 job posting", and omits details it does not have', () => {
    const draft = buildJobEmail([{ title: 'Data Engineer', url: 'https://x.example/1' }], { now: NOW });
    expect(draft.subject).toBe('1 job posting from JobAgent (Nov 10, 2026)');
    expect(draft.text).toContain('1. Data Engineer\n   https://x.example/1');
    expect(draft.text).not.toContain('Filters:');
  });

  it('escapes scraped text in the HTML, so a posting cannot inject markup', () => {
    const draft = buildJobEmail([job({
      title: '<img src=x onerror=alert(1)>Engineer', company: 'A&B "Co"', location: '<script>x</script>',
    })], { now: NOW });
    expect(draft.html).not.toMatch(/<img|<script|onerror=alert\(1\)>/);
    expect(draft.html).toContain('&lt;img src=x onerror=alert(1)&gt;Engineer');
    expect(draft.html).toContain('A&amp;B &quot;Co&quot;');
  });

  it('links only http(s) postings and says so when there is no public link', () => {
    expect(safePostingUrl('javascript:alert(1)')).toBeNull();
    expect(safePostingUrl('data:text/html,hi')).toBeNull();
    expect(safePostingUrl('not a url')).toBeNull();
    expect(safePostingUrl('https://ok.example/a?b=1')).toBe('https://ok.example/a?b=1');
    const draft = buildJobEmail([job({ url: 'javascript:alert(1)' })], { now: NOW });
    expect(draft.linked).toBe(0);
    expect(draft.html).not.toContain('javascript:');
    expect(draft.text).toContain('(no public link)');
    // A quote in a URL cannot break out of the href attribute.
    expect(buildJobEmail([job({ url: 'https://x.example/"onmouseover="alert(1)' })], { now: NOW }).html)
      .not.toContain('"onmouseover="');
  });

  it('flattens scraped whitespace and clips very long locations', () => {
    const item = emailItem(job({ title: 'Data\n\n  Engineer', location: 'x'.repeat(200) }));
    expect(item.title).toBe('Data Engineer');
    expect(item.details[0].length).toBeLessThanOrEqual(80);
    expect(item.details[0].endsWith('…')).toBe(true);
  });

  it('adds Remote only when the location does not already say so', () => {
    expect(emailItem(job({ remote: true, location: 'Austin, TX' })).details).toContain('Remote');
    expect(emailItem(job({ remote: true, location: 'Remote - US' })).details).not.toContain('Remote');
  });

  it('caps the list and says how many matched in total', () => {
    const many = Array.from({ length: EMAIL_MAX_JOBS + 20 }, (_, i) => job({ id: `j${i}` }));
    const draft = buildJobEmail(many, { total: 1234, now: NOW });
    expect(draft.count).toBe(EMAIL_MAX_JOBS);
    expect(draft.text).toContain(`This is the first ${EMAIL_MAX_JOBS} of 1,234 matching jobs`);
  });
});

describe('handing the draft to an email app', () => {
  it('builds a mailto link with CRLF line breaks, or none when it would be cut off', () => {
    const draft = buildJobEmail([job()], { now: NOW });
    const href = mailtoHref({ to: 'a@example.com, b@example.com', subject: draft.subject, text: draft.text });
    expect(href.startsWith('mailto:a%40example.com,b%40example.com?subject=')).toBe(true);
    expect(href).toContain('%0D%0A');
    const long = buildJobEmail(Array.from({ length: 40 }, (_, i) => job({ id: `j${i}` })), { now: NOW });
    expect(mailtoHref({ subject: long.subject, text: long.text })).toBeNull();
    expect(MAILTO_MAX).toBeLessThanOrEqual(2000);
  });

  it('cleans recipients and never lets a header value start a new header', () => {
    expect(cleanRecipients(' a@example.com ;b@example.com,, ')).toBe('a@example.com, b@example.com');
    const eml = emlFile({ to: 'a@example.com\r\nBcc: evil@example.com', subject: 'Hi\r\nBcc: evil@example.com', text: 't', html: 'h', now: NOW, boundary: 'B' });
    expect(eml).not.toMatch(/\r\nBcc:/);
  });

  it('writes an .eml draft that opens ready to edit, with text and HTML parts', () => {
    const draft = buildJobEmail([job({ title: 'Ingénieur données' })], { now: NOW });
    const eml = emlFile({ to: 'me@example.com', subject: draft.subject, text: draft.text, html: draft.html, now: NOW, boundary: 'B' });
    expect(eml.startsWith('X-Unsent: 1\r\nTo: me@example.com\r\nSubject: ')).toBe(true);
    expect(eml).toContain('Content-Type: multipart/alternative; boundary="B"');
    expect(eml.trimEnd().endsWith('--B--')).toBe(true);
    expect(decodeB64Part(eml, 'text/plain')).toContain('Ingénieur données');
    expect(decodeB64Part(eml, 'text/html')).toContain('<a href="https://boards.example.com/jobs/1"');
    // Every line stays within the RFC 5322 limit.
    expect(Math.max(...eml.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(78);
  });

  it('encodes a non-ASCII subject so mail apps show it correctly', () => {
    const eml = emlFile({ subject: 'Offres d’emploi — sélection', text: '', html: '', now: NOW, boundary: 'B' });
    const subject = eml.split('\r\n').find((l) => l.startsWith('Subject: '));
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(emlFileName(new Date(2026, 10, 10))).toBe('job-postings-2026-11-10.eml');
  });
});

describe('the dialog as shipped', () => {
  it('is reachable from the board and from Activity, and wired to its actions', () => {
    const pagerbar = html.slice(html.indexOf('<div class="pagerbar">'), html.indexOf('</div>', html.indexOf('id="viewMenu"')));
    expect(pagerbar).toContain('data-action="open-email-jobs"');
    // To the menu's own closing tag: its items carry <span> hints, so the
    // first </span> is not the end of the menu.
    const activity = html.slice(html.indexOf('id="activityMenu"'), html.indexOf('\n      </div>', html.indexOf('id="activityMenu"')));
    expect(activity).toContain('data-action="open-email-jobs"');
    const actions = js('actions.js');
    for (const name of ['open-email-jobs', 'email-copy', 'email-open', 'email-download']) {
      expect(actions).toContain(`'${name}':`);
    }
  });

  it('is a labelled native dialog with an optional To, a subject, a preview and three ways out', () => {
    const dialog = html.slice(html.indexOf('<dialog id="dlgEmail"'), html.indexOf('</dialog>', html.indexOf('<dialog id="dlgEmail"')));
    expect(dialog).toContain('aria-labelledby="dlgEmailTitle"');
    expect(dialog).toContain('<input id="emailTo" type="email" multiple');
    expect(dialog).toContain('<input id="emailSubject" type="text"');
    expect(dialog).toContain('id="emailPreview"');
    expect(dialog).toContain('role="status" aria-live="polite"');
    for (const name of ['email-download', 'email-open', 'email-copy']) expect(dialog).toContain(`data-action="${name}"`);
    expect(dialog).toContain('Nothing is sent from JobAgent.');
  });

  it('renders the preview without innerHTML and sends nothing itself', () => {
    const source = js('emailJobs.js');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|fetch\(|postJson/);
    // It reads the same filtered list the board shows, or the selection.
    expect(source).toContain('filterParams()');
    expect(source).toContain('selectedJobs()');
  });

  it('writes the email for its reader: the scope it puts in the email never says "your"', () => {
    const source = js('emailJobs.js');
    const scopes = [...source.matchAll(/\bscope: ([^,\n]+)/g)].map((m) => m[1]);
    expect(scopes.length).toBeGreaterThanOrEqual(2);
    for (const scope of scopes) expect(scope).not.toMatch(/\byour?\b/i);
  });

  it('is styled from tokens and stacks its buttons on a phone', () => {
    expect(css).toContain('#dlgEmail { width: min(640px, 94vw)');
    expect(css).toMatch(/@media \(max-width: 560px\) \{\s*#dlgEmail \.dlg-foot \{ flex-wrap: wrap; \}/);
  });

  it('is announced in the changelog', () => {
    // Announced in the release that shipped it (2026-11-10), not necessarily the newest one.
    expect(CHANGELOG.some((release) => /Email list/.test(JSON.stringify(release)))).toBe(true);
  });
});
