/**
 * The Chromium extension API (/api/extension/*): its own origin and shared-key checks, then payload, files and result.
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { APPROVAL_STATUS } from '../../apply/approvalQueue.js';
import { recordAssistResult } from '../../cli/commands.js';
import { buildExtensionPayload, isChromiumExtensionOrigin, readApprovedArtifact, validExtensionKey } from '../../extension/companion.js';
import { LIFECYCLE } from '../../lifecycle.js';
import { isAggregatorUrl, isAllowedOrigin, isSafeObservedApplicationUrl, readBody, sendJson, setExtensionCors } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';

export async function handleExtensionRoutes(ctx, req, res, { path }) {

  // The optional Chromium extension has a different origin by design. It is
  // admitted only on this narrow API namespace, only from a real extension
  // origin, and only with a 32+ byte shared key. All ordinary dashboard
  // routes retain the stricter same-loopback-origin policy below.
  if (path.startsWith('/api/extension/')) {
    const origin = String(req.headers.origin ?? '');
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    // Edge does not consistently attach the extension origin to privileged
    // loopback fetches (depending on popup/service-worker context). Treat the
    // high-entropy shared key as authentication, while Fetch Metadata + CORS
    // continue to reject normal cross-site webpages. A null/absent Origin is
    // accepted only on this key-protected namespace.
    const allowedTransport = isChromiumExtensionOrigin(origin)
      || isAllowedOrigin(origin)
      || origin === 'null';
    if (!allowedTransport || fetchSite === 'cross-site') {
      return sendJson(res, 403, { error: 'forbidden: extension transport rejected' });
    }
    if (origin) setExtensionCors(res, origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!validExtensionKey(ctx.extensionKey, req.headers['x-job-agent-key'])) {
      return sendJson(res, ctx.extensionKey ? 401 : 503, {
        error: ctx.extensionKey
          ? 'invalid Job Agent extension key'
          : 'extension API is disabled; set JOB_AGENT_EXTENSION_KEY in .env and restart',
      });
    }

    const match = path.match(/^\/api\/extension\/jobs\/([^/]+)(?:\/(payload|result|files\/(resume|cover-letter)))?$/);
    if (!match) return sendJson(res, 404, { error: `no extension route: ${req.method} ${path}` });
    const jobId = decodeURIComponent(match[1]);
    const action = match[2] ?? 'payload';
    if (req.method === 'GET' && action === 'payload') {
      return sendJson(res, 200, buildExtensionPayload({
        db: ctx.db, config: ctx.config, jobId, loadPacketImpl: ctx.deps.loadPacketImpl,
      }));
    }
    if (req.method === 'GET' && action.startsWith('files/')) {
      const artifact = readApprovedArtifact({
        db: ctx.db, config: ctx.config, jobId, kind: match[3], loadPacketImpl: ctx.deps.loadPacketImpl,
      });
      res.writeHead(200, {
        'content-type': artifact.type,
        'content-length': artifact.bytes.length,
        'content-disposition': `attachment; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`,
      });
      res.end(artifact.bytes);
      return;
    }
    if (req.method === 'POST' && action === 'result') {
      const body = await readBody(req);
      // The extension may only REPORT on a job it was given an approved
      // packet for. This route used to accept any id: an unknown one created
      // nothing but still "recorded", and a submitted (or unverified-submit)
      // job could be flipped back to assist_started / ready_for_submit —
      // un-submitting an application and re-opening it for a second fill.
      // The checks below and the write at the end run in ONE immediate
      // transaction (RISK-02): another process (a CLI run, a second window)
      // rejecting the packet or recording a submission between the check and
      // the write could otherwise be overwritten with a fill result.
      const refuse = (status, error) => Object.assign(new Error(error), { refusal: { status, error } });
      const checkStillAllowed = () => {
        const job = ctx.db.getJob?.(jobId);
        if (!job) throw refuse(404, `unknown job id: ${jobId}`);
        if (ctx.isSubmittedOrUnverified(job)) {
          throw refuse(409, 'this job is already submitted (or awaiting submit verification) — result not recorded');
        }
        const approval = ctx.db.getApprovalByJob?.(jobId);
        if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) {
          throw refuse(409, 'this job\'s packet is not human-approved — approve it before using the extension');
        }
        return job;
      };
      let current;
      try { current = checkStillAllowed(); } catch (err) {
        if (err.refusal) return sendJson(res, err.refusal.status, { error: err.refusal.error });
        throw err;
      }
      const filled = Array.isArray(body.filled) ? body.filled.slice(0, 120).map((x) => ({
        field: String(x?.field ?? '').slice(0, 80),
        label: String(x?.label ?? '').slice(0, 120),
        source: String(x?.source ?? '').slice(0, 40),
      })) : [];
      const blockers = Array.isArray(body.blockers)
        ? body.blockers.slice(0, 40).map((x) => String(x).slice(0, 240)) : [];
      const formDetected = body.formDetected === true;
      const startedApplication = body.startedApplication === true;
      const readyForReview = body.readyForReview === true
        && formDetected && filled.length > 0 && blockers.length === 0;
      const status = readyForReview ? LIFECYCLE.READY_FOR_SUBMIT
        : formDetected && blockers.length > 0 ? LIFECYCLE.ASSIST_BLOCKED
          : LIFECYCLE.ASSIST_STARTED;
      const phases = [
        { phase: 'extension_assist_started', at: ctx.nowDate().toISOString() },
        { phase: status, at: ctx.nowDate().toISOString() },
      ];

      // Once a user follows an aggregator's Apply link, remember the verified
      // employer URL. Future extension runs open the useful direct page
      // instead of bouncing through LinkedIn/Indeed again.
      const write = () => {
        checkStillAllowed(); // re-checked under the write lock
        if (body.contextVerified === true && isSafeObservedApplicationUrl(body.observedUrl)) {
          if (isAggregatorUrl(current.url)) {
            ctx.db.upsertJob({ id: jobId, url: String(body.observedUrl).slice(0, 2048) });
          }
        }
        recordAssistResult(ctx.db, jobId, {
          status, submitted: false, filled, blockers, phases,
        });
      };
      try {
        if (typeof ctx.db.transaction === 'function') ctx.db.transaction(write); else write();
      } catch (err) {
        if (err.refusal) return sendJson(res, err.refusal.status, { error: err.refusal.error });
        throw err;
      }
      ctx.refreshTracker();
      return sendJson(res, 200, {
        recorded: true, status, formDetected, startedApplication, readyForReview,
      });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  return NOT_HANDLED;
}
