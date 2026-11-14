// @ts-check
/**
 * `npm run app` — the ONE canonical way to start Job Agent.
 *
 * Everything the launchers (start-job-agent.cmd / Start-JobAgent.ps1 /
 * start-job-agent.sh) do funnels through here, so behavior is identical on
 * every platform:
 *
 *   1. Validate configuration — friendly, actionable errors, never a stack
 *      trace for a predictable setup problem.
 *   2. Open/migrate the local SQLite database (schema + indexes apply
 *      idempotently on open).
 *   3. Pick a port. If a Job Agent dashboard already answers on the requested
 *      one, open THAT and exit 0 — a second double-click must not start a
 *      second server on the same database. Only when the port is busy with
 *      something else is the next free port used (never EADDRINUSE).
 *   4. Start the dashboard bound to 127.0.0.1 and wait until it answers HTTP.
 *   5. Open the user's default browser at the dashboard URL.
 *   6. Shut down cleanly on Ctrl+C (server closed, database checkpointed).
 *
 * Setup gaps (missing candidate profile fields, no master resume) are shown as
 * a first-run checklist. Hard gaps (config file missing/invalid) stop with
 * instructions; soft gaps warn and the dashboard still starts so the user can
 * see system health in the UI.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { ui } from './ui.js';
import { quickPreflight } from './preflight.js';
import { masterResumeFile } from '../profile/workspace.js';
import { instanceProof, readToken, TOKEN_HEADER, tokensMatch, unlockUrl } from '../dashboard/apiToken.js';
import { readLiveLock, writeLock } from '../dashboard/instanceLock.js';

/** Parse and validate a user-facing dashboard port. */
export function parseDashboardPort(value, fallback = 4646) {
  const raw = value ?? fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid dashboard port "${raw}" — use a whole number from 1 to 65535`);
  }
  return port;
}

/** Probe one port on 127.0.0.1; resolves true when it is free. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * First free port at or after `start` (bounded scan so a pathological host
 * fails fast with a clear message instead of hanging).
 * @param {number} start
 * @param {number} [tries=20]
 * @returns {Promise<number>}
 */
export async function findFreePort(start, tries = 20) {
  for (let p = start; p < start + tries; p += 1) {
    if (await portIsFree(p)) return p;
  }
  throw new Error(`no free port found in ${start}-${start + tries - 1} — close other apps or set DASHBOARD_PORT`);
}

/**
 * Is a Job Agent dashboard already answering on this port?
 *
 * The launchers are double-clicked, and a second double-click used to start a
 * SECOND dashboard on 4647 against the same database — two servers, two run
 * locks, one SQLite file. Asking the busy port first turns that into "it's
 * already running, here it is".
 *
 * Identified by the shape of GET /api/run/status (the run-state object), not
 * merely by a 200: some other local app answering on 4646 must not be mistaken
 * for us, or the user would be sent to the wrong page and no dashboard started.
 *
 * @param {number} port
 * @param {object} [options]
 * @param {number} [options.timeoutMs=1000] a JobAgent answers this instantly
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|null} [options.token] the dashboard's access token, when known
 * @returns {Promise<string|null>} the dashboard URL, or null
 */
export async function probeRunningDashboard(port, options = {}) {
  const found = await identifyRunningDashboard(port, options);
  return found?.url ?? null;
}

/**
 * Who is listening on the dashboard port?
 *
 * The access token is sent ONLY to a server that first proves it holds the
 * token (instanceProof over a fresh random challenge). Sending it to whatever
 * answered /api/run/status with the right JSON shape handed it to any program
 * that bound the port first, and the launcher then opened /?token=… there.
 *
 * @param {number} port
 * @param {object} [options]
 * @param {number} [options.timeoutMs=1000]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|null} [options.token] this install's access token, when known
 * @returns {Promise<{url: string, proven: boolean}|null>} `proven` is true only
 *   when the server answered the challenge with this install's token
 */
export async function identifyRunningDashboard(port, { timeoutMs = 1000, fetchImpl = fetch, token = null } = {}) {
  const url = `http://127.0.0.1:${port}`;
  const get = (path, headers = {}) => fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers });
  const statusShape = (body) => body && typeof body === 'object'
    && typeof body.running === 'boolean' && 'phase' in body && 'cancelRequested' in body;
  try {
    if (token) {
      const challenge = randomBytes(32).toString('hex');
      let proven = false;
      try {
        const res = await get(`/api/instance?challenge=${challenge}`);
        if (res.ok) {
          /** @type {any} */
          const body = await res.json();
          proven = body?.app === 'job-agent' && typeof body.proof === 'string'
            && tokensMatch(body.proof, instanceProof(token, challenge));
        }
      } catch { proven = false; }
      if (proven) {
        const res = await get('/api/run/status', { [TOKEN_HEADER]: token });
        if (!res.ok) return null;
        return statusShape(await res.json()) ? { url, proven: true } : null;
      }
      // Not proven: never send the token. An older JobAgent (no /api/instance)
      // answers a token-less status request with its "locked" message.
      const res = await get('/api/run/status');
      if (res.status === 401) {
        /** @type {any} */
        const body = await res.json().catch(() => null);
        return /^locked\b/.test(String(body?.error ?? '')) ? { url, proven: false } : null;
      }
      if (!res.ok) return null;
      return statusShape(await res.json()) ? { url, proven: false } : null;
    }
    // No token on this install (auth off): the status shape is all there is.
    const res = await get('/api/run/status');
    if (!res.ok) return null;
    /** @type {any} */
    const body = await res.json();
    return statusShape(body) ? { url, proven: true } : null;
  } catch {
    // Refused, timed out, not JSON: nothing of ours is there.
    return null;
  }
}

/** Wait until the dashboard answers HTTP (it should immediately; be sure). */
async function waitForReady(url, { timeoutMs = 10_000, fetchImpl = fetch, token = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${url}/api/run/status`, { headers: token ? { [TOKEN_HEADER]: token } : {} });
      if (res.ok) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`dashboard did not become ready at ${url}: ${lastErr?.message ?? 'timeout'}`);
}

/**
 * Open `url` in the platform default browser. Best-effort — a failure is
 * reported but never blocks startup (the URL is printed either way).
 */
export function openBrowser(url, {
  platform = process.platform, spawnImpl = spawn, onError = () => {},
} = {}) {
  try {
    let child;
    if (platform === 'win32') {
      // `start` is a cmd built-in; the empty "" is the window title slot.
      child = spawnImpl('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    } else if (platform === 'darwin') {
      child = spawnImpl('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawnImpl('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    // spawn() reports missing executables asynchronously. Always consume that
    // event so a best-effort browser launch can never crash the dashboard.
    child?.once?.('error', onError);
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for either shutdown signal and provide deterministic listener cleanup.
 * The signal that did not fire must not remain registered (important in tests,
 * embedded callers, and failed/restarted launches).
 */
export function createShutdownSignalWait(proc = process) {
  let resolveSignal;
  const promise = new Promise((resolve) => { resolveSignal = resolve; });
  const onSignal = (signal) => resolveSignal(signal);
  proc.once('SIGINT', onSignal);
  proc.once('SIGTERM', onSignal);
  return {
    promise,
    dispose() {
      proc.off?.('SIGINT', onSignal);
      proc.off?.('SIGTERM', onSignal);
    },
  };
}

/**
 * Translate a config-load failure into a first-run checklist instead of a
 * stack trace. Returns lines to print, or null when the error is not a
 * recognizable setup problem (caller rethrows those).
 * @param {Error} err
 * @param {string} [_root] project root (unused; kept for callers)
 * @returns {string[]|null}
 */
export function explainConfigError(err, _root) {
  const msg = String(err?.message ?? err);
  const lines = [];
  const missing = /ENOENT|no such file|not found/i.test(msg);
  // One command creates every seeded file (candidate, screening answers,
  // cover letter, example master resume) and never overwrites; it is the fix
  // for a missing one, rather than a copy command per file that misses the rest.
  const setupHint = 'Run:  npm run setup   (creates any missing personal config from the examples; never overwrites)';
  if (/candidate\.json/i.test(msg) && missing) {
    lines.push('Your candidate profile does not exist yet.');
    lines.push(setupHint);
    lines.push(`(or copy ${join('config', 'candidate.example.json')} -> ${join('config', 'candidate.json')})`);
    lines.push('Then fill in YOUR real details (name, contact, work authorization). Never invent anything.');
  } else if (/screening_answers\.json/i.test(msg) && missing) {
    lines.push('Your screening answers file does not exist yet.');
    lines.push(setupHint);
    lines.push(`(or copy ${join('config', 'screening_answers.example.json')} -> ${join('config', 'screening_answers.json')})`);
    lines.push('Fill it with YOUR truthful answers (sponsorship, authorization, notice period).');
  } else if (/cover_letter\.json/i.test(msg) && missing) {
    lines.push('Your cover-letter settings file does not exist yet.');
    lines.push(setupHint);
    lines.push('Then set YOUR years of experience and work-authorization sentence in config/cover_letter.json.');
  } else if (/schema|validation|invalid/i.test(msg)) {
    lines.push('A configuration file failed validation:');
    lines.push(msg);
    lines.push('Fix the field(s) above, then run "npm run app" again. "npm run doctor" shows the full checklist.');
  } else if (/ENOENT|no such file/i.test(msg)) {
    lines.push(`A required file is missing: ${msg}`);
    lines.push('Run "npm run doctor" for the full setup checklist.');
  } else {
    return null;
  }
  return lines;
}

/**
 * Run the app: validate -> migrate -> free port -> serve -> open browser ->
 * clean shutdown. All effects injectable for tests.
 *
 * @param {object} args
 * @param {object} args.parsed parseArgs() output
 * @param {object} args.env process env
 * @param {object} [args.deps] injection points (tests)
 * @returns {Promise<object>} { ok, url?, port?, problems? }
 */
export async function runApp({ parsed, env, deps = {} }) {
  const loadConfigImpl = deps.loadConfig ?? (await import('../config/loadConfig.js')).loadConfig;
  const openDatabaseImpl = deps.openDatabase ?? (await import('../logging/db.js')).openDatabase;

  ui.heading('Job Agent');

  // 1. Configuration — friendly failures.
  let config;
  try {
    config = loadConfigImpl({ env });
  } catch (err) {
    const friendly = explainConfigError(err, process.cwd());
    if (!friendly) throw err;
    ui.fail('Setup is not complete yet:');
    for (const line of friendly) ui.note(`  ${line}`);
    process.exitCode = 1;
    return { ok: false, problems: friendly };
  }

  // Soft setup gaps: warn (with exact fixes) but still start — the dashboard
  // is where the user can see health and act. Preparing applications will be
  // limited until they are fixed.
  const gate = quickPreflight(config);
  if (!gate.ok) {
    ui.warn('Setup gaps found (the dashboard will start, but fix these before preparing applications):');
    for (const p of gate.problems) ui.note(`  • ${p}`);
    ui.blank();
  }
  const master = masterResumeFile(config.root);
  const firstRun = !existsSync(master);

  let requestedPort;
  try {
    requestedPort = parseDashboardPort(parsed.options.port ?? env.DASHBOARD_PORT, 4646);
  } catch (err) {
    ui.fail(err.message);
    process.exitCode = 1;
    return { ok: false, problems: [err.message] };
  }

  const noOpen = parsed.flags.has('no-open') || env.APP_NO_OPEN === 'true';

  // Already running? Reuse it instead of starting a second server on the next
  // port. Checked before the database is opened: a second instance must not
  // touch the store the first one is serving.
  const existingToken = readToken(config.root);
  const probe = (p) => (deps.probeRunningDashboard
    ? deps.probeRunningDashboard(p, { token: existingToken }).then((u) => (u ? { url: u, proven: true } : null))
    : identifyRunningDashboard(p, { token: existingToken }));
  // The workspace lock names the port a running dashboard ACTUALLY holds:
  // probing only the requested port missed one started on another port
  // (`npm run dashboard -- --port=4747`) and started a split-brain second.
  const holder = (deps.readLiveLock ?? readLiveLock)(config.root);
  let found = holder && holder.port !== requestedPort ? await probe(holder.port) : null;
  if (!found) found = await probe(requestedPort);
  const existingUrl = found?.url ?? null;
  if (existingUrl && !found.proven) {
    // Something that looks like JobAgent holds the port but could not prove it
    // is THIS install. Do not hand it the access key, and do not start a second
    // server against the same database either.
    ui.warn(`Something is already running at ${existingUrl} that could not prove it is your JobAgent, so your access key was not sent to it.`);
    ui.note('If it is an older JobAgent window, close it (Ctrl+C) and start again. Otherwise free the port or choose another with --port=NNNN.');
    return { ok: false, url: existingUrl, port: requestedPort, alreadyRunning: true, unproven: true, problems: ['dashboard port held by an unproven server'] };
  }
  if (existingUrl) {
    ui.success(`Job Agent is already running at ${ui.c.bold(existingUrl)}`);
    if (!noOpen) {
      const opened = (deps.openBrowser ?? openBrowser)(unlockUrl(existingUrl, existingToken), {
        onError: (err) => ui.warn(`Could not open the browser automatically: ${err.message}. Open ${existingUrl} yourself.`),
      });
      if (opened === false) ui.warn(`Could not open the browser automatically. Open ${existingUrl} yourself.`);
    }
    ui.note('Stop that one (Ctrl+C in its window) first if you meant to restart it.');
    return { ok: true, url: existingUrl, port: requestedPort, alreadyRunning: true };
  }

  const loggerModule = await import('../logging/jobLogger.js');
  const JobLoggerImpl = deps.JobLogger ?? loggerModule.JobLogger;
  const createPinoLoggerImpl = deps.createPinoLogger ?? loggerModule.createPinoLogger;
  const dashboardModule = await import('../dashboard/server.js');
  const startDashboardImpl = deps.startDashboard ?? dashboardModule.startDashboard;
  const installSafetyNetImpl = deps.installProcessSafetyNet ?? dashboardModule.installProcessSafetyNet;

  let db = null;
  let logger = null;
  let dash = null;
  let uninstallSafetyNet = null;
  let signalWait = null;
  let port;
  let reachedShutdown = false;
  let releaseLock = null;

  try {
    // 2. Database (opens + applies schema/index migrations idempotently).
    db = openDatabaseImpl({});
    const { logger: pino } = createPinoLoggerImpl({ toFile: true, level: env.LOG_LEVEL ?? 'info' });
    logger = new JobLoggerImpl({ db, logger: pino });

    // 3. Port.
    port = await (deps.findFreePort ?? findFreePort)(requestedPort);
    if (port !== requestedPort) {
      ui.note(`Port ${requestedPort} is busy — using ${port} instead.`);
    }

    // 4. Serve + readiness.
    dash = await startDashboardImpl({ config, db, logger, port });
    releaseLock = (deps.writeLock ?? writeLock)(config.root, { port: dash.port ?? port });
    uninstallSafetyNet = installSafetyNetImpl({ runState: dash.runState, logger });
    await (deps.waitForReady ?? waitForReady)(dash.url, { token: dash.apiToken });

    // 5. Browser. The unlock link carries the access token once; the server
    // swaps it for a cookie and redirects to the plain URL.
    if (!noOpen) {
      const opened = (deps.openBrowser ?? openBrowser)(dash.unlockUrl ?? dash.url, {
        onError: (err) => ui.warn(`Could not open the browser automatically: ${err.message}. Open ${dash.url} yourself.`),
      });
      if (opened === false) ui.warn(`Could not open the browser automatically. Open ${dash.url} yourself.`);
    }

    ui.success(`Dashboard running at ${ui.c.bold(dash.url)}  (local-only, never exposed)`);
    if (dash.apiToken) ui.note(`If the browser shows "JobAgent is locked", open: ${dash.unlockUrl}`);
    if (firstRun) {
      ui.warn('First run: place your resume at resumes/base/MASTER_RESUME.docx to enable tailoring.');
    }
    ui.note('Everything runs on your machine. Applications are only submitted when YOU click Submit');
    ui.note('(or explicitly opt in to auto-submit for a single run).');
    ui.blank();
    ui.note('Press Ctrl+C to stop.');

    // 6. Clean shutdown. In tests deps.shutdownSignal resolves immediately.
    signalWait = deps.shutdownSignal === undefined
      ? createShutdownSignalWait(deps.process ?? process)
      : { promise: Promise.resolve(deps.shutdownSignal), dispose() {} };
    await signalWait.promise;
    reachedShutdown = true;
  } finally {
    signalWait?.dispose?.();
    let cleanupError = null;
    if (dash) {
      try { await dash.close(); } catch (err) { cleanupError ??= err; }
    }
    try { uninstallSafetyNet?.(); } catch (err) { cleanupError ??= err; }
    try { releaseLock?.(); } catch { /* best effort: a stale lock is ignored once its pid is gone */ }
    if (db) {
      try { db.close(); } catch (err) { cleanupError ??= err; }
    }
    // Preserve the original startup/readiness error. If normal shutdown itself
    // failed, surface that cleanup error instead of claiming a clean stop.
    // eslint-disable-next-line no-unsafe-finally -- deliberate: only after a clean body
    if (reachedShutdown && cleanupError) throw cleanupError;
    if (!reachedShutdown && cleanupError) {
      try { logger?.error?.(`startup cleanup also failed: ${cleanupError.message}`); } catch { /* preserve startup error */ }
    }
  }

  ui.note('Stopped cleanly.');
  return { ok: true, url: dash.url, port: dash.port };
}
