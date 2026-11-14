/**
 * Switching between people's search profiles (2026-11).
 *
 * Found on a real upload: a regulatory-affairs resume that writes each role as
 * "Title   Month YYYY - Present" (title and dates on ONE line) yielded no roles,
 * so a profile built from it could not search; "Create a profile" then saved
 * that empty profile anyway on every click, leaving three identical, unusable
 * entries in the switcher. Every fixture here is fictional, in that layout.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withoutTrailingDateRange, splitSections } from '../../src/resume/resumeProfile.js';
import { profileFromResume, contactFrom } from '../../src/profile/fromResume.js';
import { saveProfile, resumeProfileToReuse } from '../../src/profile/store.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { displayName, initials } from '../../src/dashboard/public/assets/js/format.js';
import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { makeDocx } from './fixtures/docx.js';
import { readText } from './helpers/readText.js';

const REPO = process.cwd();
const read = (rel) => readText(new URL(`../../src/dashboard/public/${rel}`, import.meta.url));

/** Title and dates on one line; employer | place on the next; long headings. */
const DATED_TITLE_RESUME = [
  'MORGAN T ELLISON',
  'Regulatory Affairs | Global Submissions & Lifecycle Management',
  '555-010-2233 | morgan.ellison@example.com | linkedin.com/in/morgan-ellison-test',
  'Open to relocation | U.S. Work Authorization: No Sponsorship Required',
  'PROFESSIONAL SUMMARY',
  'Regulatory CMC professional with eight years in post-approval submissions.',
  'CORE COMPETENCIES',
  'Regulatory Submissions: CMC Change Control | Annual Reports | PAS | CBE-30',
  'PROFESSIONAL EXPERIENCE',
  'Senior Regulatory CMC Specialist April 2024 - Present',
  'Northwind Pharma | Raleigh, NC',
  'Authored post-approval supplements and change assessments for marketed drug products.',
  'Regulatory Specialist January 2021 - March 2024',
  'Contoso Remedies | Remote, USA',
  'Prepared annual reports and health authority responses for twelve marketed products.',
  'CMC Associate, Global Regulatory Affairs August 2018 - December 2020',
  'Fabrikam Biologics | Boston, MA',
  'Compiled Module 3 sections for biologics license applications across three programmes.',
  'EDUCATION AND PROFESSIONAL DEVELOPMENT',
  'Master of Pharmacy, Pharmaceutical Regulatory Affairs | Example University, 2016 - 2018',
  'HONORS AND AWARDS',
  'Quality Excellence Award | Recognised for submission accuracy',
];

describe('reading a resume that puts each title and its dates on one line', () => {
  it('strips a trailing date range in the common forms, and only that', () => {
    expect(withoutTrailingDateRange('Senior Regulatory CMC Specialist April 2026 - Present')).toBe('Senior Regulatory CMC Specialist');
    expect(withoutTrailingDateRange('Data Engineer | Contoso (Jan 2020 – Mar 2022)')).toBe('Data Engineer | Contoso');
    expect(withoutTrailingDateRange('Registered Nurse 08/2019 - Present')).toBe('Registered Nurse');
    expect(withoutTrailingDateRange('Teacher 2015 to 2019')).toBe('Teacher');
    // A place-and-date line leaves the place, which is still never a title.
    expect(withoutTrailingDateRange('Raleigh, NC | April 2022 - Present')).toBe('Raleigh, NC');
    expect(withoutTrailingDateRange('Founded in 2019 and growing')).toBe('Founded in 2019 and growing');
  });

  it('recognises long education and awards headings, so experience stops where it should', () => {
    const kinds = splitSections(DATED_TITLE_RESUME).map((s) => s.kind);
    expect(kinds).toEqual(['header', 'summary', 'skills', 'experience', 'education', 'other']);
  });

  it('finds the roles, keeps abbreviations, and builds the work history', () => {
    const p = profileFromResume(DATED_TITLE_RESUME, {});
    expect(p.background.currentRoles).toEqual(['Senior Regulatory CMC Specialist']);
    expect(p.searchIntent.targetRoles).toEqual(['Senior Regulatory CMC Specialist', 'Regulatory Specialist', 'CMC Associate']);
    expect(p.background.workHistory.map((w) => [w.title, w.employer, w.location, w.current])).toEqual([
      ['Senior Regulatory CMC Specialist', 'Northwind Pharma', 'Raleigh, NC', true],
      ['Regulatory Specialist', 'Contoso Remedies', 'Remote, USA', false],
      ['CMC Associate', 'Fabrikam Biologics', 'Boston, MA', false],
    ]);
    expect(p.background.education).toHaveLength(1);
    // The award line is not mistaken for a job or a degree.
    expect(JSON.stringify(p.background.workHistory)).not.toMatch(/Quality Excellence/);
  });

  it("fills a different person's contact details from THEIR OWN resume header", () => {
    const current = normalizeProfile({ id: 'dana', identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.com', phone: '555-000-1111' } });
    const p = profileFromResume(DATED_TITLE_RESUME, { currentProfile: current });
    expect(p.contact).toEqual({ email: 'morgan.ellison@example.com', phone: '555-010-2233' });
    expect(p.identity.links.linkedin).toBe('https://www.linkedin.com/in/morgan-ellison-test');
    expect(JSON.stringify(p)).not.toContain('dana@example.com');
  });

  it('reads contact details from the header only, never from lines further down', () => {
    const sections = splitSections(['Pat Doe', 'Analyst', 'EXPERIENCE', 'Reference: boss@example.com 555-999-0000']);
    expect(contactFrom(sections)).toEqual({ email: '', phone: '', linkedin: '' });
  });
});

describe('creating a profile from a resume never leaves copies', () => {
  const tmp = () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-reuse-'));
    mkdirSync(join(root, 'config', 'profiles'), { recursive: true });
    return root;
  };
  const person = (id, createdAt, roles = [], extra = {}) => normalizeProfile({
    id, createdAt, identity: { fullName: 'MORGAN T ELLISON' }, searchIntent: { targetRoles: roles }, ...extra,
  });

  it('reuses the ORIGINAL empty copy of the same person, not a later one', () => {
    const root = tmp();
    try {
      saveProfile(root, person('morgan-t-ellison', '2026-11-01T18:31:39Z'));
      saveProfile(root, person('morgan-t-ellison-2', '2026-11-01T18:36:24Z'));
      saveProfile(root, person('morgan-t-ellison-3', '2026-11-01T18:36:26Z'));
      expect(resumeProfileToReuse(root, { identity: { fullName: 'Morgan T Ellison' } }, 'fp')).toBe('morgan-t-ellison');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('prefers the profile built from the very same resume, and leaves a working one alone', () => {
    const root = tmp();
    try {
      saveProfile(root, person('morgan-direction-a', '2026-10-01T00:00:00Z', ['Regulatory Specialist']));
      expect(resumeProfileToReuse(root, { identity: { fullName: 'Morgan T Ellison' } }, 'fp-new')).toBeNull();
      saveProfile(root, person('morgan-from-this', '2026-10-02T00:00:00Z', ['CMC Associate'], { background: { resumeFingerprint: 'fp-new' } }));
      expect(resumeProfileToReuse(root, { identity: { fullName: 'Someone Else' } }, 'fp-new')).toBe('morgan-from-this');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the create route', () => {
  /** A temp project root with the real shared config, like dashboardSearchProfileApi.test.js. */
  function makeRoot(resumeLines) {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-create-'));
    for (const dir of ['config/schemas', 'config/profiles', 'data', 'resumes/base']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json', 'cover_letter.example.json', 'ats_resume.json', 'role_families.json']) {
      copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
    }
    copyFileSync(join(REPO, 'config', 'cover_letter.example.json'), join(root, 'config', 'cover_letter.json'));
    copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
    copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
    copyFileSync(join(REPO, 'config', 'screening_answers.example.json'), join(root, 'config', 'screening_answers.json'));
    for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'cover_letter', 'ats_resume']) {
      copyFileSync(join(REPO, 'config', 'schemas', `${schema}.schema.json`), join(root, 'config', 'schemas', `${schema}.schema.json`));
    }
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(resumeLines));
    return root;
  }

  async function withServer(resumeLines, fn) {
    const root = makeRoot(resumeLines);
    const db = openDatabase({ path: ':memory:' });
    const config = loadConfig({ root });
    const dash = await startDashboard({ config, db, logger: { info() {}, warn() {}, error() {}, debug() {} }, port: 0 });
    const post = async (path, body) => {
      const r = await fetch(`${dash.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const files = () => readdirSync(join(root, 'config', 'profiles')).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    try { await fn({ root, post, files }); } finally { await dash.close?.(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }

  it('refuses, and saves nothing, when the resume yields no job titles', async () => {
    await withServer(['Pat Q Untitled', 'Curious and dependable', 'SUMMARY', 'I enjoy solving problems carefully.'], async ({ post, files }) => {
      const { status, body } = await post('/api/search-profiles/from-resume', { choice: 'create', activate: true });
      expect(status).toBe(422);
      expect(body.error).toMatch(/No job titles could be read/);
      expect(files()).toEqual([]);
    });
  });

  it('creates once, activates, and a second click updates the same profile instead of copying it', async () => {
    await withServer(DATED_TITLE_RESUME, async ({ root, post, files }) => {
      const first = await post('/api/search-profiles/from-resume', { choice: 'create', activate: true });
      expect(first.status).toBe(200);
      expect(first.body.activated).toBeTruthy();
      const second = await post('/api/search-profiles/from-resume', { choice: 'create', activate: true });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(files()).toEqual([`${first.body.id}.json`]);
      const saved = JSON.parse(readFileSync(join(root, 'config', 'profiles', `${first.body.id}.json`), 'utf8'));
      expect(saved.background.resumeFingerprint).toMatch(/\w{8,}/);
      expect(saved.searchIntent.targetRoles).toContain('Senior Regulatory CMC Specialist');
    });
  });
});

describe('the switcher in the interface', () => {
  const html = read('index.html');
  const css = read('assets/css/app.css');

  it('shows people by name and initials, not internal labels', () => {
    expect(displayName('MORGAN T ELLISON')).toBe('Morgan T Ellison');
    expect(displayName("MARY O'NEIL-SMITH")).toBe("Mary O'Neil-Smith");
    expect(displayName('iPhone McDonald')).toBe('iPhone McDonald'); // typed in mixed case: left alone
    expect(initials('MORGAN T ELLISON')).toBe('ME');
    expect(initials('Cher')).toBe('C');
  });

  it('lists the people as a radio group at the top of the Profile menu, with initials on its button', () => {
    const start = html.indexOf('id="accountMenu"');
    const end = html.indexOf('</div>\n    </span>', start);
    // Guard the slice itself: a -1 here would make every assertion below
    // check the whole page and pass for the wrong reason (P3-2).
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const menu = html.slice(start, end);
    expect(menu).toContain('id="profileMenuItems" class="pf-menu-list" role="group" aria-label="Profiles"');
    // Minimal: no uppercase section labels, the rules carry the grouping.
    expect(menu).not.toContain('class="menu-label"');
    expect(html).toContain('<span class="avatar" id="profileAvatar" aria-hidden="true" hidden></span>');
    const profiles = read('assets/js/profiles.js');
    expect(profiles).toContain("role: 'menuitemradio'");
    expect(profiles).toContain("'aria-checked': String(p.active)");
    // The active person is ticked, not described in coloured text.
    expect(profiles).toContain('p.active ? checkIcon() : null');
  });

  it('says why an empty profile cannot be switched to, in words', () => {
    const profiles = read('assets/js/profiles.js');
    expect(profiles).toContain("'No job titles yet, so it cannot search'");
    expect(css).toContain('.pf-row.is-empty .pf-sub { color: var(--warn-text); }');
  });

  it('offers "Switch back" after every switch, and asks before removing', () => {
    const profiles = read('assets/js/profiles.js');
    expect(profiles).toContain("text: 'Switch back'");
    expect(profiles).toMatch(/export async function removePerson[\s\S]*method: 'DELETE'/);
    expect(read('assets/js/master.js')).toContain('announceSwitch(result.activated.label');
  });

  it('removes a person from their own row (button or Delete key), never the active one', () => {
    const html = read('index.html');
    const profiles = read('assets/js/profiles.js');
    // No separate "Remove profile…" item that then asks "who?".
    expect(html).not.toContain('open-remove-profile');
    expect(profiles).toMatch(/if \(!p\.active\) \{\s*row\.append\(el\('button', \{\s*type: 'button', class: 'pf-mi-remove'/);
    expect(profiles).toContain("'data-action': 'delete-search-profile', 'data-profile-id': p.id");
    expect(profiles).toContain("'aria-label': `Remove ${p.display}…`");
    expect(profiles).toMatch(/event\.key !== 'Delete' && event\.key !== 'Backspace'[\s\S]*openRemoveProfile\(item\.dataset\.profileId\)/);
    // Both open the same confirm dialog, preselected on that person.
    expect(read('assets/js/actions.js')).toContain("'delete-search-profile': (target) => openRemoveProfile(target?.dataset?.profileId)");
  });

  it('removes through one dialog: a labelled choice of person, never the active one, the button naming them', () => {
    const html = read('index.html');
    const profiles = read('assets/js/profiles.js');
    expect(html).toMatch(/<dialog id="dlgRemovePerson"[\s\S]*<legend>Who should be removed\?<\/legend>[\s\S]*id="removeGo">Remove profile<\/button>/);
    expect(html).toContain('Nothing is erased.');
    expect(profiles).toContain('const others = rows.filter((p) => !p.active);');
    expect(profiles).toContain("type: 'radio', name: 'removeId'");
    expect(profiles).toContain("`Remove ${who.split(' ')[0]}`");
    expect(profiles).toContain("setRemoveError('Choose the profile to remove.')");
  });

  it('keeps toasts inside the open dialog, so their buttons are reachable', () => {
    const dialogs = read('assets/js/dialogs.js');
    expect(dialogs).toMatch(/export function placeToasts\(\)[\s\S]*dialog\[open\]/);
    expect(dialogs).toMatch(/dialog\.showModal\(\);\s*placeToasts\(\);/);
    expect(read('assets/js/detail.js')).toMatch(/sheet\.showModal\(\);\s*placeToasts\(\);/);
  });
});
