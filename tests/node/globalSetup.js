/**
 * Vitest globalSetup: run the whole suite against a THROWAWAY workspace.
 *
 * Why
 * ---
 * This used to seed config/candidate.json, screening answers, the cover letter
 * and the master resume into the REAL checkout when they were missing. On a
 * clean clone that was enough; on a developer's machine it meant the opposite
 * of isolation — every `loadConfig()` read that person's real profile and
 * resume, every default `openDatabase()` opened their real
 * data/applied_jobs.db, and logs landed in their real logs/. A test could pass
 * or fail depending on whose laptop ran it.
 *
 * Now a temp root is built once per run:
 *   config/      the repo's SHARED config (scoring, jobboards, schemas, role
 *                families …) with the fictional fixtures from
 *                tests/node/fixtures/config/ as candidate.json,
 *                screening_answers.json and cover_letter.json. Saved search
 *                profiles (config/profiles/) are deliberately NOT copied.
 *   resumes/base/MASTER_RESUME.docx   the synthetic example resume
 *   data/ logs/ reports/ resumes/output/ applications/output/   empty
 *
 * and JOB_AGENT_ROOT points at it. src/config/loadConfig.js resolves
 * PROJECT_ROOT from that variable, so the config loader, the default database
 * path and the log directory all follow. Workers are forked after this runs
 * and inherit the variable. The directory is removed on teardown.
 *
 * Tests that need the REPOSITORY itself (fixture files, schemas, launchers)
 * keep resolving it from their own file location, which is unaffected.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_CONFIG = join(REPO, 'tests', 'node', 'fixtures', 'config');

/** Personal (gitignored) config: never copied from the checkout. */
const PERSONAL = new Set(['candidate.json', 'screening_answers.json', 'cover_letter.json']);

/**
 * Build the isolated workspace.
 * @param {string} [repo=REPO]
 * @returns {string} the temp root
 */
export function buildTestRoot(repo = REPO) {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-test-root-'));
  const src = join(repo, 'config');
  const dst = join(root, 'config');
  cpSync(src, dst, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      if (path === src) return true;
      if (dirname(path) === src && PERSONAL.has(name)) return false;
      if (name === 'profiles' || name === 'derived' || name.endsWith('.bak')) return false;
      return true;
    },
  });
  for (const name of PERSONAL) {
    const fixture = join(FIXTURE_CONFIG, name);
    if (!existsSync(fixture)) throw new Error(`test fixture missing from the repository: ${fixture}`);
    copyFileSync(fixture, join(dst, name));
  }

  const example = join(repo, 'resumes', 'base', 'MASTER_RESUME.example.docx');
  if (!existsSync(example)) throw new Error(`example resume missing from the repository: ${example}`);
  mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
  copyFileSync(example, join(root, 'resumes', 'base', 'MASTER_RESUME.example.docx'));
  copyFileSync(example, join(root, 'resumes', 'base', 'MASTER_RESUME.docx'));

  for (const dir of ['data', 'logs', 'reports', join('resumes', 'output'), join('applications', 'output')]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

export default function setup() {
  // Many test files boot a dashboard in parallel on the same workspace root; the
  // cross-process run lock (src/utils/runLock.js) would make those unrelated
  // servers 409 each other. Tests that exercise the lock opt back in.
  process.env.JOB_AGENT_RUN_LOCK = 'off';
  // The dashboard's live "is Chromium installed?" check would make status
  // labels depend on the machine running the suite. Tests inject it instead.
  process.env.JOB_AGENT_BROWSER_CHECK = 'off';
  // No background posting-status sweep (it would call real ATS APIs).
  process.env.JOB_AGENT_POSTING_SWEEP = 'off';
  // Fixture approvals point at packets that do not exist on disk; the boot-time
  // packet check would withdraw them. packetHygiene.test.js turns it back on.
  process.env.JOB_AGENT_PACKET_HYGIENE = 'off';
  // No boot-time retention sweep: fixture rows carry fixed posting dates, and
  // retiring them by wall-clock age would make board assertions date-dependent.
  // retentionSweep.test.js turns it back on.
  process.env.JOB_AGENT_RETENTION_SWEEP = 'off';
  // No scheduled backups (P1-6); dashboardBackups.test.js drives them directly.
  process.env.JOB_AGENT_BACKUPS = 'off';
  // No background description fetching: it would call real ATS APIs, and it is
  // off by default anyway. dataQualityDashboard.test.js drives it with stubs.
  process.env.JOB_AGENT_ENRICHMENT = 'off';
  // Dashboards started by tests do not require the access token (P1-5):
  // dozens of suites call the API directly. dashboardApiToken.test.js turns it
  // back on with an explicit deps.apiToken and tests the lock itself.
  process.env.JOB_AGENT_DASHBOARD_AUTH = 'off';
  const root = buildTestRoot();
  process.env.JOB_AGENT_ROOT = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
