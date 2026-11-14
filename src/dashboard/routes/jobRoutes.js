/**
 * One job: its resume preview and every per-job action (decision, approve, assist, outcome, notes, link checks and more).
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { markApplicationUserSubmitted, markApplicationVerified, retractApplicationSubmission } from '../../apply/applicationState.js';
import { loadPacket } from '../../cli/commands.js';
import { sanitizeErrorMessage } from '../../utils/failureRca.js';
import { applyDecision, approveJobPacket, unapproveJobPacket, jobDetail, markSubmittedByHuman, noteUserMutation, recordOutcome, rejectJobPacket, retractSubmissionReport, setJobNote, undoDecision, undoOutcome, updateFollowUp } from '../data.js';
import { checkJobLink } from '../linkHealth.js';
import { isAggregatorUrl, isSafeObservedApplicationUrl, readBody, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';
import { decideRewrites, latestRewrites, proposeRewrites, refineRewrites, rewriteSettings } from '../../resume/rewrites.js';
import { APPROVAL_STATUS } from '../../apply/approvalQueue.js';
import { freezeVersions, readManifest, restoreVersion, unfreezeVersions, versionText } from '../../apply/documentVersions.js';
import { setLetterMode } from '../../apply/letterMode.js';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertInsideDirectory } from '../../utils/pathSafe.js';
import { writeLetterDocx } from '../../resume/tailorRunner.js';
import { sendBackToReview } from './materialsRoutes.js';

/**
 * The job's output folder, or null — refused (403) when the stored path is
 * outside the workspace. Reading versions copies files from it, so a tampered
 * row must not point the server at arbitrary folders.
 */
function containedFolder(ctx, job) {
  const folder = job?.output_folder_path ?? null;
  if (!folder) return null;
  const root = ctx.config?.root;
  if (root) assertInsideDirectory(root, folder, 'the documents folder escapes the Job Agent workspace');
  return folder;
}

export async function handleJobRoutes(ctx, req, res, { url, path }) {

  const resumeMatch = path.match(/^\/api\/jobs\/([^/]+)\/resume$/);
  if (req.method === 'GET' && resumeMatch) {
    const jobId = decodeURIComponent(resumeMatch[1]);
    const requested = url.searchParams.get('format') ?? 'auto';
    if (!['auto', 'pdf', 'docx'].includes(requested)) {
      return sendJson(res, 400, { error: 'resume format must be auto, pdf, or docx' });
    }
    const artifact = ctx.readResumePreview(jobId, requested);
    // The PDF is intentionally embeddable only by this same-origin local
    // dashboard. DOCX remains a download because browsers cannot render it.
    res.setHeader('x-frame-options', artifact.inline ? 'SAMEORIGIN' : 'DENY');
    res.setHeader('content-security-policy', artifact.inline
      ? "default-src 'none'; frame-ancestors 'self'"
      : "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(200, {
      'content-type': artifact.type,
      'content-length': artifact.bytes.length,
      'content-disposition': `${artifact.inline ? 'inline' : 'attachment'}; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`,
    });
    res.end(artifact.bytes);
    return;
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/([a-z-]+))?$/);
  if (jobMatch) {
    const [, jobId, action] = jobMatch.map((s) => (s ? decodeURIComponent(s) : s));
    if (req.method === 'GET' && !action) {
      const detail = jobDetail(ctx.db, jobId, { ...ctx.deps, root: ctx.config?.root ?? null, config: ctx.config, now: ctx.nowDate() });
      if (!detail) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
      return sendJson(res, 200, detail);
    }
    if (req.method === 'POST' && action === 'resume-preview') {
      const result = await ctx.materializeResumePreview(jobId);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && action === 'check-link') {
      const job = ctx.db.getJob?.(jobId);
      if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
      if (!isSafeObservedApplicationUrl(job.url)) {
        return sendJson(res, 400, { error: 'job URL must be a non-local HTTP(S) address' });
      }
      const checker = ctx.deps.checkLinkFn ?? checkJobLink;
      const result = await checker(job.url, { ...ctx.deps, job: { id: job.id, url: job.url, source: job.source } });
      // A definitive answer from the ATS is recorded; a closed posting nobody
      // acted on leaves the board (discarded, "expired: …"), as the sweep does.
      let retired = false;
      const state = result?.liveness?.state;
      if (state === 'open' || state === 'closed') {
        try {
          retired = ctx.db.recordPostingCheck?.(jobId, { state, via: result.liveness.via })?.retired === true;
          noteUserMutation();
        } catch { /* the check result is still worth returning */ }
      }
      return sendJson(res, 200, { ...result, retired });
    }
    if (req.method === 'POST' && action === 'link') {
      const job = ctx.db.getJob?.(jobId);
      if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
      const body = await readBody(req);
      const replacement = String(body.url ?? '').trim();
      if (!isSafeObservedApplicationUrl(replacement)) {
        return sendJson(res, 400, { error: 'replacement must be a non-local HTTP(S) job URL' });
      }
      if (isAggregatorUrl(replacement)) {
        return sendJson(res, 400, { error: 'use the direct employer/ATS application URL, not another aggregator link' });
      }
      ctx.db.upsertJob({ id: jobId, url: replacement });
      ctx.refreshTracker();
      return sendJson(res, 200, { updated: true, jobId, url: replacement });
    }
    if (req.method === 'POST' && action === 'decision') {
      const body = await readBody(req);
      // Optional `reason` (DECISION_REASONS) + `reasonNote` (<= 200 chars).
      const result = applyDecision(ctx.db, jobId, body.decision, { reason: body.reason ?? null, reasonNote: body.reasonNote ?? null });
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    // Revert the most recent decision on ONE job, restoring the exact
    // decision and reason it replaced (409 when there is nothing to undo).
    if (req.method === 'POST' && action === 'undo-decision') {
      await readBody(req);
      const result = undoDecision(ctx.db, jobId);
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && action === 'approve') {
      const result = approveJobPacket(ctx.db, jobId, { digest: ctx.approvalDigestFor?.(jobId) ?? null });
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && action === 'unapprove') {
      const result = unapproveJobPacket(ctx.db, jobId);
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && action === 'reject-packet') {
      const result = rejectJobPacket(ctx.db, jobId);
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    // "No, it didn't go through" on an unconfirmed submission.
    if (req.method === 'POST' && action === 'not-submitted') {
      const result = retractSubmissionReport(ctx.db, jobId);
      // The resumable checkpoint said "submitted" too, and refused every
      // retry until it was told otherwise; the documents were frozen as sent.
      try {
        const approval = ctx.db.getApprovalByJob?.(jobId);
        const packet = approval
          ? (ctx.deps.loadPacketImpl ? ctx.deps.loadPacketImpl(approval) : loadPacket(approval))
          : null;
        if (packet && ctx.config?.root) {
          await retractApplicationSubmission({ root: ctx.config.root, packet, toBlocked: result.to === 'assist_blocked' });
        }
      } catch (err) {
        ctx.logger?.warn?.(`application-state retraction skipped for ${jobId}: ${sanitizeErrorMessage(err.message)}`);
      }
      try { unfreezeVersions(ctx.db.getJob(jobId)?.output_folder_path); }
      catch (err) { ctx.logger?.warn?.(`could not unfreeze document versions for ${jobId}: ${sanitizeErrorMessage(err.message)}`); }
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && action === 'mark-submitted') {
      const body = await readBody(req);
      const result = markSubmittedByHuman(ctx.db, jobId, {
        now: ctx.nowDate(),
        confirmationNumber: body.confirmationNumber,
        verified: body.verified === true,
        note: body.note,
      });
      // Keep the privacy-minimized resumable checkpoint aligned when one
      // exists. Legacy jobs without a checkpoint remain valid DB records.
      try {
        const approval = ctx.db.getApprovalByJob?.(jobId);
        const packet = approval
          ? (ctx.deps.loadPacketImpl ? ctx.deps.loadPacketImpl(approval) : loadPacket(approval))
          : null;
        if (packet && ctx.config?.root) {
          const evidence = [body.confirmationNumber, body.note].filter(Boolean);
          await markApplicationUserSubmitted({ root: ctx.config.root, packet, evidence });
          if (result.verified) {
            await markApplicationVerified({ root: ctx.config.root, packet, evidence: evidence.length ? evidence : ['human confirmed submission evidence'] });
          }
        }
      } catch (err) {
        ctx.logger?.warn?.(`application-state submission sync skipped for ${jobId}: ${sanitizeErrorMessage(err.message)}`);
      }
      // What was sent is now the record: freeze the document versions (P2-2).
      try { freezeVersions(ctx.db.getJob(jobId)?.output_folder_path, { reason: 'submitted by you' }); }
      catch (err) { ctx.logger?.warn?.(`could not freeze document versions for ${jobId}: ${sanitizeErrorMessage(err.message)}`); }
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    // Document versions (P2-2): list, compare, restore.
    if (req.method === 'GET' && action === 'versions') {
      const folder = containedFolder(ctx, ctx.db.getJob(jobId));
      const manifest = folder ? readManifest(folder) : { versions: [] };
      return sendJson(res, 200, {
        versions: manifest.versions.map(({ n, cause, at, files, task, frozen }) => ({ n, cause, at, files, task, frozen })),
        frozenAt: manifest.frozenAt ?? null,
      });
    }
    if (req.method === 'GET' && action === 'version-text') {
      const folder = containedFolder(ctx, ctx.db.getJob(jobId));
      if (!folder) return sendJson(res, 404, { error: 'This job has no prepared documents yet.' });
      return sendJson(res, 200, versionText(folder, Number(url.searchParams.get('n'))));
    }
    if (req.method === 'POST' && action === 'restore-version') {
      const body = await readBody(req);
      const job = ctx.db.getJob(jobId);
      const folder = containedFolder(ctx, job);
      if (!folder) return sendJson(res, 404, { error: 'This job has no prepared documents yet.' });
      // Every file a restore overwrites must be inside the workspace: these
      // paths come from the database, not from code (BUG-05).
      const letter = job.cover_letter_path ?? null;
      const current = {
        resume: job.resume_docx_path ?? job.resume_path ?? null,
        resumePdf: job.resume_pdf_path ?? null,
        letter,
        // The Word copy of the letter follows the text. Without it, restoring
        // rolled back the .txt and left the .docx on the newer letter.
        letterDocx: letter && /\.txt$/i.test(letter) ? letter.replace(/\.txt$/i, '.docx') : null,
      };
      const root = ctx.config?.root;
      if (root) {
        for (const p of Object.values(current)) if (p) assertInsideDirectory(root, p, 'a document path escapes the Job Agent workspace');
      }
      const target = readManifest(folder).versions.find((v) => v.n === Number(body.n));
      const hadDocx = Boolean(current.letterDocx && existsSync(current.letterDocx));
      const version = restoreVersion(folder, Number(body.n), current, { now: ctx.nowDate() });
      // The version predates the Word copy: rebuild it from the restored text
      // (best effort; Python is optional), so both say the same thing.
      if (hadDocx && target?.files?.letter && !target.files.letterDocx && ctx.deps?.writeLetterDocxFn !== false) {
        try {
          await (ctx.deps?.writeLetterDocxFn ?? writeLetterDocx)({ text: readFileSync(letter, 'utf8'), path: current.letterDocx, root, deps: ctx.deps ?? {} });
        } catch (err) { ctx.logger?.warn?.(`restored letter .docx not rebuilt: ${sanitizeErrorMessage(err.message)}`); }
      }
      // The documents changed, so an approval of the previous ones no longer
      // stands — the same rule as editing the letter or accepting a rewrite.
      const needsReapproval = sendBackToReview(ctx, jobId);
      ctx.db.insertEvent?.({
        id: randomUUID(), job_id: jobId, event_type: 'documents_restored',
        message: `documents restored to version ${Number(body.n)} by you`, metadata: JSON.stringify({ n: Number(body.n) }),
      });
      noteUserMutation();
      ctx.refreshTracker();
      return sendJson(res, 200, { restored: Number(body.n), version, needsReapproval });
    }
    // Recruiting outcomes and follow-ups on a SUBMITTED application. Each is
    // validated and appended as an event; none changes the job's status,
    // submission or decision, and none approves or submits anything.
    if (req.method === 'POST' && action === 'outcome') {
      const body = await readBody(req);
      return sendJson(res, 200, recordOutcome(ctx.db, jobId, {
        outcome: body.outcome, on: body.on ?? null, note: body.note ?? null, now: ctx.nowDate(), config: ctx.config,
      }));
    }
    if (req.method === 'POST' && action === 'undo-outcome') {
      await readBody(req);
      return sendJson(res, 200, undoOutcome(ctx.db, jobId, { now: ctx.nowDate(), config: ctx.config }));
    }
    if (req.method === 'POST' && action === 'follow-up') {
      const body = await readBody(req);
      return sendJson(res, 200, updateFollowUp(ctx.db, jobId, {
        action: body.action, dueOn: body.dueOn ?? null, note: body.note ?? null, now: ctx.nowDate(), config: ctx.config,
      }));
    }
    // Grounded rewrite suggestions (P1-2): read, ask for, and decide.
    if (req.method === 'GET' && action === 'rewrites') {
      const settings = rewriteSettings(ctx.deps.rewriteEnv ?? process.env, { root: ctx.config?.root });
      return sendJson(res, 200, { enabled: settings.enabled, reason: settings.reason, record: latestRewrites(ctx.db, jobId) });
    }
    if (req.method === 'POST' && action === 'rewrites') {
      const job = ctx.db.getJob(jobId);
      if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
      const proposeImpl = ctx.deps.proposeRewritesImpl ?? proposeRewrites;
      const result = await proposeImpl({ db: ctx.db, job, config: ctx.config, deps: ctx.deps });
      if (!result.ok) return sendJson(res, result.disabled ? 409 : 502, { error: result.error });
      return sendJson(res, 200, { record: result.record });
    }
    if (req.method === 'POST' && action === 'refine') {
      const body = await readBody(req);
      const job = ctx.db.getJob(jobId);
      if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
      const refineImpl = ctx.deps.refineRewritesImpl ?? refineRewrites;
      const result = await refineImpl({ db: ctx.db, job, config: ctx.config, instruction: body.instruction, deps: ctx.deps });
      if (!result.ok) return sendJson(res, result.disabled ? 409 : 400, { error: result.error });
      return sendJson(res, 200, { record: result.record, declined: result.declined });
    }
    if (req.method === 'POST' && action === 'rewrite-decision') {
      const body = await readBody(req);
      const { record, changed } = decideRewrites(ctx.db, jobId, {
        unitId: body.unitId ?? null, decision: body.decision ?? null, acceptAllVerified: body.acceptAllVerified === true,
      });
      // A changed resume is a changed application: an approved packet goes
      // back to review, so nothing is filled with text nobody approved.
      let needsReapproval = false;
      const approval = ctx.db.getApprovalByJob?.(jobId);
      if (changed && approval?.approval_status === APPROVAL_STATUS.APPROVED) {
        ctx.db.updateApprovalStatus(approval.id, { approval_status: APPROVAL_STATUS.PENDING, approved_by_user: 0, approved_at: null });
        needsReapproval = true;
      }
      return sendJson(res, 200, { record, changed, needsReapproval });
    }
    // The cover-letter choice for this job (template instead of grounded).
    if (req.method === 'POST' && action === 'letter-mode') {
      const body = await readBody(req);
      return sendJson(res, 200, setLetterMode(ctx.db, jobId, String(body.mode ?? '')));
    }
    if (req.method === 'POST' && action === 'note') {
      const body = await readBody(req);
      const result = setJobNote(ctx.db, jobId, body.note);
      // Notes travel in the tracker CSV; the refresh is debounced (400 ms).
      ctx.refreshTracker();
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && action === 'assist') {
      return sendJson(res, 202, await ctx.startAssist(jobId));
    }
    if (req.method === 'GET' && action === 'eligibility') {
      return sendJson(res, 200, ctx.autoApplyEligibility(
        [jobId], url.searchParams.get('autoSubmit') === 'true',
      ).items[0]);
    }
    // One-click end-to-end: prepare (if needed) -> approve -> fill for human
    // review. This named action NEVER clicks the final Submit button.
    if (req.method === 'POST' && action === 'auto-apply') {
      await readBody(req); // consume/validate any legacy JSON body
      return sendJson(res, 202, ctx.startAssistBatch([jobId], { autoSubmit: false }));
    }
  }
  return NOT_HANDLED;
}
