/**
 * Dashboard profile API tests.
 *
 * Boots the real server against a temp project root and drives the Application
 * Profile endpoints over loopback HTTP. The point of these cases is the two
 * things unit tests of the store cannot show:
 *
 *   1. An auto-fill run's unanswered questions reach the queue through the
 *      server — the capture point the whole learning loop hangs on.
 *   2. Saving a profile REBINDS the live config bundle, so the very next run
 *      fills the new values instead of the ones loaded at boot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { readProfile } from '../../src/config/profileStore.js';

const REPO = process.cwd();
const NOW = new Date('2026-08-16T10:00:00Z');

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-dash-profile-'));
  mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  for (const file of ['candidate.example.json', 'screening_answers.example.json']) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'config', 'screening_answers.example.json'), join(root, 'config', 'screening_answers.json'));
  copyFileSync(
    join(REPO, 'config', 'schemas', 'candidate.schema.json'),
    join(root, 'config', 'schemas', 'candidate.schema.json'),
  );
  return root;
}

describe('dashboard application profile API', () => {
  let db;
  let dash;
  let root;
  /** Candidate name the fake runner saw at fill time, per job. */
  let filledNames;

  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    root = makeRoot();
    filledNames = [];
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'j1', company: 'CoorsTek', title: 'Forward Deployed Data Engineer',
      url: 'https://coorstek.wd1.myworkdayjobs.com/job/R-113886', source: 'workday',
      score: 88, tier: 'Priority', status: 'prepared', application_packet_path: '/p/j1.json',
    });
    db.insertApproval({ id: 'ap1', job_id: 'j1', packet_path: '/p/j1.json', approval_status: 'approved' });

    // Stand in for loadConfig: the reload path does not need the full config
    // set, only proof that the bundle handed to the runner is re-read.
    const fakeLoadConfig = ({ root: r }) => ({
      root: r,
      candidate: { identity: { fullName: readProfile(r).fields.find((f) => f.field === 'fullName').value } },
      screeningAnswers: {},
      runtime: {},
    });

    dash = await startDashboard({
      // A real root, so the profile routes operate on real files.
      config: fakeLoadConfig({ root }),
      db, logger: null, port: 0,
      deps: {
        extensionKey: 'k'.repeat(32),
        now: () => NOW,
        loadConfigImpl: fakeLoadConfig,
        loadPacketImpl: () => ({
          id: 'pk-j1', job: { id: 'j1', url: 'https://coorstek.wd1.myworkdayjobs.com/job/R-113886' },
          // Stamped for whoever the profile names now, as a freshly prepared
          // packet would be: an ownerless packet is refused as foreign.
          owner: { candidateName: fakeLoadConfig({ root }).candidate.identity.fullName },
          ats: { platform: 'workday' }, blockers: [],
          prefill: { plan: [], needsUser: [] }, screeningPlan: { answered: [], needsUser: [] },
          uploads: { blockers: [] }, stopBeforeSubmit: true,
        }),
        // A run that fills what it can and reports what it could not answer —
        // exactly the contract applyRunner now returns.
        assistFn: async ({ config }) => {
          filledNames.push(config?.candidate?.identity?.fullName ?? null);
          return {
            status: 'assist_blocked',
            blockers: ['required field needs user: Which Databricks certifications do you currently hold?'],
            needsUser: [
              {
                label: 'Which Databricks certifications do you currently hold?',
                required: true, kind: 'text', options: [],
              },
              {
                label: 'Are you 18 years of age or older?',
                required: true, kind: 'select',
                options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }],
              },
            ],
          };
        },
      },
    });
  });

  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Run one auto-fill batch and wait for the background job to finish. */
  async function runAssist() {
    await post('/api/assist-batch', { jobIds: ['j1'] });
    for (let i = 0; i < 100; i += 1) {
      const status = await get('/api/run/status');
      if (!status.body.running) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('assist batch never finished');
  }

  it('reports the profile, its answers, and an empty queue before any run', async () => {
    const { status, body } = await get('/api/profile');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.profile.fields.find((f) => f.field === 'email').value).toBe('you@example.com');
    expect(body.screening.answers.length).toBeGreaterThan(0);
    expect(body.questions.openCount).toBe(0);
  });

  it('flags template values, so the page can show them as placeholders instead of saved data', async () => {
    const { body } = await get('/api/profile');
    // The shipped example's email and answers are TEMPLATE text ...
    expect(body.profile.fields.find((f) => f.field === 'email').placeholder).toBe(true);
    expect(body.screening.answers.find((a) => a.id === 'years_experience').placeholder).toBe(true);

    // ... and once there is a real value, it is no longer flagged.
    expect((await post('/api/profile', { values: { 'contact.email': 'real.person@gmail.com' } })).status).toBe(200);
    const after = (await get('/api/profile')).body;
    expect(after.profile.fields.find((f) => f.field === 'email').placeholder).toBe(false);
  });

  it('captures what a run could not answer, with the job that asked and a usable suggestion', async () => {
    await runAssist();

    const { body } = await get('/api/profile');
    expect(body.questions.openCount).toBe(2);
    const cert = body.questions.open.find((q) => /certifications/i.test(q.label));
    expect(cert.required).toBe(true);
    expect(cert.jobs[0].company).toBe('CoorsTek');
    expect(cert.suggestedId).toBe('databricks_certifications');
    expect(cert.suggestedPatterns).toContain('databricks certifications');
    // The live form's own choices ride along for the answer form.
    const age = body.questions.open.find((q) => /18 years/i.test(q.label));
    expect(age.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('re-running does not duplicate a question, it counts it', async () => {
    await runAssist();
    await runAssist();
    const { body } = await get('/api/profile');
    expect(body.questions.openCount).toBe(2);
    expect(body.questions.open.every((q) => q.seenCount === 2)).toBe(true);
  });

  it('answering a queued question writes the config and clears it from the queue', async () => {
    await runAssist();
    const before = await get('/api/profile');
    const cert = before.body.questions.open.find((q) => /certifications/i.test(q.label));

    const { status, body } = await post('/api/profile/questions/answer', {
      key: cert.key, id: cert.suggestedId, patterns: cert.suggestedPatterns,
      answer: 'Databricks Certified Data Engineer Associate', question: cert.label,
    });
    expect(status).toBe(200);
    expect(body.screening.answers.some((a) => a.id === 'databricks_certifications')).toBe(true);
    expect(body.questions.open.some((q) => /certifications/i.test(q.label))).toBe(false);
    expect(body.questions.openCount).toBe(1);
  });

  /**
   * Set the stated work authorization in the temp root.
   *
   * Sponsorship truthfulness is judged against the candidate's OWN requirement,
   * so a test about a false claim has to say whose claim it is. The same
   * sentence is a misrepresentation for one person and the plain truth for
   * another, and asserting either without fixing this value tests nothing.
   */
  function setSponsorshipRequirement(requiresSponsorship) {
    const file = join(root, 'config', 'candidate.json');
    const candidate = JSON.parse(readFileSync(file, 'utf8'));
    candidate.workAuthorization.requiresSponsorship = requiresSponsorship;
    candidate.sponsorshipRequired = requiresSponsorship;
    writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`);
  }

  it('refuses an answer that would misstate work authorization', async () => {
    setSponsorshipRequirement(true);
    const { status, body } = await post('/api/profile/questions/answer', {
      id: 'sponsor_claim', patterns: ['visa sponsorship needed'], answer: 'No sponsorship required',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/contradicts the work authorization in your profile/i);
  });

  it('accepts that same answer for a candidate who needs no sponsorship', async () => {
    // The mirror case, and the one that used to be impossible: an absolute
    // blocklist refused to save a US citizen's truthful answer.
    setSponsorshipRequirement(false);
    const { status } = await post('/api/profile/questions/answer', {
      id: 'sponsor_claim', patterns: ['visa sponsorship needed'], answer: 'No sponsorship required',
    });
    expect(status).toBe(200);
  });

  it('refuses an inherited claim that contradicts the current profile', async () => {
    // The leak a profile switch would otherwise carry: the previous candidate's
    // H-1B answer, still on file, under a profile that needs no sponsorship.
    setSponsorshipRequirement(false);
    const { status, body } = await post('/api/profile/questions/answer', {
      id: 'sponsor_claim', patterns: ['visa sponsorship needed'],
      answer: 'Yes, I will require sponsorship (H-1B transfer).',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/contradicts/i);
  });

  it('refuses an affirmative answer to a reversed sponsorship question', async () => {
    setSponsorshipRequirement(true);
    const { status, body } = await post('/api/profile/questions/answer', {
      id: 'auth_ok', patterns: ['legally authorized'], answer: 'Yes',
      question: 'Can you work in the United States without sponsorship?',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/inverted sponsorship question/i);
  });

  it('reports a bad profile value as a 400, not a server error', async () => {
    const { status, body } = await post('/api/profile', { values: { 'contact.email': 'nope' } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/would not load/i);
  });

  it('a saved profile is used by the NEXT run, without restarting', async () => {
    await runAssist();
    expect(filledNames).toEqual(['Jane Doe']);

    const saved = await post('/api/profile', { values: { 'identity.fullName': 'Ada Lovelace' } });
    expect(saved.status).toBe(200);
    expect(saved.body.warning).toBeNull();

    await runAssist();
    expect(filledNames).toEqual(['Jane Doe', 'Ada Lovelace']);
  });

  it('dismisses a question without deleting it, and can reopen it', async () => {
    await runAssist();
    const { body } = await get('/api/profile');
    const key = body.questions.open[0].key;

    const dismissed = await post('/api/profile/questions/status', { key, status: 'dismissed' });
    expect(dismissed.body.questions.openCount).toBe(1);
    expect(dismissed.body.questions.resolved).toHaveLength(1);

    const reopened = await post('/api/profile/questions/status', { key, status: 'open' });
    expect(reopened.body.questions.openCount).toBe(2);
  });

  it('rejects a whole-document answer save that would break the matcher', async () => {
    const { status, body } = await post('/api/profile/answers', {
      defaults: { unknownAction: 'ask_user' },
      answers: [{ id: 'x', patterns: ['how many years?'], answer: '10' }],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/ends in punctuation/i);
  });
});
