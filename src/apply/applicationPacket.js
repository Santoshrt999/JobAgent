/**
 * Application packet builder (Section 5/7).
 *
 * Aggregates everything needed to apply to one job into a single, reviewable
 * packet: the job, its score/tier, the tailored resume + cover letter paths, the
 * screening/prefill plan, the file-upload plan, the detected ATS, and the
 * platform-specific fill plan.
 *
 * A packet is NEVER submit-ready on creation. `submitReady` stays false until a
 * human approves it AND the runtime is explicitly in live-submit mode. Building a
 * packet performs no network activity and submits nothing.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { join } from 'node:path';

import { detectAts } from './atsDetector.js';
import { getPlatform } from './platforms/index.js';
import { buildPrefillPlan } from './formPrefill.js';
import { buildUploadPlan } from './fileUpload.js';
import { nowIso } from '../utils/dates.js';
import { assertNoTemplateTokens, findTemplateTokens, isPlaceholderValue } from '../config/placeholders.js';
import { candidatePrefix } from '../utils/outputPaths.js';
import { masterResumeFile } from '../profile/workspace.js';

/**
 * Who a packet belongs to.
 *
 * WHY A PACKET NEEDS AN OWNER. There is one master resume, one job store and
 * one approvals table, and packets carried nothing identifying the candidate
 * they were built for. So after switching profiles, "Auto-fill" reused an
 * existing approval and packet without ever asking whose they were: the new
 * candidate's application was filled from documents, screening answers and a
 * cover letter prepared for the previous one.
 *
 * The stamp is deliberately more than a name. Two profiles can describe the
 * same person searching in two directions, with different target roles,
 * screening answers and tailored resumes, so identity alone would wave through
 * a packet built under different search intent.
 *
 * @param {object} [config] loadConfig() bundle
 * @returns {{profileId: string|null, profileLabel: string|null, candidateName: string,
 *            candidateEmail: string, resumeFingerprint: string|null}}
 */
export function packetOwner(config = {}) {
  const identity = config.candidate?.identity ?? {};
  return {
    profileId: config.profile?.id ?? null,
    profileLabel: config.profile?.label ?? null,
    candidateName: String(identity.fullName ?? '').trim(),
    candidateEmail: String(config.candidate?.contact?.email ?? '').trim().toLowerCase(),
    resumeFingerprint: config.resumeFingerprint ?? null,
  };
}

/** Compare two owner-ish values the way a human would: trimmed, case-insensitive. */
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Content hash of the master resume, the same provenance marker the pipeline
 * stamps onto `owner.resumeFingerprint` when it builds a packet.
 *
 * @param {string|undefined} root project root
 * @returns {string|null} null when there is no readable master resume
 */
export function masterResumeFingerprint(root) {
  try {
    if (!root) return null;
    const master = masterResumeFile(root);
    if (!existsSync(master)) return null;
    return createHash('sha1').update(readFileSync(master)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** Final path segment on either separator (packets written on Windows too). */
function fileBase(path) {
  return String(path ?? '').split(/[\\/]/).pop();
}

/** Largest legacy cover letter we will read to look for template text. */
const MAX_LEGACY_TEXT_BYTES = 64 * 1024;

/**
 * Template text left in a legacy packet's plain-text cover letter, or null.
 * Cheap and best-effort: only a small .txt is read; anything else is skipped.
 */
function legacyArtifactProblem(packet, readText) {
  const path = packet?.coverLetterPath;
  if (!path || !/\.txt$/i.test(path)) return null;
  const text = readText(path);
  if (typeof text !== 'string') return null;
  const tokens = findTemplateTokens(text);
  if (tokens.length) return `its cover letter still contains template placeholders (${tokens.join(', ')})`;
  const templated = text.split(/\r?\n/).map((l) => l.trim()).find((l) => isPlaceholderValue(l));
  return templated ? `its cover letter still contains template text ("${templated.slice(0, 60)}")` : null;
}

function defaultReadText(path) {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_LEGACY_TEXT_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Can a packet with NO recorded owner be shown to belong to this candidate?
 *
 * It used to be "unknown-but-usable": the fallback compared
 * `packet.candidateName`, a field no packet has ever been written with, so
 * every legacy packet passed — including ones built from the shipped example
 * profile for "Jane Doe". The rule is now fail-closed: a legacy packet is the
 * active candidate's only when every document it would upload is named for
 * them (`<First>_<Last>_Resume_…`, the prefix the pipeline has always written),
 * and its cover letter carries no template text.
 */
function legacyOwnershipCheck(packet, current, readText) {
  // Nothing to compare against (no candidate configured): there is no second
  // person this packet could be leaking to, and preflight refuses such a
  // config long before any application opens.
  if (!current.candidateName) return { ok: true, reason: null };
  const named = String(packet?.candidateName ?? '').trim();
  if (named && !sameText(named, current.candidateName)) {
    return { ok: false, reason: `it was prepared for ${named}, not ${current.candidateName}` };
  }
  const expected = `${candidatePrefix(current.candidateName)}_`.toLowerCase();
  const documents = [packet?.resumePath, packet?.coverLetterPath, packet?.resumePdfPath]
    .filter(Boolean).map(fileBase);
  const foreign = documents.filter((name) => !name.toLowerCase().startsWith(expected));
  if (!documents.length || foreign.length) {
    return {
      ok: false,
      reason: `it records no owner and its documents (${(foreign.length ? foreign : ['none']).join(', ')}) `
        + `are not named for ${current.candidateName}`,
    };
  }
  const templated = legacyArtifactProblem(packet, readText);
  if (templated) return { ok: false, reason: templated };
  return { ok: true, reason: null };
}

/**
 * Does this packet belong to the candidate the config currently describes?
 *
 * Returns the REASON when it does not, so the caller can tell the user which
 * mismatch it found rather than silently rebuilding. Called at every
 * chokepoint that reuses a stored packet: the runner itself, the extension
 * payload, the CLI assist/apply loops and the dashboard.
 *
 * @param {object} packet loaded application packet
 * @param {object} config loadConfig() bundle
 * @param {object} [deps]
 * @param {(root: string) => string|null} [deps.fingerprintImpl] current master-resume fingerprint
 * @param {(path: string) => string|null} [deps.readTextImpl] legacy artifact reader
 * @returns {{ok: boolean, reason: string|null}}
 */
export function packetOwnershipCheck(packet, config = {}, deps = {}) {
  const current = packetOwner(config);
  const owner = packet?.owner ?? null;
  if (!owner) return legacyOwnershipCheck(packet, current, deps.readTextImpl ?? defaultReadText);
  if (owner.candidateName && current.candidateName && !sameText(owner.candidateName, current.candidateName)) {
    return { ok: false, reason: `it was prepared for ${owner.candidateName}, not ${current.candidateName}` };
  }
  if (owner.candidateEmail && current.candidateEmail && owner.candidateEmail !== current.candidateEmail) {
    return { ok: false, reason: `it was prepared for ${owner.candidateEmail}, not ${current.candidateEmail}` };
  }
  if (owner.profileId && current.profileId && owner.profileId !== current.profileId) {
    return {
      ok: false,
      reason: `it was prepared under the "${owner.profileLabel ?? owner.profileId}" search profile, `
        + `and "${current.profileLabel ?? current.profileId}" is active now`,
    };
  }
  // WHICH CAREER HISTORY. The fingerprint was recorded as provenance and never
  // compared, so replacing MASTER_RESUME.docx with a different person's resume
  // (same name in the profile) left every stored packet "owned". When both
  // sides are known and differ, the tailored documents describe a resume that
  // is no longer the one on disk.
  if (owner.resumeFingerprint) {
    const now = current.resumeFingerprint
      ?? (deps.fingerprintImpl ?? masterResumeFingerprint)(config.root);
    if (now && now !== owner.resumeFingerprint) {
      return {
        ok: false,
        reason: 'it was tailored from a different master resume than the one on disk now',
      };
    }
  }
  return { ok: true, reason: null };
}

/**
 * @param {object} args
 * @param {object} args.job normalized job
 * @param {object} args.score scoreJob result
 * @param {string} args.tier explainScore tier
 * @param {object} args.candidate candidate config
 * @param {object} args.screeningAnswers screening config
 * @param {string} [args.resumePath] tailored resume path
 * @param {boolean} [args.resumeTailored] whether the resume was tailored (vs. master fallback)
 * @param {string|null} [args.resumeWarning] tailoring warning, if any
 * @param {object} [args.coverLetter] generateCoverLetter result
 * @param {string} [args.coverLetterPath] saved cover letter file path
 * @param {Array} [args.formFields] discovered form fields [{label, selector, choices}]
 * @param {string} [args.html] page html for ATS detection
 * @returns {object} application packet
 */
export function buildApplicationPacket({
  job, score, tier, candidate, screeningAnswers,
  resumePath, resumeTailored = false, resumeWarning = null,
  resumePdfPath = null, resumePreviewWarning = null, resumeValidation = null, atsReport = null,
  tailoring = null, owner = null,
  coverLetter, coverLetterPath, formFields = [], html = '',
}) {
  const ats = detectAts({ url: job.url, html });
  const platform = getPlatform(ats.platform);

  const prefill = buildPrefillPlan(formFields, { candidate, screeningAnswers });
  const uploads = buildUploadPlan({ resumePath, coverLetterPath });

  // Nothing addressed to an employer may carry an unfilled `{token}`: not the
  // cover letter, and not a planned form answer that will be typed into their
  // ATS verbatim. `generateCoverLetter` already refuses; this is the packet's
  // own chokepoint for any other composer or answer source.
  if (coverLetter?.generated) assertNoTemplateTokens(coverLetter.text, 'cover letter');
  for (const entry of prefill.plan) {
    assertNoTemplateTokens(entry.value, `answer for "${entry.label}"`);
  }

  const partialPacket = { job, prefill, uploads };
  const fillPlan = platform.prepare(partialPacket);

  const blockers = [...uploads.blockers];
  if (prefill.needsUser.length) {
    blockers.push(`${prefill.needsUser.length} screening field(s) need user input`);
  }
  if (resumeWarning) {
    blockers.push(`resume: ${resumeWarning}`);
  }

  // Screening answer plan: the subset of the fill plan sourced from screening
  // answers, plus the questions that still need a human. Surfaced explicitly so a
  // reviewer can audit every answer the agent intends to give.
  const screeningPlan = {
    answered: prefill.plan.filter((p) => p.source === 'screening'),
    needsUser: prefill.needsUser,
  };

  return {
    id: randomUUID(),
    createdAt: nowIso(),
    // WHOSE APPLICATION THIS IS. Read back by `packetOwnershipCheck` before any
    // path reuses a stored packet, so a packet built for one candidate can
    // never be filled onto another candidate's application. See `packetOwner`.
    owner: owner ?? {
      profileId: null,
      profileLabel: null,
      candidateName: String(candidate?.identity?.fullName ?? '').trim(),
      candidateEmail: String(candidate?.contact?.email ?? '').trim().toLowerCase(),
      resumeFingerprint: null,
    },
    job: {
      id: job.id, company: job.company, title: job.title, url: job.url,
      source: job.source, location: job.location,
    },
    jdSummary: summarizeJd(job.jdText),
    score: score?.total ?? null,
    tier: tier ?? null,
    sponsorship: score?.sponsorship ?? job.sponsorship ?? null,
    matchedKeywords: score?.matchedKeywords ?? [],
    missingKeywords: score?.missingKeywords ?? [],
    resumePath: resumePath ?? null,
    resumeTailored: Boolean(resumeTailored),
    resumeWarning: resumeWarning ?? null,
    resumePdfPath: resumePdfPath ?? null,
    // Preview conversion is best-effort and must never block an otherwise
    // valid application packet. The dashboard can retry it on demand.
    resumePreviewWarning: resumePreviewWarning ?? null,
    resumeValidation: resumeValidation ?? null,
    // Evidence-backed tailoring report: every change made to the resume for
    // THIS job (skill reorders with before/after, emphasis evidence, focus
    // line) and the JD requirements the resume does not support (never
    // inserted). This is what the human reviews before approving.
    tailoring: tailoring ?? null,
    atsReport: atsReport ?? null,
    coverLetterPath: coverLetterPath ?? null,
    coverLetterGenerated: Boolean(coverLetter?.generated),
    // The same letter as a .docx, and how it was written: from the template,
    // or grounded paragraph by paragraph in the resume (P1-3).
    coverLetterDocxPath: coverLetter?.docxPath ?? null,
    coverLetterGrounding: coverLetter?.generated ? (coverLetter.grounding ?? { mode: 'template' }) : null,
    ats,
    prefill,
    uploads,
    fillPlan,
    screeningPlan,
    blockers,
    approvalStatus: 'pending_review',
    // HARD GATE: a freshly built packet is never ready to submit. Both flags are
    // surfaced at the packet top level (not only inside fillPlan) so any consumer
    // can see the stop-before-submit guarantee without inspecting the plan.
    stopBeforeSubmit: true,
    submitReady: false,
  };
}

/** First ~600 chars of the JD as a quick reviewer summary (whitespace-collapsed). */
function summarizeJd(jdText = '', maxChars = 600) {
  const clean = String(jdText ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Persist a packet to disk as JSON and return the file path.
 * @param {object} packet
 * @param {string} dir output directory
 * @param {string} [fileName] explicit file name (defaults to `${packet.id}.json`)
 * @returns {string} written path
 */
export function writePacket(packet, dir, fileName) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName ?? `${packet.id}.json`);
  // Atomic: the dashboard reads packet JSON on demand — it must never see a
  // half-written packet.
  writeFileAtomic(path, JSON.stringify(packet, null, 2), 'utf8');
  return path;
}
