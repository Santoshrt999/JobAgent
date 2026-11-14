/**
 * CLI entry point.
 *
 * Two invocation styles are supported:
 *
 *   1. Phase commands (preferred):
 *        node src/index.js doctor         preflight checks (alias: preflight)
 *        node src/index.js discover       search only -> found_jobs.json
 *        node src/index.js score          + score    -> scored/queued_jobs.json
 *        node src/index.js prepare-apps   + tailor + packets + approval queue
 *        node src/index.js assist         open browser, fill, STOP before submit
 *        node src/index.js end-to-end     discover -> ... -> assist (stops before submit)
 *        node src/index.js approvals      list packets awaiting review
 *        node src/index.js approve <id>   record human approval
 *        node src/index.js reject <id>    record human rejection
 *        node src/index.js packets        list prepared packets
 *        node src/index.js packet <id>    show one packet (by job id / packet id)
 *
 *   2. Legacy mode flag (kept for compatibility):
 *        node src/index.js --mode=DRY_RUN | PREPARE | LIVE_ASSIST
 *        node src/index.js --mode          (uses RUN_MODE from .env)
 *        node src/index.js --report
 *
 *   `help` / `--help` / `-h` (and a bare invocation) print the command list,
 *   generated from COMMAND_TABLE below; `--version` prints the version.
 *
 * No CLI COMMAND ever submits an application. The browser assist fills forms and
 * advances through safe navigation (Next/Continue/Review) but always stops
 * before the final submit so a human can review and click it. There is no
 * bypass of CAPTCHA / login / MFA / bot protection anywhere in this project.
 *
 * On auto-submit, precisely (this file used to say "there is no auto-submit
 * path", which contradicted both the README and the code):
 *
 *   - No CLI command can submit. `runAssist` forces autoSubmit: false whatever
 *     options it is given, and no CLI path passes any.
 *   - ONE path can submit: POST /api/auto-submit-batch on the local dashboard,
 *     which requires an explicit per-run authorization (`confirmed: true`), a
 *     fresh server-side eligibility check, zero blockers, a truthful-sponsorship
 *     assertion, and a uniquely-resolved submit control. A click is still not a
 *     submission: `verifySubmission()` must find confirmation evidence or the
 *     row is recorded as `submit_unverified`, explicitly NOT as submitted.
 *   - That route is currently NOT reachable from the shipped dashboard UI — no
 *     front-end code calls it. It exists for an explicit, deliberate opt-in and
 *     is exercised by tests, not by a button.
 *
 * docs/SUPPORT_MATRIX.md and the README's Safety model section say the same
 * thing; this comment is the CLI-local statement of it.
 */

import { loadConfig } from './config/loadConfig.js';
import { openDatabase } from './logging/db.js';
import { JobLogger, createPinoLogger } from './logging/jobLogger.js';
import { generateReport } from './reports/reportGenerator.js';
import { runPipeline } from './pipeline/index.js';
import {
  runDiscover, runScore, runPrepareApps, runAssist, runEndToEnd,
  listApprovalQueue, approvePacket, rejectPacket, listPackets, getPacket,
} from './cli/commands.js';
import { runGuided } from './cli/guided.js';
import { runApply } from './cli/applyOneByOne.js';
import { runWatch, createWatchStopSignal } from './cli/watch.js';
import { runDoctor, printDoctorReport } from './cli/doctor.js';
import { quickPreflight } from './cli/preflight.js';
import { withSourceSelection, selectionFromArgs } from './cli/sourceSelection.js';
import { parseDashboardPort } from './cli/app.js';
import { ui } from './cli/ui.js';
import { formatPostedRelative } from './utils/dates.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acquireRunLock } from './utils/runLock.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { relPath as rel } from './utils/outputPaths.js';

/** CLI commands that write the jobs table in bulk and must not overlap another run. */
const CLI_LOCKED_COMMANDS = new Set(['discover', 'score', 'prepare-apps', 'go', 'start', 'end-to-end', 'watch']);

/** Short, readable form of an approval UUID (keeps it copy-pasteable in full). */
function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

/** Human label for a job from a discovered/scored row. */
function jobLabel(row) {
  const company = row.company || 'Unknown company';
  const title = row.title || 'Untitled role';
  return `${company} — ${title}`;
}

/** Short "Posted: <relative>" suffix from a row's postedAt/posted_at field. */
function postedLabel(row) {
  return `Posted: ${formatPostedRelative(row?.postedAt ?? row?.posted_at ?? null)}`;
}

/** Colored "ATS NN%" chip from a job row's persisted ats_score/ats_band. */
function atsLabel(row) {
  const score = row?.ats_score;
  if (score === null || score === undefined || score === '') return '';
  const n = Number(score);
  if (!Number.isFinite(n)) return '';
  const text = `ATS ${n}%`;
  if (n >= 70 && n < 90) return ui.c.green(text);
  if (n >= 90) return ui.c.yellow(text);
  return ui.c.yellow(text);
}

const VALID_MODES = new Set(['DRY_RUN', 'PREPARE', 'LIVE_ASSIST']);

/**
 * THE command table. Dispatch, `help`, and the unknown-command message are all
 * derived from it, so a command cannot exist without being listed (or be listed
 * without existing) — the hand-written usage text drifted from the dispatcher,
 * and `--help` itself fell through to a live discovery run.
 *
 * `kind` decides how a command is dispatched:
 *   phase      — runCommand(): needs a healthy config + database
 *   standalone — must work when config/db are broken. `doctor` diagnoses those
 *                files; `profiles` REWRITES them, and the config it is about to
 *                replace may be exactly what is wrong — requiring a healthy
 *                load first would lock a user out of the command that fixes it.
 *   app / help — handled before any config is loaded
 *
 * @type {ReadonlyArray<{name: string, kind: string, group: string, summary: string,
 *   usage?: string, aliases?: string[], hidden?: boolean}>}
 */
export const COMMAND_TABLE = Object.freeze([
  { name: 'app', kind: 'app', group: 'Start', summary: 'Start the dashboard and open it in your browser (what the launchers run)' },
  { name: 'go', aliases: ['start'], kind: 'phase', group: 'Start', summary: 'Guided run: preflight, discover, score, prepare, then assist' },
  { name: 'dashboard', aliases: ['ui'], kind: 'phase', group: 'Start', summary: 'Start only the local dashboard server (no browser, no port fallback)' },
  { name: 'doctor', aliases: ['preflight'], kind: 'standalone', group: 'Setup', summary: 'Preflight checklist (--json for machine-readable output)' },
  { name: 'profiles', kind: 'standalone', group: 'Setup', usage: 'profiles [<sub>]', summary: 'Search profiles: show, activate, preview, from-resume, migrate, delete' },
  { name: 'discover', kind: 'phase', group: 'Pipeline', summary: 'Search enabled job boards -> data/found_jobs.json (--source=<id> narrows)' },
  { name: 'score', kind: 'phase', group: 'Pipeline', summary: 'Discover + score against your profile -> scored/queued jobs' },
  { name: 'rescore', kind: 'phase', group: 'Pipeline', summary: 'Re-score stored jobs whose score predates the current profile/scoring config' },
  { name: 'prepare-apps', kind: 'phase', group: 'Pipeline', summary: 'Tailor resumes and build application packets for strong matches' },
  { name: 'end-to-end', kind: 'phase', group: 'Pipeline', summary: 'Discover -> score -> prepare -> assist (always stops before submit)' },
  { name: 'watch', kind: 'phase', group: 'Pipeline', summary: 'Poll for new strong matches (--interval=N --free-only --once --max-failures=N)' },
  { name: 'approvals', kind: 'phase', group: 'Review', summary: 'List packets awaiting your review (--all for every status)' },
  { name: 'approve', kind: 'phase', group: 'Review', usage: 'approve <approvalId>', summary: 'Record your approval of a packet' },
  { name: 'reject', kind: 'phase', group: 'Review', usage: 'reject <approvalId>', summary: 'Record your rejection of a packet' },
  { name: 'packets', kind: 'phase', group: 'Review', summary: 'List prepared packets' },
  { name: 'packet', kind: 'phase', group: 'Review', usage: 'packet <jobId|packetId>', summary: 'Show one packet' },
  { name: 'report', kind: 'phase', group: 'Review', summary: 'Regenerate the CSV/HTML/JSON report from the database' },
  { name: 'assist', kind: 'phase', group: 'Apply', summary: 'Open a browser and fill approved applications; stops before Submit' },
  { name: 'apply', kind: 'phase', group: 'Apply', summary: 'Apply one-by-one: fill, pause for you, next (--all: every approved packet)' },
  { name: 'help', kind: 'help', group: 'Other', aliases: ['-h', '--help'], summary: 'Show this list (--version prints the version)' },
  // Kept only so old muscle memory gets an explanation instead of "unknown
  // command". It never submits anything.
  { name: 'live-submit', kind: 'phase', group: 'Other', summary: 'Removed; explains the replacement', hidden: true },
]);

/** All names (primary + aliases) of the table entries of one kind. */
function namesOfKind(kind) {
  return COMMAND_TABLE.filter((c) => c.kind === kind).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
}

/** Phase commands handled by the dispatcher (vs. the legacy mode path). */
const COMMANDS = new Set(namesOfKind('phase'));

/** Commands that must work even when config/db are broken (see COMMAND_TABLE). */
const STANDALONE_COMMANDS = new Set(namesOfKind('standalone'));

/** This package's version, for `--version` and the help banner. Never fatal. */
export function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Grouped help text, built from COMMAND_TABLE so it cannot drift.
 * @returns {string}
 */
export function helpText() {
  const visible = COMMAND_TABLE.filter((c) => !c.hidden);
  const label = (c) => c.usage ?? [c.name, ...(c.aliases ?? [])].join(' | ');
  const width = Math.max(...visible.map((c) => label(c).length));
  const lines = [
    `Job Agent ${packageVersion()} — local-first job search assistant`,
    '',
    'Usage:  node src/index.js <command> [options]      (or: npm run <command>)',
  ];
  for (const group of new Set(visible.map((c) => c.group))) {
    lines.push('', `${group}:`);
    for (const c of visible.filter((x) => x.group === group)) {
      lines.push(`  ${label(c).padEnd(width)}  ${c.summary}`);
    }
  }
  lines.push(
    '',
    'Legacy one-shot pipeline run (needs an explicit mode; a bare --mode uses RUN_MODE from .env):',
    `  --mode=${[...VALID_MODES].join(' | ')}      --report`,
    '',
    'No CLI command submits an application. New machine? Start with: npm run setup, then npm run doctor',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Options that always take a value, so `--port 4747` means the same as
 * `--port=4747`. Without this the space form became a flag plus a stray
 * positional, and the dashboard silently started on 4646 instead.
 */
const VALUE_OPTIONS = new Set(['port', 'mode']);

/** Parse `--key=value` / `--key value` (VALUE_OPTIONS) / `--flag` / positional args into an object. */
export function parseArgs(argv = []) {
  const out = { flags: new Set(), options: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) out.options[body.slice(0, eq)] = body.slice(eq + 1);
      else if (VALUE_OPTIONS.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out.options[body] = argv[i + 1];
        i += 1;
      } else out.flags.add(body);
    } else {
      out.positionals.push(arg);
    }
  }
  return out;
}

/**
 * Resolve the effective run mode from CLI + env (legacy mode path).
 *
 * An unrecognized value is an ERROR, not DRY_RUN: `--mode=PREPAER` used to
 * start a full live discovery under a mode nobody asked for. The removed
 * LIVE_SUBMIT is rejected the same way rather than silently downgraded.
 * Matching is case-insensitive, like RUN_MODE in getRuntimeSettings.
 *
 * @param {{options: object, flags: Set<string>}} parsed parseArgs() output
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string} DRY_RUN | PREPARE | LIVE_ASSIST | REPORT
 */
export function resolveMode({ options, flags }, env = process.env) {
  if (flags.has('report')) return 'REPORT';
  const fromFlag = options.mode !== undefined;
  const raw = fromFlag ? options.mode : (env.RUN_MODE ?? 'DRY_RUN');
  const requested = String(raw).trim().toUpperCase();
  if (VALID_MODES.has(requested)) return requested;
  const source = fromFlag ? `--mode=${raw}` : `RUN_MODE=${raw} (from the environment or .env)`;
  throw new Error(`unknown run mode ${source}. Use one of: ${[...VALID_MODES].join(', ')}.`);
}

/** True when argv explicitly asks for the legacy one-shot pipeline run. */
function wantsLegacyMode(parsed) {
  return parsed.flags.has('report') || parsed.flags.has('mode') || parsed.options.mode !== undefined;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  const command = parsed.positionals[0];

  // Answered before anything is loaded, so they work on a broken install.
  // `-h` is matched as a positional: parseArgs only understands `--` flags.
  if (parsed.flags.has('version')) {
    const version = packageVersion();
    process.stdout.write(`${version}\n`);
    return { command: 'version', version };
  }
  if (parsed.flags.has('help') || command === 'help' || command === '-h') {
    process.stdout.write(helpText());
    return { command: 'help' };
  }

  // `app` is the canonical one-command startup. Like doctor, it must not
  // assume config is healthy — it translates setup problems into a friendly
  // first-run checklist instead of a stack trace.
  if (command === 'app') {
    const { runApp } = await import('./cli/app.js');
    return runApp({ parsed, env });
  }

  // doctor/preflight must not assume config or the DB are healthy — they are
  // the tools that diagnose those — so they bypass the normal command setup.
  if (command === 'profiles') {
    const { runProfiles } = await import('./cli/profiles.js');
    const result = await runProfiles({ parsed, env });
    process.exitCode = result.ok ? 0 : 1;
    return result;
  }

  if (command && STANDALONE_COMMANDS.has(command)) {
    const result = await runDoctor({ env });
    if (parsed.flags.has('json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printDoctorReport(result);
    }
    process.exitCode = result.ok ? 0 : 1;
    return { command: 'doctor', ...result };
  }

  if (command && COMMANDS.has(command)) {
    return runCommand(command, parsed, env);
  }

  // A positional that isn't a known command is almost certainly a typo. Never
  // silently fall through to a full legacy pipeline run — fail with guidance.
  if (command) {
    const known = COMMAND_TABLE.filter((c) => !c.hidden).map((c) => c.name).sort().join(', ');
    throw new Error(`unknown command "${command}". Known commands: ${known}. `
      + 'Run "node src/index.js help" for what each one does.');
  }

  // A BARE INVOCATION PRINTS HELP. It used to fall into the legacy path and
  // start a live DRY_RUN discovery across every enabled source — paid Apify
  // actors included — which is the most expensive thing this tool does, set off
  // by typing its name to find out what it does. The legacy path needs an
  // explicit `--mode`/`--report` now.
  if (!wantsLegacyMode(parsed)) {
    process.stdout.write(helpText());
    return { command: 'help' };
  }
  return runLegacyMode(parsed, env);
}

/** Dispatch a phase command. */
async function runCommand(command, parsed, env) {
  const config = loadConfig({ env });
  const runId = randomUUID();
  const { logger: pino } = createPinoLogger({ runId, level: env.LOG_LEVEL ?? 'info' });
  const db = openDatabase({});
  const logger = new JobLogger({ db, logger: pino, runId });
  const arg = parsed.positionals[1];
  // Cross-process exclusion with the dashboard and other CLI runs (src/utils/runLock.js).
  const runLock = CLI_LOCKED_COMMANDS.has(command) ? acquireRunLock({ root: config.root, owner: 'cli', phase: command }) : null;

  try {
    switch (command) {
      case 'go':
      case 'start': {
        // Quick preflight: stop gracefully (with the exact gaps) before doing
        // any work if required candidate data or the master resume is missing.
        const gate = quickPreflight(config);
        if (!gate.ok) {
          ui.heading('Cannot start — preflight failed');
          for (const problem of gate.problems) ui.fail(problem);
          ui.blank();
          ui.next([{ text: 'See the full checklist:', cmd: 'npm run doctor' }]);
          process.exitCode = 1;
          return { command, preflight: gate };
        }
        const options = {
          yes: parsed.flags.has('yes') || parsed.flags.has('y'),
          assist: !parsed.flags.has('no-assist'),
          prepareOnly: parsed.flags.has('prepare-only') || parsed.flags.has('prepareOnly'),
        };
        const r = await runGuided({ config, db, logger, options });
        return { command, ...r };
      }
      case 'dashboard':
      case 'ui': {
        // SETUP GAPS WARN; THEY DO NOT LOCK THE DOOR.
        //
        // This refused to start while `npm run app` — the other launcher for
        // the same dashboard — started with warnings, so whether an incomplete
        // profile was recoverable depended on which command the user happened
        // to type. Refusing was also the less helpful half of that pair: the
        // dashboard is WHERE a user fixes a profile, so a gate on it sent them
        // back to hand-editing JSON to earn the right to use the editor.
        //
        // Nothing unsafe is unlocked by starting. Preparation is gated
        // independently and unconditionally inside `preparePacket` — on
        // placeholder profile values and on a resume that belongs to somebody
        // else — so a workspace with gaps can be inspected and repaired but
        // cannot produce a document.
        const gate = quickPreflight(config);
        if (!gate.ok) {
          ui.warn('Setup gaps found (the dashboard will start, but fix these before preparing applications):');
          for (const problem of gate.problems) ui.note(`  • ${problem}`);
          ui.blank();
          ui.next([{ text: 'See the full checklist:', cmd: 'npm run doctor' }]);
        }
        const { startDashboard, installProcessSafetyNet } = await import('./dashboard/server.js');
        const port = parseDashboardPort(parsed.options.port ?? env.DASHBOARD_PORT, 4646);
        // One dashboard per install: two servers cache config and the database
        // separately, so a profile switch in one leaves the other serving the
        // previous person's jobs against the new person's files (BUG-03).
        const { readLiveLock, writeLock } = await import('./dashboard/instanceLock.js');
        const holder = readLiveLock(config.root);
        if (holder) {
          ui.warn(`JobAgent is already running for this folder at http://127.0.0.1:${holder.port} (process ${holder.pid}).`);
          ui.note('Use that one, or stop it (Ctrl+C in its window) before starting another.');
          return { command, ok: false, alreadyRunning: true, port: holder.port };
        }
        const dash = await startDashboard({ config, db, logger, port });
        const releaseLock = writeLock(config.root, { port: dash.port ?? port });
        let uninstallSafetyNet = () => {};
        let onSignal = null;
        let bodyError = null;
        try {
          // The dashboard runs browser automation in the background and leaves
          // a real browser open for review. Keep background errors visible
          // without allowing them to kill the local cockpit.
          uninstallSafetyNet = installProcessSafetyNet({ runState: dash.runState, logger });
          ui.heading('JobAgent Dashboard');
          ui.success(`Running at ${ui.c.bold(dash.url)}  (local-only, never exposed)`);
          if (dash.apiToken) ui.note(`Open this link to unlock it in your browser: ${dash.unlockUrl}`);
          ui.note('Discover, score, review, approve, and auto-apply from the browser.');
          ui.note('By default it stops before Submit; auto-submit only runs when you explicitly opt in per run.');
          ui.blank();
          ui.note('Press Ctrl+C to stop.');
          // Keep the process alive until the user stops it. Both listeners are
          // removed below, including the signal that did not fire.
          await new Promise((resolve) => {
            onSignal = resolve;
            process.once('SIGINT', onSignal);
            process.once('SIGTERM', onSignal);
          });
        } catch (err) {
          bodyError = err;
          throw err;
        } finally {
          if (onSignal) {
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
          }
          let cleanupError = null;
          try { await dash.close(); } catch (err) { cleanupError ??= err; }
          try { uninstallSafetyNet(); } catch (err) { cleanupError ??= err; }
          try { releaseLock(); } catch { /* a stale lock is ignored once its pid is gone */ }
          // eslint-disable-next-line no-unsafe-finally -- deliberate: only when the body succeeded
          if (!bodyError && cleanupError) throw cleanupError;
        }
        return { command, url: dash.url, stopped: true };
      }
      case 'discover': {
        ui.heading('Discover');
        const sel = withSourceSelection(config, selectionFromArgs(parsed));
        if (sel.unmatched.length) {
          ui.warn?.(`No source matches: ${sel.unmatched.join(', ')} — check --source= against config/jobboards.json ids or adapters.`);
        }
        ui.step(sel.selected.length && sel.selected.length < (config.jobboards?.sources?.length ?? 0)
          ? `Searching ${sel.selected.length} selected source(s): ${sel.selected.join(', ')}…`
          : 'Searching enabled job boards for matching roles…');
        const r = await runDiscover({ config: sel.config, logger });
        pino.info({ counters: r.counters, file: r.found }, `Discover: found ${r.counters.jobs_found} jobs`);
        summarizeDiscover(r, config);
        return { command, ...r };
      }
      case 'score': {
        ui.heading('Score');
        const sel = withSourceSelection(config, selectionFromArgs(parsed));
        if (sel.unmatched.length) {
          ui.warn?.(`No source matches: ${sel.unmatched.join(', ')} — check --source= against config/jobboards.json ids or adapters.`);
        }
        ui.step(sel.selected.length && sel.selected.length < (config.jobboards?.sources?.length ?? 0)
          ? `Discovering from ${sel.selected.length} selected source(s) and scoring against your profile…`
          : 'Scoring discovered jobs against your profile and sponsorship needs…');
        logger.startRun('DRY_RUN');
        const r = await runScore({ config: sel.config, db, logger });
        pino.info({ counters: r.counters }, `Score: ${r.counters.jobs_scored} scored, ${r.counters.jobs_queued} queued`);
        summarizeScore(r, config);
        return { command, ...r };
      }
      case 'prepare-apps': {
        ui.heading('Prepare Applications');
        ui.step('Tailoring resumes and building application packets for strong matches…');
        logger.startRun('PREPARE');
        const r = await runPrepareApps({ config, db, logger });
        pino.info({ counters: r.counters }, `Prepare: ${r.counters.jobs_prepared} packets enqueued for approval`);
        summarizePrepare(r, db, config);
        return { command, ...r };
      }
      case 'assist': {
        ui.heading('Assist');
        ui.step('Opening a browser to fill approved applications — stops before submit…');
        logger.startRun('LIVE_ASSIST');
        const r = await runAssist({ config, db, logger, mode: 'LIVE_ASSIST' });
        pino.info({ counters: r.counters }, `Assist: ${r.counters.jobs_assisted} assisted, ${r.counters.jobs_submitted} submitted`);
        summarizeAssist(r, db);
        return { command, ...r };
      }
      case 'apply': {
        logger.startRun('LIVE_ASSIST');
        const options = { all: parsed.flags.has('all') };
        const r = await runApply({ config, db, logger, options });
        return { command, ...r };
      }
      case 'watch': {
        const options = {
          intervalMinutes: Number(parsed.options.interval ?? env.WATCH_INTERVAL_MINUTES ?? 20),
          freeOnly: parsed.flags.has('free-only') || parsed.flags.has('freeOnly'),
          once: parsed.flags.has('once'),
          freshAlertMinutes: Number(parsed.options['fresh-alert'] ?? env.WATCH_FRESH_ALERT_MINUTES ?? 60),
          maxConsecutiveFailures: Number(parsed.options['max-failures'] ?? env.WATCH_MAX_FAILURES ?? 5),
          notify: parsed.flags.has('notify') || ['1', 'true', 'yes', 'on'].includes(String(env.WATCH_NOTIFY ?? '').trim().toLowerCase()),
        };
        logger.startRun('PREPARE');
        // First Ctrl+C: stop at the next safe point. Second: exit 130 now.
        const stopSignal = createWatchStopSignal({
          onFirst: () => ui.note('Stopping after the current step… press Ctrl+C again to quit immediately.'),
        });
        try {
          const r = await runWatch({ config, db, logger, options, deps: { shouldStop: stopSignal.shouldStop } });
          if (r.failed) process.exitCode = 1;
          return { command, ...r };
        } finally {
          stopSignal.dispose();
        }
      }
      case 'rescore': {
        ui.heading('Rescore');
        const r = await runRescore({ config, db, logger });
        return { command, ...r };
      }
      case 'live-submit': {
        ui.heading('Live Submit');
        ui.warn('live-submit has been removed. This assistant never auto-submits.');
        ui.note('Use "npm run assist" to fill an approved application; review it, then click Submit yourself.');
        return { command, removed: true };
      }
      case 'end-to-end': {
        ui.heading('End-to-End');
        ui.step('Discover → score → prepare → assist (always stops before submit)…');
        logger.startRun('LIVE_ASSIST');
        const r = await runEndToEnd({ config, db, logger });
        pino.info({ prepared: r.prepared, assisted: r.assisted }, 'End-to-end complete (stopped before submit)');
        ui.blank();
        ui.stats([
          ['Prepared', r.prepared ?? 0, 'good'],
          ['Assisted', r.assisted ?? 0],
        ]);
        ui.blank();
        ui.next([
          { text: 'Review the queue:', cmd: 'npm run approvals' },
          { text: 'Approve one:     ', cmd: 'npm run approve -- <id>' },
        ]);
        return { command, ...r };
      }
      case 'approvals': {
        ui.heading('Approval Queue');
        const rows = listApprovalQueue(db, { all: parsed.flags.has('all') });
        summarizeApprovals(rows, db);
        return { command, approvals: rows };
      }
      case 'approve': {
        if (!arg) throw new Error('usage: approve <approvalId>  (get the id from "npm run approvals")');
        const r = approvePacket(db, arg);
        pino.info(r, `Approved ${arg}`);
        ui.heading('Approve');
        ui.success(`Approved packet ${ui.c.bold(shortId(arg))} — marked ready for assisted apply.`);
        ui.blank();
        ui.next([{ text: 'Fill it in a browser (stops before submit):', cmd: 'npm run assist' }]);
        return { command, ...r };
      }
      case 'reject': {
        if (!arg) throw new Error('usage: reject <approvalId>  (get the id from "npm run approvals")');
        const r = rejectPacket(db, arg);
        pino.info(r, `Rejected ${arg}`);
        ui.heading('Reject');
        ui.success(`Rejected packet ${ui.c.bold(shortId(arg))} — it will be skipped during assist.`);
        return { command, ...r };
      }
      case 'packets': {
        ui.heading('Prepared Packets');
        const rows = listPackets(db);
        if (!rows.length) {
          ui.note('No packets prepared yet. Run "npm run prepare-apps" first.');
        } else {
          ui.table(rows.map((p) => ({
            id: shortId(p.approvalId), company: truncate(p.company, 24), role: truncate(p.title, 40),
            score: p.score, tier: p.tier, status: p.status, blockers: p.blockers.length,
          })));
        }
        return { command, packets: rows };
      }
      case 'packet': {
        if (!arg) throw new Error('usage: packet <jobId|packetId>');
        const found = getPacket(db, arg);
        if (!found) {
          ui.heading('Packet');
          ui.warn(`No packet found for "${arg}".`);
          return { command, packet: null };
        }
        pino.info(found.packet, `Packet for ${found.packet?.job?.company ?? arg}`);
        summarizePacket(found.packet, config);
        return { command, ...found };
      }
      case 'report': {
        ui.heading('Report');
        // The report answers "how is MY search going", so it reads the
        // personalized rows only. Blending in an ad-hoc role search would put
        // roles the user never targeted into their own fit statistics.
        const jobs = db.listJobs({ mode: 'profile' });
        const report = generateReport({ jobs, outDir: join(config.root, 'reports') });
        pino.info({ files: report.files }, `Report regenerated for ${jobs.length} jobs`);
        ui.success(`Regenerated report for ${ui.c.bold(jobs.length)} jobs.`);
        ui.blank();
        ui.files([
          rel(config.root, report.files.csv),
          rel(config.root, report.files.html),
          rel(config.root, report.files.json),
        ]);
        return { command, report };
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } finally {
    runLock?.release();
    db.close();
    // The PDF printer shares one browser across a batch; never leave it running.
    await closeSharedPdfBrowser();
  }
}

async function closeSharedPdfBrowser() {
  try { const { closePdfBrowsers } = await import('./resume/chromiumPdf.js'); await closePdfBrowsers(); } catch { /* nothing to close */ }
}

/** Legacy `--mode=` / `--report` behavior. */
async function runLegacyMode(parsed, env) {
  // A bad explicit --mode is reported as the typo it is, before any config
  // problem that happens to exist can mask it.
  if (parsed.options.mode !== undefined) resolveMode(parsed, env);
  // loadConfig loads .env into process.env — only AFTER it can a bare `--mode`
  // see the RUN_MODE the user put there.
  const config = loadConfig({ env });
  const mode = resolveMode(parsed, env);
  const runId = randomUUID();
  const { logger: pino } = createPinoLogger({ runId, level: env.LOG_LEVEL ?? 'info' });
  const db = openDatabase({});
  const logger = new JobLogger({ db, logger: pino, runId });

  try {
    if (mode === 'REPORT') {
      const jobs = db.listJobs({ mode: 'profile' });
      const report = generateReport({ jobs, outDir: join(config.root, 'reports') });
      pino.info({ files: report.files }, `Report regenerated for ${jobs.length} jobs`);
      return { mode, report };
    }

    // Guardrail: LIVE_ASSIST never submits — it fills and stops for the human.
    if (mode === 'LIVE_ASSIST') {
      ui.note('LIVE_ASSIST fills approved applications and stops before submit — you review and click Submit.');
    }

    logger.startRun(mode);
    const result = await runPipeline({ config, db, logger, mode });

    pino.info({ counters: result.counters, files: result.report.files },
      `Done (${mode}). Found ${result.counters.jobs_found}, scored ${result.counters.jobs_scored}, ` +
      `prepared ${result.counters.jobs_prepared}, discarded ${result.counters.jobs_discarded}.`);

    ui.heading(`Run complete — ${mode}`);
    ui.blank();
    ui.stats([
      ['Found', result.counters.jobs_found],
      ['Scored', result.counters.jobs_scored],
      ['Prepared', result.counters.jobs_prepared, 'good'],
      ['Discarded', result.counters.jobs_discarded, 'muted'],
    ]);
    ui.blank();
    ui.files([
      rel(config.root, result.report.files.csv),
      rel(config.root, result.report.files.html),
    ]);
    return { mode, ...result };
  } finally {
    db.close();
    await closeSharedPdfBrowser();
  }
}

/**
 * Minimal hard-requirement gate for the guided run: required candidate fields
 * and the master resume. Everything else degrades gracefully mid-run, but
 * these two would produce packets with fabricated/missing data — never start.
 * @param {object} config loadConfig() bundle
 * @returns {{ ok: boolean, problems: string[] }}
 */
export { quickPreflight };

/**
 * `rescore` — re-score stored jobs whose score is stale for the current
 * profile/scoring config, via `rescoreStale` from src/pipeline/index.js.
 *
 * The export is looked up at call time, not imported statically: a static
 * import of a missing named export is a SyntaxError that would take down EVERY
 * command, where this degrades to one clear message for the one command that
 * needs it.
 *
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.db
 * @param {object} args.logger
 * @param {() => Promise<object>} [args.importPipeline] module loader (tests)
 * @returns {Promise<{ok: boolean, [k: string]: any}>}
 */
export async function runRescore({ config, db, logger, importPipeline = () => import('./pipeline/index.js') }) {
  const pipeline = await importPipeline();
  if (typeof pipeline.rescoreStale !== 'function') {
    ui.fail('This build has no rescoreStale() in src/pipeline/index.js, so there is nothing to run.');
    ui.note('Update Job Agent (git pull && npm ci) — or run "npm run score" for a full re-score.');
    process.exitCode = 1;
    return { ok: false, reason: 'rescoreStale export missing' };
  }
  ui.step('Re-scoring stored jobs against the current profile and scoring config…');
  const result = (await pipeline.rescoreStale({ config, db, logger })) ?? {};
  // Show whatever counts the implementation reports, without depending on
  // its exact field names.
  const source = result.counters && typeof result.counters === 'object' ? result.counters : result;
  const rows = Object.entries(source).filter(([, v]) => typeof v === 'number');
  ui.blank();
  if (rows.length) ui.stats(rows);
  else ui.success('Rescore finished.');
  return { ok: true, ...result };
}

/* ────────────────────────── console summaries ────────────────────────── */

/** Group discovered rows by their source label and return [{source, count}]. */
function countBySource(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = row.source || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, count]) => ({ source, count }));
}

function summarizeDiscover(r, config) {
  ui.blank();
  ui.stats([
    ['Found', r.counters.jobs_found, r.counters.jobs_found ? 'good' : 'muted'],
    ['Errors', r.errors?.length ?? 0, r.errors?.length ? 'bad' : 'good'],
  ]);
  ui.blank();
  const bySource = countBySource(r.jobs ?? []);
  ui.list('By source', bySource.map((s) => `${s.source}  ${ui.c.dim(`${s.count} jobs`)}`));
  ui.blank();
  ui.files([rel(config.root, r.found)]);
  if (r.errors?.length) {
    ui.blank();
    ui.warn(`${r.errors.length} source error(s) — see the log file for details.`);
  }
  ui.blank();
  ui.next([{ text: 'Score these jobs:', cmd: 'npm run score' }]);
}

function summarizeScore(r, config) {
  ui.blank();
  ui.stats([
    ['Found', r.counters.jobs_found],
    ['Scored', r.counters.jobs_scored],
    ['Queued', r.counters.jobs_queued, r.counters.jobs_queued ? 'good' : 'muted'],
    ['Discarded', r.counters.jobs_discarded, 'muted'],
  ]);
  ui.blank();
  const top = (r.scoredJobs ?? [])
    .filter((j) => j.tier && j.tier !== 'Discard')
    .slice(0, 5);
  if (top.length) {
    ui.list('Top matches', top.map((j) =>
      `${ui.c.bold(String(j.score).padStart(3))}  ${ui.c.cyan(String(j.tier).padEnd(8))} ${jobLabel(j)}  ${ui.c.dim(postedLabel(j))}`));
  } else {
    ui.note('No jobs cleared the queue threshold this run.');
  }
  ui.blank();
  ui.files([
    rel(config.root, r.artifacts?.scored),
    rel(config.root, r.artifacts?.queued),
    rel(config.root, r.report?.files?.csv),
  ]);
  ui.blank();
  ui.next([
    { text: 'Build tailored packets:', cmd: 'npm run prepare-apps' },
    { text: 'Refresh the Excel tracker:', cmd: 'npm run tracker' },
  ]);
}

function summarizePrepare(r, db, _config) {
  ui.blank();
  ui.stats([
    ['Queued', r.counters.jobs_queued],
    ['Packets prepared', r.counters.jobs_prepared, r.counters.jobs_prepared ? 'good' : 'muted'],
  ]);
  ui.blank();
  const prepared = (r.scoredJobs ?? []).filter((j) => j.status === 'prepared');
  if (prepared.length) {
    ui.list('Awaiting your approval', prepared.map((j) => {
      const row = db?.getJob?.(j.id);
      const ats = atsLabel(row);
      return `${jobLabel(j)}  ${ui.c.dim(postedLabel(j))}${ats ? `  ${ats}` : ''}`;
    }));
    ui.blank();
    ui.note('ATS = estimated keyword match for that posting (target band ~70-85%). '
      + 'Open a packet to see required terms you are missing:  npm run packet -- <id>');
  } else {
    ui.note('No new packets were prepared (nothing reached the prepare threshold).');
  }
  ui.blank();
  if (prepared.length) {
    ui.next([
      { text: 'See ids:  ', cmd: 'npm run approvals' },
      { text: 'Approve:  ', cmd: 'npm run approve -- <id>' },
      { text: 'Fill it:  ', cmd: 'npm run assist' },
    ]);
  } else {
    ui.next([{ text: 'Discover more jobs:', cmd: 'npm run discover' }]);
  }
}

function summarizeAssist(r, _db) {
  // Count what actually happened: skipped approvals never increment
  // jobs_assisted, so subtracting them (the old approach) could go negative.
  const ready = (r.results ?? []).filter((x) => x.status === 'ready_for_submit').length;
  ui.blank();
  ui.stats([
    ['Assisted', r.counters.jobs_assisted, r.counters.jobs_assisted ? 'good' : 'muted'],
    ['Ready to submit', ready, ready ? 'good' : 'muted'],
  ]);
  ui.blank();
  if (!r.counters.jobs_assisted) {
    ui.note('Nothing to assist — no packets are approved yet.');
    ui.blank();
    ui.next([
      { text: 'Prepare packets:', cmd: 'npm run prepare-apps' },
      { text: 'Then approve one:', cmd: 'npm run approve -- <id>' },
    ]);
    return;
  }
  for (const result of r.results ?? []) {
    const blockers = result.blockers?.length ?? 0;
    const label = blockers ? ui.c.yellow(`paused (${blockers} blocker${blockers === 1 ? '' : 's'})`)
      : ui.c.cyan(result.status ?? 'filled');
    ui.note(`  • ${label}`);
  }
  ui.blank();
  ui.note('Forms were filled but NOT submitted — review each browser tab and submit yourself.');
}

function summarizeApprovals(rows, db) {
  if (!rows.length) {
    ui.note('Queue is empty. Run "npm run prepare-apps" to build packets.');
    return;
  }
  ui.note('Copy a full id below into:  npm run approve -- <id>');
  ui.blank();
  ui.table(rows.map((a) => {
    const job = db?.getJob?.(a.job_id);
    const who = job ? `${job.company ?? '—'} — ${job.title ?? '—'}` : a.job_id;
    return { id: a.id, status: a.approval_status, job: truncate(who, 50) };
  }));
}

/** Trim a string to a max length with an ellipsis. */
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function summarizePacket(packet, config) {
  if (!packet) return;
  const job = packet.job ?? {};
  ui.blank();
  ui.stats([
    ['Company', job.company ?? '—'],
    ['Role', job.title ?? '—'],
    ['Score', job.score ?? packet.score ?? '—'],
    ['Tier', job.tier ?? packet.tier ?? '—'],
  ]);
  ui.blank();
  ui.files([
    rel(config.root, packet.resumePath),
    rel(config.root, packet.coverLetterPath),
  ].filter(Boolean));
}

// Run only when invoked directly.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    ui.fail(err.message);
    process.exitCode = 1;
  });
}
