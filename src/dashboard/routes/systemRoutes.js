/**
 * Data quality, description enrichment, settings, the posting sweep, system health and CSV exports.
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { writeUserSettings } from '../../config/userSettings.js';
import { writeJobTracker } from '../../reports/jobTracker.js';
import { sanitizeErrorMessage } from '../../utils/failureRca.js';
import { buildExportRows, exportRowsToCsv } from '../data.js';
import { dataQualitySummary, freshnessSummary } from '../dataQuality.js';
import { readFileSync } from 'node:fs';
import { readBody, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';
import { dirname, relative, sep } from 'node:path';
import { lastAutoBackupAt, listBackups } from '../../logging/backup.js';
import { buildIcs, openFollowUps } from '../../reports/calendar.js';
import { embedSettings } from '../../llm/embeddings.js';
import { readRerank, rerank } from '../../scoring/semanticRerank.js';
import { readUsage } from '../../llm/usage.js';
import { inboxSettings, pendingSuggestions } from '../../inbox/sync.js';

export async function handleSystemRoutes(ctx, req, res, { path }) {
  if (req.method === 'GET' && path === '/api/data-quality') {
    return sendJson(res, 200, dataQualitySummary(ctx.db, ctx.config, { now: ctx.nowDate(), enrichmentState: ctx.enrichmentStatus() }));
  }
  if (req.method === 'GET' && path === '/api/enrichment') {
    return sendJson(res, 200, ctx.enrichmentStatus());
  }
  if (req.method === 'POST' && path === '/api/enrichment/start') {
    await readBody(req);
    const out = ctx.startEnrichmentPass('manual');
    return sendJson(res, out.started ? 202 : 409, out.started ? ctx.enrichmentStatus() : { error: out.reason });
  }
  if (req.method === 'POST' && path === '/api/enrichment/stop') {
    await readBody(req);
    ctx.enrichment.controller?.abort();
    return sendJson(res, 200, ctx.enrichmentStatus());
  }
  if (req.method === 'POST' && path === '/api/settings') {
    const body = await readBody(req);
    if (!ctx.config?.root) return sendJson(res, 400, { error: 'settings need a project root' });
    const before = freshnessSummary(ctx.config);
    let settings;
    try {
      settings = writeUserSettings(ctx.config.root, body);
    } catch (err) {
      return sendJson(res, err.statusCode ?? 500, { error: sanitizeErrorMessage(err.message) });
    }
    const warning = ctx.reloadConfig();
    const after = freshnessSummary(ctx.config);
    // A new window or retention changes verdicts already on the board; the
    // same deferred re-judge a profile switch uses applies them.
    if (before.discoveryWindow !== after.discoveryWindow || before.retentionDays !== after.retentionDays) {
      ctx.scheduleRescore();
    }
    return sendJson(res, 200, { settings, warning, freshness: after, enrichment: ctx.enrichmentStatus() });
  }
  if (path === '/api/postings/sweep' && req.method === 'GET') {
    const { running, last, startedAt, finishedAt } = ctx.postingSweep;
    return sendJson(res, 200, { running, last, startedAt, finishedAt });
  }
  if (path === '/api/postings/sweep' && req.method === 'POST') {
    const body = await readBody(req);
    if (ctx.postingSweep.running) return sendJson(res, 409, { error: 'a posting check is already running' });
    if (ctx.runState.running) return sendJson(res, 409, { error: `a ${ctx.runState.phase} run is in progress — try again when it finishes` });
    const limit = Math.max(1, Math.min(2000, Number(body?.limit) || 300));
    // Re-check everything asked for, not just what is a day old.
    ctx.track(ctx.runPostingSweep({ limit, maxAgeHours: Number(body?.maxAgeHours ?? 1) }));
    return sendJson(res, 202, { started: true, limit });
  }
  if (req.method === 'GET' && path === '/api/health') {
    // Full doctor pass (config, resume, python, browsers, dirs) — the
    // Settings page's system-health panel. Doctor spawns Python etc., so it
    // runs on demand only, never on the landing path.
    return sendJson(res, 200, await ctx.healthReport());
  }
  if (req.method === 'GET' && path === '/api/export/jobs.csv') {
    const csv = exportRowsToCsv(buildExportRows(ctx.db, { now: ctx.nowDate() }));
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="jobagent_jobs.csv"',
    });
    res.end(csv);
    return;
  }
  if (req.method === 'GET' && path === '/api/export/tracker.csv') {
    const root = ctx.config?.root;
    if (!root) return sendJson(res, 400, { error: 'no project root configured for export' });
    // Explicit download: flush any pending debounced write, then rewrite
    // synchronously so the bytes the user gets are never stale.
    ctx.flushTracker();
    const writeImpl = ctx.deps.writeJobTrackerImpl ?? writeJobTracker;
    const { path: csvPath } = writeImpl(ctx.db, root);
    const csv = (ctx.deps.readTextImpl ?? ((p) => readFileSync(p, 'utf8')))(csvPath);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="job_tracker.csv"',
    });
    res.end(csv);
    return;
  }
  // Which optional tools are set up. The Activity menu lists a tool only when
  // it is configured or already has something to show: a menu item that can
  // only open "this is off" is clutter, not a feature.
  if (req.method === 'GET' && path === '/api/features') {
    const root = ctx.config?.root;
    let inbox;
    try {
      const settings = ctx.deps.inboxSettings ?? inboxSettings(ctx.deps.inboxEnv ?? process.env, { root, secrets: ctx.deps.secrets });
      inbox = Boolean(settings.enabled) || pendingSuggestions(ctx.db).length > 0;
    } catch { inbox = false; }
    let rerankOn;
    try {
      rerankOn = embedSettings(ctx.deps.rerankEnv ?? process.env, { root }).enabled || Boolean(readRerank(root));
    } catch { rerankOn = false; }
    return sendJson(res, 200, { inbox, rerank: rerankOn });
  }
  // Rank the top matches by meaning (P2-1): a second number, never the score.
  if (req.method === 'GET' && path === '/api/rerank') {
    const settings = embedSettings(ctx.deps.rerankEnv ?? process.env, { root: ctx.config?.root });
    return sendJson(res, 200, { enabled: settings.enabled, reason: settings.reason, result: readRerank(ctx.config?.root) });
  }
  if (req.method === 'POST' && path === '/api/rerank') {
    try {
      const result = await (ctx.deps.rerankImpl ?? rerank)({ db: ctx.db, config: ctx.config, env: ctx.deps.rerankEnv ?? process.env, deps: ctx.deps });
      return sendJson(res, 200, { result });
    } catch (err) {
      return sendJson(res, err.statusCode ?? 502, { error: sanitizeErrorMessage(err.message) });
    }
  }
  // LLM usage totals (P3-5): tokens per task and model, never content.
  if (req.method === 'GET' && path === '/api/llm-usage') {
    if (!ctx.config?.root) return sendJson(res, 200, { sinceDays: 30, totals: { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 }, rows: [] });
    return sendJson(res, 200, readUsage(ctx.config.root, { now: ctx.nowDate() }));
  }
  // Follow-up reminders as a calendar file (P2-5).
  if (req.method === 'GET' && path === '/api/calendar.ics') {
    const ics = buildIcs(openFollowUps(ctx.db), { now: ctx.nowDate() });
    res.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'attachment; filename="jobagent-follow-ups.ics"',
    });
    res.end(ics);
    return;
  }
  // Backups of the job store (P1-6). Paths are reported relative to the
  // workspace root, never absolute, and the files themselves are not served.
  if (req.method === 'GET' && path === '/api/backups') {
    const root = ctx.config?.root;
    if (!root) return sendJson(res, 200, { available: false, backups: [] });
    const backups = listBackups(root).map((b) => ({
      name: b.name, label: b.label, createdAt: b.createdAt, bytes: b.bytes,
      folder: relative(root, dirname(b.file)).split(sep).join('/'),
    }));
    return sendJson(res, 200, {
      available: true, backups, lastAutoAt: lastAutoBackupAt(root),
      totalBytes: backups.reduce((n, b) => n + b.bytes, 0),
      running: Boolean(ctx.backupState.running), lastError: ctx.backupState.lastError,
    });
  }
  if (req.method === 'POST' && path === '/api/backups') {
    if (!ctx.config?.root) return sendJson(res, 400, { error: 'This dashboard has no workspace folder to back up.' });
    try {
      const made = await ctx.runBackup('manual');
      return sendJson(res, 200, { ok: true, made: (made ?? []).map((m) => ({ workspaceId: m.workspaceId, bytes: m.bytes })) });
    } catch (err) {
      return sendJson(res, 500, { error: `Backup failed: ${sanitizeErrorMessage(err.message)}` });
    }
  }
  return NOT_HANDLED;
}
