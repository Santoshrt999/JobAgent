/**
 * Runs and batch actions: start a run, Auto-apply eligibility, assisted fill, the explicit Auto-submit path, approve, prepare, decide, add by URL.
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { ingestUrl, preparePacketsForJobs } from '../../cli/commands.js';
import { applyDecision, approveJobPacket } from '../data.js';
import { randomUUID } from 'node:crypto';
import { RUN_PHASES, batchJobIds, readBody, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';

export async function handleBatchRoutes(ctx, req, res, { path }) {
  if (req.method === 'POST' && path === '/api/run') {
    const body = await readBody(req);
    if (!RUN_PHASES.has(body.phase)) {
      return sendJson(res, 400, { error: `phase must be one of: ${[...RUN_PHASES].join(', ')}` });
    }
    return sendJson(res, 202, await ctx.startRun(body.phase));
  }
  if (req.method === 'POST' && path === '/api/auto-apply/eligibility') {
    const body = await readBody(req);
    const ids = batchJobIds(body.jobIds);
    if (ids.length === 0) return sendJson(res, 400, { error: 'select at least one job to preview' });
    return sendJson(res, 200, ctx.autoApplyEligibility(ids, body.autoSubmit === true));
  }
  if (req.method === 'POST' && path === '/api/assist-batch') {
    const body = await readBody(req);
    // "Assist" and the UI's "Auto-apply" always mean prepare + approve +
    // fill for review. A stray/legacy autoSubmit boolean must never turn this
    // ordinary action into a final submission.
    return sendJson(res, 202, ctx.startAssistBatch(body.jobIds, { autoSubmit: false }));
  }
  if (req.method === 'POST' && path === '/api/auto-submit-batch') {
    const body = await readBody(req);
    if (body.confirmed !== true) {
      return sendJson(res, 400, {
        error: 'auto-submit requires confirmed:true for this specific run',
      });
    }
    return sendJson(res, 202, ctx.startAssistBatch(body.jobIds, { autoSubmit: true }));
  }
  if (req.method === 'POST' && path === '/api/approve-batch') {
    const body = await readBody(req);
    const ids = batchJobIds(body.jobIds);
    const approved = [];
    const failed = [];
    for (const jobId of ids) {
      try { approveJobPacket(ctx.db, jobId, { digest: ctx.approvalDigestFor?.(jobId) ?? null }); approved.push(jobId); }
      catch (err) { failed.push({ jobId, error: err.message }); }
    }
    ctx.refreshTracker();
    return sendJson(res, 200, { approved, failed });
  }
  if (req.method === 'POST' && path === '/api/prepare-batch') {
    const body = await readBody(req);
    const ids = batchJobIds(body.jobIds);
    if (ids.length === 0) return sendJson(res, 400, { error: 'select at least one job to prepare' });
    if (ctx.runState.running) {
      return sendJson(res, 409, { error: `busy: ${ctx.runState.phase} is in progress` });
    }
    // Prepare refuses template values; judge the files as they are now, not as
    // they were at boot, or a value fixed by hand is still refused.
    ctx.refreshConfigIfTemplated?.();
    const prepareLock = ctx.takeRunLock('prepare-selected');
    // Reset the FULL run state, including runId/rca/progress. Leaving the
     // previous run's `progress` in place made the header report stale
     // counters (e.g. "prepare-selected (3) running… 13/13").
    Object.assign(ctx.runState, {
      running: true, phase: `prepare-selected (${ids.length})`,
      startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
      cancelRequested: false, runId: randomUUID(), rca: [], partial: false,
      progress: {
        total: ids.length, completed: 0, currentJobId: null,
        items: ids.map((jobId) => ({ jobId, status: 'queued' })),
      },
    });
    ctx.track((async () => {
      try {
        const prepareImpl = ctx.deps.prepareForJobsFn ?? preparePacketsForJobs;
        const r = await prepareImpl({
          config: ctx.config, db: ctx.db, logger: ctx.logger, jobIds: ids,
          deps: { ...ctx.deps, shouldCancel: () => ctx.runState.cancelRequested },
        });
        ctx.refreshTracker();
        // Mirror the outcome onto the progress items so the UI can show which
        // specific jobs were prepared and which failed.
        if (ctx.runState.progress?.items) {
          // Each item is labelled from an explicit outcome. Anything the
          // helper reported in no list is "skipped", never assumed prepared.
          const failedById = new Map((r.failed ?? []).map((f) => [f.jobId, f.error]));
          const cancelledIds = new Set((r.cancelled ?? []).map((c) => c.jobId));
          const preparedIds = new Set((r.prepared ?? []).map((p) => p.jobId));
          for (const item of ctx.runState.progress.items) {
            const failure = failedById.get(item.jobId);
            if (failure) Object.assign(item, { status: 'failed', error: failure });
            else if (cancelledIds.has(item.jobId)) Object.assign(item, { status: 'cancelled', error: null });
            else if (preparedIds.has(item.jobId)) Object.assign(item, { status: 'prepared' });
            else Object.assign(item, { status: 'skipped' });
          }
          ctx.runState.progress.completed = ctx.runState.progress.items.length;
        }
        ctx.runState.lastResult = {
          phase: 'prepare-selected',
          counters: { jobs_prepared: r.prepared.length },
          prepared: r.prepared, failed: r.failed, cancelled: r.cancelled ?? [],
        };
      } catch (err) {
        ctx.runState.lastError = `prepare-selected failed: ${err.message}`;
      } finally {
        ctx.runState.running = false;
        ctx.runState.finishedAt = new Date().toISOString();
        prepareLock.release();
      }
    })());
    return sendJson(res, 202, { started: true, queued: ids.length });
  }
  if (req.method === 'POST' && path === '/api/decide-batch') {
    const body = await readBody(req);
    const ids = batchJobIds(body.jobIds);
    const updated = [];
    const failed = [];
    for (const jobId of ids) {
      try { applyDecision(ctx.db, jobId, body.decision, { reason: body.reason ?? null }); updated.push(jobId); }
      catch (err) { failed.push({ jobId, error: err.message }); }
    }
    ctx.refreshTracker();
    return sendJson(res, 200, { updated, failed, decision: body.decision });
  }
  if (req.method === 'POST' && path === '/api/add-url') {
    const body = await readBody(req);
    const ingestImpl = ctx.deps.ingestUrlFn ?? ingestUrl;
    const result = await ingestImpl({ config: ctx.config, db: ctx.db, logger: ctx.logger, url: body.url, deps: ctx.deps });
    ctx.refreshTracker();
    return sendJson(res, 200, result);
  }
  return NOT_HANDLED;
}
