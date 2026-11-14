// @ts-check
/**
 * Which ATS contracts have been verified on a LIVE site, not just on local
 * fixtures (P1-11).
 *
 * Final Auto-submit clicks Submit on someone's real application. Fixture tests
 * prove the filler against saved HTML; they cannot prove a vendor's live page
 * still matches, or that its confirmation page is recognised. So Auto-submit
 * on an ATS also requires a recorded, supervised live run on that ATS:
 * an entry in config/verified_live_ats.json, added by a person after following
 * docs/LIVE_VERIFICATION.md. The file ships with an empty list, so out of the
 * box Auto-submit refuses every ATS and only assisted fill (which never
 * submits) is available.
 *
 * Shape:
 *   { "verified": [ { "ats": "greenhouse", "date": "2026-11-20",
 *                     "outcome": "filled; submitted by hand; confirmation recognised",
 *                     "verifiedBy": "initials" } ] }
 * No personal data belongs in this file: no names, emails or job ids.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_VERIFICATION_FILE = join('config', 'verified_live_ats.json');

/**
 * Parse the file's JSON into the set of verified ATS ids. Entries without a
 * real date or an ats id are ignored, so a half-written entry never counts.
 * @param {any} doc
 * @returns {Set<string>}
 */
export function verifiedAtsFrom(doc) {
  const list = Array.isArray(doc?.verified) ? doc.verified : [];
  const out = new Set();
  for (const entry of list) {
    const ats = String(entry?.ats ?? '').trim().toLowerCase();
    const date = String(entry?.date ?? '');
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`));
    if (ats && validDate && String(entry?.outcome ?? '').trim()) out.add(ats);
  }
  return out;
}

/**
 * The verified ATS ids for a project root. A missing or unreadable file is an
 * empty set: the safe answer is "nothing verified".
 * @param {string|null|undefined} root
 * @returns {Set<string>}
 */
export function loadLiveVerifiedAts(root) {
  if (!root) return new Set();
  try {
    return verifiedAtsFrom(JSON.parse(readFileSync(join(root, LIVE_VERIFICATION_FILE), 'utf8')));
  } catch {
    return new Set();
  }
}
