/**
 * One workspace per person (2026-11). Before this, every profile shared one job
 * database and one master resume: switching to a second person showed them the
 * first person's jobs and applications, tailored their applications from the
 * first person's resume, and rescored the first person's jobs under the second
 * person's profile. Driven over real loopback HTTP against a temp root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, activeDbPath } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { saveProfile, profileFieldErrors } from '../../src/profile/store.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { workspacePaths, activeWorkspaceId } from '../../src/profile/workspace.js';
import { makeDocx } from './fixtures/docx.js';

const REPO = process.cwd();

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-workspaces-'));
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
  return root;
}

/** The person who was here first: a profile saved before workspaces (no `workspace`). */
const DANA = normalizeProfile({
  id: 'dana-okafor', label: 'Dana Okafor — Senior Data Engineer',
  identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.com' },
  location: { city: 'Raleigh', state: 'North Carolina', country: 'United States' },
  background: { currentRoles: ['Senior Data Engineer'], seniority: 'senior', skills: ['Python', 'SQL'] },
  searchIntent: {
    targetRoles: ['Senior Data Engineer'], seniority: 'senior', skillsToKeep: ['Python', 'SQL', 'Spark'],
    employmentTypes: ['fulltime'], startDate: 'Two weeks', workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

const MORGAN_RESUME = [
  'MORGAN T ELLISON', 'Regulatory Affairs | Global Submissions',
  '555-010-2233 | morgan.ellison@example.com | linkedin.com/in/morgan-ellison-test',
  'PROFESSIONAL EXPERIENCE',
  'Senior Regulatory CMC Specialist April 2024 - Present', 'Northwind Pharma | Raleigh, NC',
  'Authored post-approval supplements and change assessments for marketed drug products.',
  'Regulatory Specialist January 2021 - March 2024', 'Contoso Remedies | Remote, USA',
  'CORE COMPETENCIES', 'Regulatory: CMC Change Control | Annual Reports | PAS',
];

describe('a workspace per person', () => {
  let root; let db; let dash;
  const call = async (method, path, body) => {
    const r = await fetch(`${dash.url}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const jobsTotal = async () => (await call('GET', '/api/jobs?pageSize=50')).body.total;

  beforeEach(async () => {
    root = makeRoot();
    saveProfile(root, DANA);
    writeFileSync(join(root, 'config', 'profiles', '_active.json'), JSON.stringify({ id: DANA.id }));
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(['Dana Okafor', 'Senior Data Engineer']));
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'dana-job', title: 'Senior Data Engineer', company: 'Northwind', status: 'scored', score: 80, jd_text: 'Python SQL Spark', discovery_mode: 'profile' });
    const config = loadConfig({ root });
    dash = await startDashboard({ config, db, logger: { info() {}, warn() {}, error() {}, debug() {} }, port: 0 });
  });
  afterEach(async () => { await dash?.close(); db?.close(); rmSync(root, { recursive: true, force: true }); });

  it('keeps every profile saved before workspaces on the original files', () => {
    expect(activeWorkspaceId(root)).toBe('');
    expect(workspacePaths(root).db).toBe(join(root, 'data', 'applied_jobs.db'));
    expect(workspacePaths(root).resume).toBe(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'));
    expect(workspacePaths(root, 'morgan').db).toBe(join(root, 'data', 'profiles', 'morgan', 'applied_jobs.db'));
    expect(workspacePaths(root, '../escape').id).toBe(''); // never a path outside
  });

  it('adds a person with their own empty Jobs list, and switching back shows the original jobs', async () => {
    expect(await jobsTotal()).toBe(1);
    const added = await call('POST', '/api/search-profiles', {
      fields: { fullName: 'Morgan Ellison', email: 'morgan@example.com', targetRoles: ['Regulatory Specialist'], seniority: 'senior' },
      activate: true,
    });
    expect(added.status).toBe(200);
    expect(added.body.workspaceChanged).toBe(true);
    expect(activeWorkspaceId(root)).toBe('morgan-ellison');
    expect(await jobsTotal()).toBe(0); // Morgan does not see Dana's jobs
    expect(JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).targetTitles).toContain('Regulatory Specialist');

    const back = await call('POST', '/api/search-profiles/activate', { id: DANA.id });
    expect(back.body.workspaceChanged).toBe(true);
    expect(await jobsTotal()).toBe(1);
    expect((await call('GET', '/api/jobs/dana-job')).status).toBe(200);
  });

  it('saves a resume given to "Add profile" in the new person\'s workspace, never over the original', async () => {
    const original = readFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'));
    const contentBase64 = makeDocx(MORGAN_RESUME).toString('base64');
    const read = await call('POST', '/api/search-profiles/read-resume', { contentBase64 });
    expect(read.status).toBe(200);
    expect(read.body.fields).toMatchObject({ fullName: 'MORGAN T ELLISON', email: 'morgan.ellison@example.com' });
    expect(read.body.fields.targetRoles).toContain('Senior Regulatory CMC Specialist');
    expect(readdirSync(join(root, 'config', 'profiles')).filter((f) => !f.startsWith('_'))).toEqual(['dana-okafor.json']); // reading saves nothing

    const added = await call('POST', '/api/search-profiles', {
      fields: { ...read.body.fields, fullName: 'Morgan T Ellison' }, resume: { contentBase64 }, activate: false,
    });
    expect(added.status).toBe(200);
    const own = workspacePaths(root, added.body.workspace).resume;
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx')).equals(original)).toBe(true);
    const saved = JSON.parse(readFileSync(join(root, 'config', 'profiles', `${added.body.id}.json`), 'utf8'));
    expect(saved.background.workHistory.length).toBeGreaterThan(0);
    expect(activeWorkspaceId(root)).toBe(''); // activate: false leaves Dana active
  });

  it('answers a bad form with a message per field, and saves nothing', async () => {
    const r = await call('POST', '/api/search-profiles', { fields: { fullName: 'Morgan', email: 'nope', targetRoles: [] } });
    expect(r.status).toBe(400);
    expect(profileFieldErrors({ fullName: 'Morgan', email: 'nope', targetRoles: [] })).toEqual({
      fullName: 'Enter a first and last name.',
      email: 'Enter an email address like name@example.com.',
      targetRoles: 'Add at least one job title to search for.',
    });
    expect(readdirSync(join(root, 'config', 'profiles')).filter((f) => !f.startsWith('_'))).toEqual(['dana-okafor.json']);
  });

  it('edits the active person and applies the new job titles at once', async () => {
    const r = await call('PATCH', `/api/search-profiles/${DANA.id}`, {
      fields: { fullName: 'Dana Okafor', email: 'dana@example.com', targetRoles: ['Analytics Engineer'], seniority: 'senior' },
    });
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).targetTitles).toContain('Analytics Engineer');
    expect(await jobsTotal()).toBe(1); // still Dana's workspace
  });

  it('archives a deleted person\'s workspace instead of destroying it', async () => {
    const added = await call('POST', '/api/search-profiles', {
      fields: { fullName: 'Morgan Ellison', email: 'morgan@example.com', targetRoles: ['Regulatory Specialist'] },
      resume: { contentBase64: makeDocx(MORGAN_RESUME).toString('base64') },
    });
    const del = await fetch(`${dash.url}/api/search-profiles/${added.body.id}`, { method: 'DELETE', headers: { 'x-job-agent': '1' } });
    const body = await del.json();
    expect(del.status).toBe(200);
    expect(body.archived.length).toBeGreaterThan(0);
    expect(existsSync(workspacePaths(root, added.body.workspace).resumeDir)).toBe(false);
    expect(existsSync(join(root, 'resumes', 'profiles', '.deleted'))).toBe(true);
    // Their settings are archived too, and the listing no longer shows them.
    expect(readdirSync(join(root, 'config', 'profiles', '.deleted')).some((f) => f.startsWith(`${added.body.id}-`))).toBe(true);
    expect((await call('GET', '/api/search-profiles')).body.profiles.some((p) => p.id === added.body.id)).toBe(false);
  });

  it('gives a person created from the current resume their own workspace and a copy of it', async () => {
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(MORGAN_RESUME));
    const r = await call('POST', '/api/search-profiles/from-resume', { choice: 'create', activate: true });
    expect(r.status).toBe(200);
    expect(r.body.workspaceChanged).toBe(true);
    const ws = activeWorkspaceId(root);
    expect(ws).not.toBe('');
    expect(readFileSync(workspacePaths(root, ws).resume).equals(readFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx')))).toBe(true);
    expect(await jobsTotal()).toBe(0);
  });

  it('points the CLI\'s database at the active person too', () => {
    expect(activeDbPath(root)).toBe(join(root, 'data', 'applied_jobs.db'));
    saveProfile(root, normalizeProfile({ id: 'morgan', workspace: 'morgan', identity: { fullName: 'Morgan Ellison' } }));
    writeFileSync(join(root, 'config', 'profiles', '_active.json'), JSON.stringify({ id: 'morgan' }));
    expect(activeDbPath(root)).toBe(join(root, 'data', 'profiles', 'morgan', 'applied_jobs.db'));
  });
});

describe('the Add / Edit profile form', () => {
  const read = (rel) => readFileSync(new URL(`../../src/dashboard/public/${rel}`, import.meta.url), 'utf8');
  const html = read('index.html');
  const dialog = html.slice(html.indexOf('<dialog id="dlgPerson"'), html.indexOf('</dialog>', html.indexOf('<dialog id="dlgPerson"')));

  it('labels every field and links each error to its field', () => {
    for (const id of ['personName', 'personEmail', 'personRoleInput', 'personCity', 'personState', 'personSeniority']) {
      expect(dialog, id).toContain(`for="${id}"`);
    }
    // The facts that matter, not the order the attributes happen to be written in.
    const tagOf = (id) => dialog.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] ?? '';
    for (const [id, type, autocomplete] of [['personName', 'text', 'name'], ['personEmail', 'email', 'email']]) {
      const tag = tagOf(id);
      expect(tag, id).toContain(`type="${type}"`);
      expect(tag, id).toContain(`autocomplete="${autocomplete}"`);
      expect(tag, id).toMatch(/\srequired[\s>]/);
      expect(tag, id).toContain(`aria-describedby="${id}Error"`);
    }
    expect(dialog).toContain('aria-describedby="personRolesHint personRolesError"');
    expect(dialog).toContain('id="personFormError" role="alert"');
    expect(dialog).toContain('id="personResumeStatus" role="status" aria-live="polite"');
  });

  it('never replaces anyone\'s resume from this form', () => {
    expect(dialog).toContain('it becomes their own master resume');
    const profiles = read('assets/js/profiles.js');
    expect(profiles).toContain("'/api/search-profiles/read-resume'");
    expect(profiles).not.toContain("'/api/master-resume'");
  });

  it('works the job-title chips by keyboard, with named remove buttons', () => {
    const profiles = read('assets/js/profiles.js');
    expect(profiles).toMatch(/event\.key === 'Enter' \|\| event\.key === ','/);
    expect(profiles).toMatch(/event\.key === 'Backspace' && !input\.value/);
    expect(profiles).toContain("'aria-label': `Remove ${role}`");
  });

  it('is reachable from the Profile menu even with one person', () => {
    const menu = html.slice(html.indexOf('id="accountMenu"'), html.indexOf('id="profileMenuSep"'));
    expect(menu).toContain('data-action="open-add-profile"');
    // The add row is static markup under the people list, so it is there
    // whether one person or several are listed.
    expect(menu).toMatch(/id="profileMenuItems"[^>]*><\/div>\s*<button role="menuitem" class="pf-add-item"/);
  });

  it('reloads into the new person when the workspace changes, keeping "Switch back"', () => {
    const profiles = read('assets/js/profiles.js');
    expect(profiles).toMatch(/if \(r\.workspaceChanged\) \{ reloadAsNewPerson\(/);
    expect(profiles).toMatch(/export function announcePendingSwitch\(\)/);
    expect(read('assets/js/main.js')).toContain('loadProfiles().then(announcePendingSwitch);');
  });

  it('asks before someone else\'s resume replaces the active person\'s', () => {
    const master = read('assets/js/master.js');
    expect(master).toContain("title: 'Whose resume is this?'");
    expect(master).toMatch(/altLabel: `Replace \$\{person\.split\(' '\)\[0\]\}'s resume`, onAlt: \(\) => installMasterResume\(file, bytes\)/);
  });
});

describe('starting a new person with jobs already found', () => {
  let root; let db; let dash;
  const call = async (method, path, body) => {
    const r = await fetch(`${dash.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const recent = new Date(Date.now() - 3 * 864e5).toISOString();
  const old = new Date(Date.now() - 120 * 864e5).toISOString();

  beforeEach(async () => {
    root = makeRoot();
    saveProfile(root, DANA);
    writeFileSync(join(root, 'config', 'profiles', '_active.json'), JSON.stringify({ id: DANA.id }));
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(['Dana Okafor', 'Senior Data Engineer']));
    db = openDatabase({ path: ':memory:' });
    const posting = (id, title, extra = {}) => db.upsertJob({
      id, title, company: 'Contoso Pharma', status: 'scored', score: 30, tier: 'Discard', posted_at: recent,
      jd_text: `${title}. FDA submissions, CMC change control, annual reports.`, discovery_mode: 'profile', ...extra,
    });
    posting('fit-1', 'Regulatory Specialist', { notes: 'Dana: not for me', user_decision: 'rejected', score: 12 });
    posting('fit-2', 'Senior Regulatory Specialist');
    posting('fit-old', 'Regulatory Specialist II', { posted_at: old });
    posting('fit-closed', 'Regulatory Specialist III', { discard_reason: 'posting closed by the employer' });
    posting('fit-search', 'Regulatory Specialist IV', { discovery_mode: 'role_search' });
    posting('miss', 'Senior Data Engineer', { company: 'Northwind' });
    const config = loadConfig({ root });
    dash = await startDashboard({ config, db, logger: { info() {}, warn() {}, error() {}, debug() {} }, port: 0 });
  });
  afterEach(async () => { await dash?.close(); db?.close(); rmSync(root, { recursive: true, force: true }); });

  it('copies recent, open, personalized postings that fit — posting facts only — and scores them as theirs', async () => {
    const r = await call('POST', '/api/search-profiles', {
      fields: { fullName: 'Morgan Ellison', email: 'morgan@example.com', targetRoles: ['Regulatory Specialist'], seniority: 'senior' },
      activate: true, seed: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.seeded).toBe(2); // fit-1 and fit-2; not old, closed, role-search or the data job
    await new Promise((res) => setTimeout(res, 400)); // the rescore runs just after activation
    const herDb = openDatabase({ path: workspacePaths(root, r.body.workspace).db });
    try {
      const rows = herDb.db.prepare('SELECT id, notes, user_decision, scoring_fingerprint, score FROM jobs ORDER BY id').all();
      expect(rows.map((x) => x.id)).toEqual(['fit-1', 'fit-2']);
      for (const row of rows) {
        expect(row.notes ?? null).toBeNull(); // Dana's note stays Dana's
        expect(row.user_decision ?? null).toBeNull(); // so does her rejection
        expect(row.scoring_fingerprint).not.toBe(''); // re-judged under Morgan's profile
      }
    } finally { herDb.close(); }
    // Dana's own rows are untouched.
    expect(db.getJob('fit-1')).toMatchObject({ notes: 'Dana: not for me', score: 12 });
  });

  it('copies nothing unless asked', async () => {
    const r = await call('POST', '/api/search-profiles', {
      fields: { fullName: 'Morgan Ellison', email: 'morgan@example.com', targetRoles: ['Regulatory Specialist'] }, activate: true,
    });
    expect(r.body.seeded).toBe(0);
    expect((await call('GET', '/api/jobs?pageSize=50')).body.total).toBe(0);
  });
});

describe('one person, one profile', () => {
  let root;
  beforeEach(() => { root = makeRoot(); saveProfile(root, DANA); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('recognises the same person despite case and a middle initial, and asks', async () => {
    const { findSamePerson, createPersonProfile } = await import('../../src/profile/store.js');
    expect(findSamePerson(root, 'DANA K OKAFOR')).toEqual({ id: 'dana-okafor', name: 'Dana Okafor' });
    expect(findSamePerson(root, 'Dana Smith')).toBeNull();
    const fields = { fullName: 'Dana K Okafor', email: 'dana2@example.com', targetRoles: ['Analytics Engineer'] };
    expect(() => createPersonProfile(root, fields)).toThrow(/already has a profile/);
    try { createPersonProfile(root, fields); } catch (err) { expect(err.statusCode).toBe(409); expect(err.existing.id).toBe('dana-okafor'); }
    // "Add anyway" is a deliberate second profile.
    expect(createPersonProfile(root, { ...fields, allowDuplicate: true }).id).toBe('dana-k-okafor');
  });
});

describe('editing keeps what the form does not show', () => {
  it('leaves a remote + hybrid preference alone unless "Remote only" is changed', async () => {
    const root = makeRoot();
    try {
      const { updatePersonProfile, readProfile } = await import('../../src/profile/store.js');
      saveProfile(root, normalizeProfile({ ...DANA, searchIntent: { ...DANA.searchIntent, workModes: ['remote', 'hybrid'] } }));
      const fields = { fullName: 'Dana Okafor', email: 'dana@example.com', targetRoles: ['Analytics Engineer'] };
      updatePersonProfile(root, DANA.id, fields);
      expect(readProfile(root, DANA.id).searchIntent.workModes).toEqual(['remote', 'hybrid']);
      updatePersonProfile(root, DANA.id, { ...fields, remoteOnly: true });
      expect(readProfile(root, DANA.id).searchIntent.workModes).toEqual(['remote']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('personal workspace files stay out of git', () => {
  it('ignores every per-person folder', () => {
    const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
    for (const entry of ['resumes/profiles/', 'applications/profiles/', 'data/*', 'config/profiles/']) expect(ignore, entry).toContain(entry);
  });
});
