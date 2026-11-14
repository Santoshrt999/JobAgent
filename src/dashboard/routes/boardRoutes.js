/**
 * The board: stats, Today, Applications, jobs, role search, run status and history, sections, reports and documents.
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { runQuerySearch } from '../../cli/commands.js';
import { sanitizeErrorMessage } from '../../utils/failureRca.js';
import { applicationsWorkspace, boardPage, buildDocuments, buildReports, dashboardSections, dashboardStats, todayQueue } from '../data.js';
import { randomUUID } from 'node:crypto';
import { MAX_JOBS_PAGE, RUNS_DEFAULT_LIMIT, RUNS_MAX_LIMIT, readBody, runSummary, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';
import { restartNotice } from '../codeFreshness.js';

export async function handleBoardRoutes(ctx, req, res, { url, path }) {
  if (req.method === 'GET' && path === '/api/stats') {
    // Stale-while-revalidate: a stats rebuild blocks this single-threaded
    // server for seconds on a large store; the tiles can show the last value
    // (flagged `stale: true`) while one rebuild runs after the response.
    return sendJson(res, 200, dashboardStats(ctx.db, { now: ctx.nowDate(), config: ctx.config, allowStale: true }));
  }
  // The Today queue: the ten next actions + setup notices (see todayQueue).
  if (req.method === 'GET' && path === '/api/today') {
    // A template value fixed by hand must clear its notice without a restart.
    ctx.refreshConfigIfTemplated?.();
    const today = todayQueue(ctx.db, { now: ctx.nowDate(), config: ctx.config, browserAvailable: await ctx.browserAvailableCached() });
    const restart = restartNotice(ctx.codeChangedSinceStart());
    if (restart) today.systemNotices = [restart, ...(today.systemNotices ?? [])];
    return sendJson(res, 200, today);
  }
  // The Applications workspace: every application as a card in its stage,
  // with recorded outcomes, follow-ups and the numbers they add up to.
  if (req.method === 'GET' && path === '/api/applications') {
    return sendJson(res, 200, applicationsWorkspace(ctx.db, { now: ctx.nowDate(), config: ctx.config }));
  }
  if (req.method === 'GET' && path === '/api/jobs') {
    const filters = Object.fromEntries(url.searchParams.entries());
    filters.now = ctx.nowDate();
    // One page, not the table: `?limit=1e9` would serialize every row of a
    // 100k-job database. The UI's largest page size is 500.
    if (Number(filters.limit) > MAX_JOBS_PAGE) filters.limit = String(MAX_JOBS_PAGE);
    return sendJson(res, 200, boardPage(ctx.db, filters));
  }
  // Ad-hoc query-first discovery: "find jobs matching this phrase, now".
  // Shares the run lock with /api/run, because it drives the same pipeline
  // and two concurrent writers would interleave upserts on the same rows.
  if (req.method === 'POST' && path === '/api/search') {
    const body = await readBody(req);
    const query = String(body.query ?? '').trim();
    if (!query) return sendJson(res, 400, { error: 'enter something to search for' });
    if (ctx.runState.running) {
      return sendJson(res, 409, { error: `a ${ctx.runState.phase} run is in progress — wait for it to finish` });
    }
    /*
     * TAKE THE LOCK, do not merely look at it.
     *
     * This checked `runState.running` and never SET it, so the mutual
     * exclusion it documents only worked in one direction: a run blocked a
     * search, and a search blocked nothing. Starting "Find new jobs" while a
     * role search was in flight ran both pipelines against the same jobs
     * table at once — the interleaved upserts this guard exists to prevent,
     * and with the two modes now writing different `discovery_mode` values to
     * the same rows, the ownership rule in persistJob would be racing too.
     *
     * Held in a finally so a failed search can never strand the lock and
     * leave every later run answering 409.
     */
    const searchLock = ctx.takeRunLock('role_search');
    Object.assign(ctx.runState, {
      running: true, phase: `role search: ${query}`, startedAt: new Date().toISOString(),
      finishedAt: null, lastError: null, cancelRequested: false,
      runId: randomUUID(), rca: [], partial: false, progress: null,
    });
    try {
      const searchFn = ctx.deps.querySearchFn ?? runQuerySearch;
      const result = await searchFn({ config: ctx.config, db: ctx.db, logger: ctx.logger, query, deps: ctx.deps });
      return sendJson(res, 200, result);
    } catch (err) {
      ctx.runState.lastError = sanitizeErrorMessage(err.message);
      return sendJson(res, err.statusCode ?? 400, { error: sanitizeErrorMessage(err.message) });
    } finally {
      ctx.runState.running = false;
      ctx.runState.finishedAt = new Date().toISOString();
      searchLock.release();
    }
  }
  /*
   * The role searches that have been run and still hold rows.
   *
   * Role-search results live in the same table as the personalized board but
   * are fenced off by `discovery_mode`, so they need their own index — there
   * is no other way to find them again, and without one they would be rows
   * nobody could reach or clean up.
   */
  if (req.method === 'GET' && path === '/api/search/history') {
    return sendJson(res, 200, { searches: ctx.db.listRoleSearches?.() ?? [] });
  }
  // Discard one role search entirely. Scoped to `discovery_mode` in SQL, so
  // it can never reach a row the personalized board owns.
  if (req.method === 'DELETE' && path === '/api/search') {
    const query = String(url.searchParams.get('query') ?? '').trim();
    if (!query) return sendJson(res, 400, { error: 'which search should be cleared?' });
    const removed = ctx.db.deleteRoleSearch?.(query) ?? 0;
    // `kept`: rows the user had acted on (applied, decided, packet, queued)
    // are re-owned by the personalized board instead of deleted.
    return sendJson(res, 200, { query, removed, kept: ctx.db.lastRoleSearchKept ?? 0 });
  }
  if (req.method === 'GET' && path === '/api/run/status') {
    return sendJson(res, 200, ctx.runState);
  }
  // Run HISTORY, as opposed to the live state above. run_log was written by
  // nothing and read by nothing, so "what did last night's run do?" had no
  // answer anywhere in the product.
  if (req.method === 'GET' && path === '/api/runs') {
    const requested = Number(url.searchParams.get('limit') ?? RUNS_DEFAULT_LIMIT);
    const limit = Number.isFinite(requested) && requested >= 1
      ? Math.min(RUNS_MAX_LIMIT, Math.floor(requested)) : RUNS_DEFAULT_LIMIT;
    return sendJson(res, 200, { runs: (ctx.db.listRunLogs?.({ limit }) ?? []).map(runSummary) });
  }
  if (req.method === 'POST' && path === '/api/run/cancel') {
    if (!ctx.runState.running) {
      return sendJson(res, 409, { error: 'nothing is running' });
    }
    ctx.runState.cancelRequested = true;
    // Abort in-flight and gate-queued network work too. Without this, cancel
    // was cooperative polling only: adapters noticed between operations, but a
    // request already on the wire still had to finish or time out (30s), so
    // stopping a discovery run took ~30 seconds.
    ctx.runAbort?.abort();
    return sendJson(res, 202, {
      cancelling: true,
      phase: ctx.runState.phase,
      note: ctx.runState.phase === 'discover'
        ? 'queued discovery work is dropped and in-flight requests are aborted; results already found are kept'
        : 'the current safe step will finish, then queued work will stop',
    });
  }
  if (req.method === 'GET' && path === '/api/sections') {
    const sections = dashboardSections(ctx.db, { now: ctx.nowDate() });
    // `?only=<key>`: one section, for a panel that refreshes on its own.
    const only = url.searchParams.get('only');
    if (only) {
      if (!Object.hasOwn(sections, only)) {
        return sendJson(res, 400, { error: `unknown section "${only}" (use ${Object.keys(sections).join(', ')})` });
      }
      return sendJson(res, 200, { [only]: sections[only] });
    }
    return sendJson(res, 200, sections);
  }
  if (req.method === 'GET' && path === '/api/reports') {
    return sendJson(res, 200, buildReports(ctx.db, { now: ctx.nowDate(), config: ctx.config }));
  }
  if (req.method === 'GET' && path === '/api/documents') {
    return sendJson(res, 200, buildDocuments(ctx.db, { root: ctx.config?.root ?? null, now: ctx.nowDate() }));
  }
  return NOT_HANDLED;
}
