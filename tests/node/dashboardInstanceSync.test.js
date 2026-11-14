/**
 * One install, one source of truth (audit BUG-03, BUG-04).
 *
 * BUG-03: `npm run app` and `npm run dashboard` could serve the same folder
 * from two ports; each cached config and the database in memory, so switching
 * person in one left the other querying the previous person's jobs against
 * the new person's files. Now a workspace lock stops the second launcher, and
 * a server notices an activation made by another process.
 *
 * BUG-04: editing the ACTIVE profile during a run saved the file and then
 * answered 409 "applies after the run" — nothing ever applied it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { saveProfile, activateProfile } from '../../src/profile/store.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { lockPath, readLiveLock, writeLock } from '../../src/dashboard/instanceLock.js';

const REPO = process.cwd();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-instance-'));
  for (const dir of ['config/schemas', 'config/profiles', 'data', 'resumes/base']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json', 'ats_resume.json', 'role_families.json']) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
  copyFileSync(join(REPO, 'config', 'screening_answers.example.json'), join(root, 'config', 'screening_answers.json'));
  for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'ats_resume']) {
    copyFileSync(join(REPO, 'config', 'schemas', `${schema}.schema.json`), join(root, 'config', 'schemas', `${schema}.schema.json`));
  }
  writeFileSync(join(root, '.env'), '');
  return root;
}

const person = (id, role, workspace) => normalizeProfile({
  id, label: role, identity: { fullName: id.replace('-', ' ') }, contact: { email: `${id}@example.com` },
  location: { city: 'Springfield', state: 'Illinois', country: 'United States' },
  background: { currentRoles: [role], skills: ['SQL'] },
  searchIntent: { targetRoles: [role], seniority: 'senior', workAuthorization: { status: 'US Citizen', requiresSponsorship: false } },
  ...(workspace ? { workspace } : {}),
});

describe('the workspace lock', () => {
  let root;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('names a live holder, ignores a dead or own one, and releases only its own lock', () => {
    expect(readLiveLock(root)).toBeNull();
    const release = writeLock(root, { port: 4747, pid: 424242 });
    expect(readLiveLock(root, { alive: () => true })).toMatchObject({ pid: 424242, port: 4747 });
    expect(readLiveLock(root, { alive: () => false })).toBeNull(); // crashed holder
    expect(readLiveLock(root, { alive: () => true, selfPid: 424242 })).toBeNull();
    writeFileSync(lockPath(root), JSON.stringify({ pid: 1, port: 4646 })); // someone else took over
    release();
    expect(existsSync(lockPath(root))).toBe(true);
    writeFileSync(lockPath(root), 'not json');
    expect(readLiveLock(root, { alive: () => true })).toBeNull();
  });
});

describe('two servers on one folder', () => {
  let root; let dbA; let dbB; let a; let b;
  const call = async (dash, method, path, body) => {
    const r = await fetch(`${dash.url}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };

  beforeEach(async () => {
    root = makeRoot();
    saveProfile(root, person('dana-okafor', 'Senior Data Engineer'));
    saveProfile(root, person('morgan-ellison', 'Regulatory Specialist', 'morgan-ellison'));
    activateProfile(root, 'dana-okafor');
    dbA = openDatabase({ path: ':memory:' });
    dbA.upsertJob({ id: 'dana-job', title: 'Senior Data Engineer', company: 'Northwind', status: 'scored', score: 80, jd_text: 'SQL', discovery_mode: 'profile' });
    dbB = openDatabase({ path: ':memory:' });
    dbB.upsertJob({ id: 'dana-job', title: 'Senior Data Engineer', company: 'Northwind', status: 'scored', score: 80, jd_text: 'SQL', discovery_mode: 'profile' });
    a = await startDashboard({ config: loadConfig({ root }), db: dbA, logger: quiet, port: 0 });
    b = await startDashboard({ config: loadConfig({ root }), db: dbB, logger: quiet, port: 0 });
  });
  afterEach(async () => {
    await a?.close(); await b?.close(); dbA?.close(); dbB?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a switch made through one server is followed by the other', async () => {
    expect((await call(a, 'GET', '/api/jobs?pageSize=50')).body.total).toBe(1);
    const switched = await call(b, 'POST', '/api/search-profiles/activate', { id: 'morgan-ellison' });
    expect(switched.status).toBe(200);
    // Server A did not handle the switch, but must not keep serving Dana's
    // database against Morgan's files.
    expect((await call(a, 'GET', '/api/jobs?pageSize=50')).body.total).toBe(0);
    const listing = await call(a, 'GET', '/api/search-profiles');
    expect(listing.body.activeId ?? listing.body.active?.id).toBe('morgan-ellison');
  });

  it('editing the active profile during a run is refused before anything is written', async () => {
    const file = join(root, 'config', 'profiles', 'dana-okafor.json');
    const before = readFileSync(file, 'utf8');
    a.runState.running = true;
    a.runState.phase = 'find';
    try {
      const r = await call(a, 'PATCH', '/api/search-profiles/dana-okafor', { fields: { targetRoles: ['Staff Data Engineer'] } });
      expect(r.status).toBe(409);
      expect(r.body.notSaved).toBe(true);
      expect(r.body.error).toMatch(/nothing was saved/);
    } finally {
      a.runState.running = false;
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    // An inactive person can still be edited during a run.
    const other = await call(a, 'PATCH', '/api/search-profiles/morgan-ellison', { fields: { fullName: 'Morgan Ellison', email: 'morgan@example.com', targetRoles: ['Regulatory Affairs Manager'], seniority: 'senior' } });
    expect(other.body.error ?? '').not.toMatch(/run/);
    expect(other.status).toBe(200);
  });
});

describe('workspace database handles (RISK-01)', () => {
  it('closes a person\'s handle once the dashboard switches away and nothing is running', async () => {
    const root = makeRoot();
    saveProfile(root, person('dana-okafor', 'Senior Data Engineer'));
    saveProfile(root, person('morgan-ellison', 'Regulatory Specialist', 'morgan-ellison'));
    activateProfile(root, 'dana-okafor');
    const boot = openDatabase({ path: ':memory:' });
    const opened = [];
    const dash = await startDashboard({
      config: loadConfig({ root }), db: boot, logger: quiet, port: 0,
      deps: { openDatabaseImpl: (opts) => { const h = openDatabase(opts); const close = h.close.bind(h); h.closed = false; h.close = () => { h.closed = true; close(); }; opened.push(h); return h; } },
    });
    const post = (path, body) => fetch(`${dash.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      expect((await post('/api/search-profiles/activate', { id: 'morgan-ellison' })).status).toBe(200);
      expect(opened).toHaveLength(1);
      expect((await post('/api/search-profiles/activate', { id: 'dana-okafor' })).status).toBe(200);
      expect(opened[0].closed).toBe(true);
      // The caller's boot handle is never closed by the server.
      expect(() => boot.getJob('x')).not.toThrow();
    } finally {
      await dash.close(); boot.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});

