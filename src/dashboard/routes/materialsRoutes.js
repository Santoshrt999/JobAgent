/**
 * Your materials: the master cover letter, each job's own letter, and the
 * master-vs-tailored resume comparison.
 *
 *   GET  /api/master-letter                 text, facts, quality, kept versions
 *   POST /api/master-letter                 save edited text {text}
 *   POST /api/master-letter/upload          {filename, contentBase64} (.docx/.txt/.md)
 *   GET  /api/master-letter/starter         a first draft from the profile (not saved)
 *   GET  /api/master-letter/version?name=   one kept version's text
 *   POST /api/master-letter/restore         {name}
 *   GET  /api/master-letter/file            download as .txt
 *   POST /api/master-letter/preview         {text?, jobId?} quality, and the letter for that job
 *   GET  /api/jobs/:id/cover-letter         this job's letter
 *   POST /api/jobs/:id/cover-letter         save an edit {text} (frozen once submitted)
 *   POST /api/jobs/:id/letter-draft         a letter for a job that has none (not saved)
 *   GET  /api/jobs/:id/resume-diff          master vs tailored, line by line
 *   POST /api/jobs/:id/keep-bullets         {bullets} never omitted on the next tailoring
 *
 * Nothing here submits, approves or fills anything. Editing a letter that is
 * part of an approved packet sends the packet back to review, exactly like an
 * accepted resume rewrite does.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { MAX_UPLOAD_BODY_BYTES, readBody, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';
import {
  letterTextFromUpload, masterLetterState, readMasterLetterText, readMasterLetterVersion,
  restoreMasterLetter, saveMasterLetter, starterLetter,
} from '../../apply/masterLetter.js';
import { assessLetter } from '../../apply/letterQuality.js';
import { generateCoverLetter } from '../../apply/coverLetter.js';
import { readManifest, recordVersion } from '../../apply/documentVersions.js';
import { APPROVAL_STATUS } from '../../apply/approvalQueue.js';
import { diffResume } from '../../resume/resumeDiff.js';
import { extractDocxText } from '../../resume/docxText.js';
import { keptBulletsFor, setKeptBullets } from '../../resume/keepBullets.js';
import { writeLetterDocx } from '../../resume/tailorRunner.js';
import { masterResumeFile } from '../../profile/workspace.js';
import { assertInsideDirectory } from '../../utils/pathSafe.js';
import { writeFileAtomic } from '../../utils/fsSafe.js';

const MAX_JOB_LETTER_CHARS = 20_000;

/** Used only when config/cover_letter.json has no template of its own. */
const FALLBACK_TEMPLATE = Object.freeze({
  opening: 'I am applying for the {title} role at {company}. As a {headline} with {years} of experience, I believe my background fits what you are looking for.',
  skillsLead: 'Relevant to this role:',
  experience: 'In my current role I {topHighlight}.',
  fitNote: 'My recent work also includes {focusAreas}.',
  sponsorshipNote: '',
  closingParagraph: 'I would welcome the chance to discuss how I can contribute to {company}. Thank you for your consideration.',
});

/** @param {any} ctx */
const rootOf = (ctx) => {
  const root = ctx.config?.root ?? null;
  if (!root) throw Object.assign(new Error('no project root is configured'), { statusCode: 503 });
  return root;
};

function decodeUpload(body) {
  const encoded = String(body.contentBase64 ?? '');
  if (!encoded) throw Object.assign(new Error('no file contents were received'), { statusCode: 400 });
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('the file contents were not transferred correctly, try again'), { statusCode: 400 });
  }
  return Buffer.from(encoded, 'base64');
}

/** The job's stored score in the shape the letter composer expects. */
function scoreOf(job) {
  let matched;
  try { matched = JSON.parse(job.matched_keywords ?? '[]'); } catch { matched = []; }
  return { total: Number(job.score ?? 0), matchedKeywords: Array.isArray(matched) ? matched : [] };
}

/** A letter for this job from the master letter (or the template), not saved. */
function draftFor(ctx, job, masterText) {
  const config = ctx.config ?? {};
  const cover = generateCoverLetter(
    { title: job.title, company: job.company },
    scoreOf(job),
    {
      // A draft is asked for explicitly, so the score gate does not apply.
      coverLetter: {
        greeting: 'Dear Hiring Team,', closing: 'Sincerely,', wordCount: { min: 180, max: 320 },
        ...(config.coverLetter ?? {}),
        template: { ...FALLBACK_TEMPLATE, ...(config.coverLetter?.template ?? {}) },
        enabled: true, minScoreToGenerate: 0,
      },
      candidate: config.candidate ?? {},
      humanizerPatterns: config.humanizerPatterns ?? {},
      masterLetter: masterText,
      required: true,
    },
  );
  return { text: cover.text ?? '', words: cover.wordCount, source: cover.source, master: cover.master ?? null, quality: cover.quality ?? null };
}

function loadPacketFile(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * A changed document invalidates an approval: the person approved OTHER words.
 * Returns true when an approved packet went back to review.
 */
export function sendBackToReview(ctx, jobId) {
  const approval = ctx.db.getApprovalByJob?.(jobId);
  if (approval?.approval_status === APPROVAL_STATUS.APPROVED) {
    ctx.db.updateApprovalStatus(approval.id, { approval_status: APPROVAL_STATUS.PENDING, approved_by_user: 0, approved_at: null });
    return true;
  }
  return false;
}

export async function handleMaterialsRoutes(ctx, req, res, { url, path }) {
  // ── master cover letter ─────────────────────────────────────────────────
  if (path === '/api/master-letter' && req.method === 'GET') {
    return sendJson(res, 200, masterLetterState(rootOf(ctx)));
  }
  if (path === '/api/master-letter' && req.method === 'POST') {
    const body = await readBody(req, 200_000);
    const result = saveMasterLetter(rootOf(ctx), String(body.text ?? ''), { now: ctx.nowDate?.() ?? new Date() });
    return sendJson(res, 200, result);
  }
  if (path === '/api/master-letter/upload' && req.method === 'POST') {
    const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
    const text = letterTextFromUpload(body.filename, decodeUpload(body));
    const result = saveMasterLetter(rootOf(ctx), text, { now: ctx.nowDate?.() ?? new Date() });
    return sendJson(res, 200, result);
  }
  if (path === '/api/master-letter/starter' && req.method === 'GET') {
    return sendJson(res, 200, { text: starterLetter(ctx.config?.candidate ?? {}) });
  }
  if (path === '/api/master-letter/version' && req.method === 'GET') {
    const version = readMasterLetterVersion(rootOf(ctx), url.searchParams.get('name'));
    return sendJson(res, 200, { ...version, quality: assessLetter(version.text, { master: true }) });
  }
  if (path === '/api/master-letter/restore' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, restoreMasterLetter(rootOf(ctx), body.name, { now: ctx.nowDate?.() ?? new Date() }));
  }
  if (path === '/api/master-letter/file' && req.method === 'GET') {
    const text = readMasterLetterText(rootOf(ctx));
    if (!text) return sendJson(res, 404, { error: 'there is no master cover letter yet' });
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': bytes.length,
      'content-disposition': 'attachment; filename="Master_Cover_Letter.txt"',
    });
    res.end(bytes);
    return undefined;
  }
  if (path === '/api/master-letter/preview' && req.method === 'POST') {
    const body = await readBody(req, 200_000);
    const text = typeof body.text === 'string' ? body.text : readMasterLetterText(rootOf(ctx));
    const out = { quality: assessLetter(text, { master: true }), letter: null };
    if (body.jobId) {
      const job = ctx.db.getJob(String(body.jobId));
      if (!job) return sendJson(res, 404, { error: `unknown job id: ${body.jobId}` });
      out.letter = { jobId: job.id, company: job.company, title: job.title, ...draftFor(ctx, job, text) };
    }
    return sendJson(res, 200, out);
  }

  // ── one job's materials ─────────────────────────────────────────────────
  const m = path.match(/^\/api\/jobs\/([^/]+)\/(cover-letter|letter-draft|resume-diff|keep-bullets)$/);
  if (!m) return NOT_HANDLED;
  const jobId = decodeURIComponent(m[1]);
  const action = m[2];
  const job = ctx.db.getJob(jobId);
  if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
  const root = rootOf(ctx);

  if (action === 'cover-letter' && req.method === 'GET') {
    const file = job.cover_letter_path;
    if (!file || !existsSync(file)) return sendJson(res, 200, { exists: false, text: '', quality: null, frozen: false });
    assertInsideDirectory(root, file, 'cover letter path escapes the Job Agent workspace');
    const text = readFileSync(file, 'utf8');
    const manifest = job.output_folder_path ? readManifest(job.output_folder_path) : { versions: [] };
    return sendJson(res, 200, {
      exists: true, name: basename(file), text,
      quality: assessLetter(text, { company: job.company ?? '', title: job.title ?? '' }),
      frozen: Boolean(manifest.frozenAt),
    });
  }
  if (action === 'cover-letter' && req.method === 'POST') {
    const body = await readBody(req, 200_000);
    const file = job.cover_letter_path;
    if (!file || !existsSync(file)) {
      return sendJson(res, 409, { error: 'This job has no saved cover letter to edit. Draft one, or prepare the job again.' });
    }
    assertInsideDirectory(root, file, 'cover letter path escapes the Job Agent workspace');
    if (!/\.txt$/i.test(file)) return sendJson(res, 409, { error: 'Only the plain-text letter can be edited here.' });
    const folder = job.output_folder_path ?? null;
    if (folder && readManifest(folder).frozenAt) {
      return sendJson(res, 409, { error: 'This application was submitted, so its letter is kept exactly as sent.' });
    }
    const text = String(body.text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) return sendJson(res, 400, { error: 'The letter is empty.' });
    if (text.length > MAX_JOB_LETTER_CHARS) return sendJson(res, 413, { error: 'The letter is too long.' });
    const quality = assessLetter(text, { company: job.company ?? '', title: job.title ?? '' });
    const blocker = quality.issues.find((i) => i.level === 'block');
    if (blocker) return sendJson(res, 400, { error: `${blocker.message} It would be sent to the employer as written.` });
    writeFileAtomic(file, `${text}\n`, 'utf8');
    // The Word copy follows the text; best effort (Python is optional).
    const docxPath = file.replace(/\.txt$/i, '.docx');
    let docx = null;
    if (existsSync(docxPath) && ctx.deps?.writeLetterDocxFn !== false) {
      try { docx = await (ctx.deps?.writeLetterDocxFn ?? writeLetterDocx)({ text, path: docxPath, root, deps: ctx.deps ?? {} }); }
      catch (err) { ctx.logger?.warn?.(`edited cover letter .docx not refreshed: ${err.message}`); }
    }
    let version = null;
    if (folder) {
      try {
        version = recordVersion(folder, {
          cause: 'edited', now: ctx.nowDate?.() ?? new Date(),
          files: { resume: job.resume_docx_path ?? null, resumePdf: job.resume_pdf_path ?? null, letter: file, letterDocx: docx },
        });
      } catch (err) { ctx.logger?.warn?.(`edited letter version not recorded: ${err.message}`); }
    }
    const needsReapproval = sendBackToReview(ctx, jobId);
    ctx.db.insertEvent?.({
      id: randomUUID(), job_id: jobId, event_type: 'cover_letter_edited',
      message: `cover letter edited by you (${quality.words} words)`, metadata: JSON.stringify({ words: quality.words }),
    });
    return sendJson(res, 200, { saved: true, quality, version: version?.n ?? null, needsReapproval });
  }
  if (action === 'letter-draft' && req.method === 'POST') {
    await readBody(req);
    return sendJson(res, 200, { jobId, ...draftFor(ctx, job, readMasterLetterText(root)) });
  }
  if (action === 'resume-diff' && req.method === 'GET') {
    const tailoredPath = job.resume_docx_path;
    const masterPath = masterResumeFile(root);
    if (!tailoredPath || !existsSync(tailoredPath)) {
      return sendJson(res, 409, { error: 'This job has no tailored resume yet. Prepare it first.' });
    }
    if (!existsSync(masterPath)) return sendJson(res, 409, { error: 'There is no master resume to compare with.' });
    assertInsideDirectory(root, tailoredPath, 'resume path escapes the Job Agent workspace');
    const masterBytes = readFileSync(masterPath);
    const packet = loadPacketFile(job.application_packet_path);
    const changes = packet?.tailoring?.changes ?? [];
    const omitted = changes.find((c) => c.type === 'fit_to_page_budget')?.evidence?.[0]?.omitted ?? [];
    const rewrites = changes.filter((c) => c.type === 'rewrite' && c.before && c.after).map((c) => ({ before: c.before, after: c.after }));
    const keep = keptBulletsFor(ctx.db, jobId);
    const result = diffResume({
      master: extractDocxText(masterBytes).paragraphs,
      tailored: extractDocxText(readFileSync(tailoredPath)).paragraphs,
      omitted, rewrites, keep,
    });
    const fingerprint = createHash('sha1').update(masterBytes).digest('hex').slice(0, 16);
    const tailoredFrom = packet?.owner?.resumeFingerprint ?? null;
    return sendJson(res, 200, {
      jobId, company: job.company, title: job.title, ...result, keep,
      masterChanged: Boolean(tailoredFrom && tailoredFrom !== fingerprint),
      pages: packet?.tailoring?.pageCount ?? null,
      estimatedPages: packet?.tailoring?.estimatedPages ?? null,
    });
  }
  if (action === 'keep-bullets' && req.method === 'POST') {
    const body = await readBody(req, 200_000);
    return sendJson(res, 200, setKeptBullets(ctx.db, jobId, body.bullets));
  }
  return NOT_HANDLED;
}
