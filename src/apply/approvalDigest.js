/**
 * What a human approved, so a fill can tell whether it is still that.
 *
 * WHY. Approval was a row with a status and a timestamp. Everything a fill
 * actually sends was read live afterwards: the tailored resume and cover
 * letter from disk, every dynamic answer from the CURRENT screening answers,
 * every profile field from the CURRENT candidate. Measured (audit 2026-11-11,
 * R10): a packet approved with one salary answer was auto-submitted with a
 * different one, edited after approval, and reported `submitted` with nothing
 * withheld.
 *
 * WHAT. At approval a digest of each input is recorded as an
 * `application_events` row (`packet_approved`), so no schema change is needed.
 * Before a fill the same digest is computed again; any part that differs is
 * named, the approval is withdrawn, and the human approves again after looking.
 *
 * Hashes only: no answer, name, address or document text is stored.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { documentFormats } from './fileUpload.js';
import { effectiveAnswers } from './screeningQA.js';

/** Event type that records an approval and its digest. */
export const APPROVAL_EVENT = 'packet_approved';

/** Human names of each digest part, as shown in "changed since you approved". */
const PART_NAMES = Object.freeze({
  resume: 'the resume',
  coverLetter: 'the cover letter',
  answers: 'your saved screening answers',
  profile: 'your profile details',
  plan: 'the planned answers in the packet',
  formats: 'the other formats of the resume or cover letter',
  employer: 'your current employer',
});

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);

function fileHash(path) {
  if (!path) return null;
  try { return existsSync(path) ? hash(readFileSync(path)) : 'missing'; } catch { return 'unreadable'; }
}

/**
 * The digest of everything a fill of this packet would send.
 *
 * @param {object} packet application packet
 * @param {object} config loadConfig() bundle (candidate, screeningAnswers)
 * @returns {Record<string, string|null>} part -> short hash (null when absent)
 */
export function approvalDigest(packet = {}, config = {}) {
  const uploads = Array.isArray(packet?.fillPlan?.uploads) ? packet.fillPlan.uploads : [];
  const pathOf = (type) => uploads.find((u) => u?.type === type)?.path ?? null;
  const resumePath = pathOf('resume') ?? packet?.resumePath ?? null;
  const letterPath = pathOf('coverLetter') ?? packet?.coverLetterPath ?? null;

  const answers = effectiveAnswers(config?.screeningAnswers ?? {})
    .map((a) => [String(a?.id ?? ''), String(a?.answer ?? '')])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  // Exactly the candidate fields the form filler reads (formPrefill.valueForField)
  // plus the sponsorship requirement the truthfulness checks read.
  const c = config?.candidate ?? {};
  const profile = {
    identity: { fullName: c.identity?.fullName ?? null, preferredName: c.identity?.preferredName ?? null, links: c.identity?.links ?? null },
    contact: c.contact ?? null,
    location: c.location ?? null,
    sponsorship: c.workAuthorization?.requiresSponsorship ?? c.sponsorshipRequired ?? null,
    skillExperience: c.skillExperience ?? null,
  };

  const plan = (packet?.screeningPlan?.answered ?? [])
    .map((a) => [String(a?.label ?? a?.question ?? ''), String(a?.answer ?? a?.value ?? '')]);

  // The same documents in their other formats: a form that refuses the planned
  // format is sent one of these instead (uploadRunner.fileForInput).
  const formats = [resumePath, letterPath]
    .flatMap((p) => documentFormats(p).slice(1))
    .map((p) => [extname(p), fileHash(p)]);

  // The current employer, which fills a "Current company" field.
  const current = (Array.isArray(c.workHistory) ? c.workHistory : []).find((w) => w?.current === true);

  // `formats` and `employer` were added after the first digests were recorded;
  // digestChanges skips a part an older approval lacks.
  return {
    resume: fileHash(resumePath),
    coverLetter: fileHash(letterPath),
    answers: hash(JSON.stringify(answers)),
    profile: hash(JSON.stringify(profile)),
    plan: hash(JSON.stringify(plan)),
    formats: hash(JSON.stringify(formats)),
    employer: hash(JSON.stringify(current?.employer ?? null)),
  };
}

/**
 * Which parts changed between an approved digest and the current one.
 * A part absent from the approved digest (older records) is not compared.
 *
 * @param {Record<string, string|null>|null} approved
 * @param {Record<string, string|null>} current
 * @returns {string[]} human names of the changed parts, [] when unchanged
 */
export function digestChanges(approved, current) {
  if (!approved || typeof approved !== 'object') return [];
  return Object.keys(PART_NAMES)
    .filter((part) => Object.hasOwn(approved, part) && approved[part] !== current?.[part])
    .map((part) => PART_NAMES[part]);
}

/**
 * The digest recorded with the job's most recent approval, or null when the
 * approval predates digests (nothing to compare; the old behaviour applies).
 *
 * @param {object} db Database
 * @param {string} jobId
 * @returns {Record<string, string|null>|null}
 */
export function approvedDigest(db, jobId) {
  const events = typeof db?.listEvents === 'function' ? db.listEvents(jobId) : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.event_type !== APPROVAL_EVENT) continue;
    let meta = e.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    return meta?.digest ?? null;
  }
  return null;
}
