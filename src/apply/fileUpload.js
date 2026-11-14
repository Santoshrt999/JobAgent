/**
 * File upload planner.
 *
 * Validates that the resume (and optional cover letter) files exist and builds a
 * deterministic upload plan. It does not perform any network upload or form
 * submission — it only prepares and verifies the artifacts an upload step would
 * use, surfacing missing files as blockers.
 */

import { existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

/** Resume-grade documents must be a real document format. */
const RESUME_EXTENSIONS = new Set(['.pdf', '.docx', '.doc']);
/** Cover letters may also be plain text (often pasted into a field). */
const COVER_LETTER_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt']);

/**
 * @param {object} files
 * @param {string} files.resumePath required tailored resume path
 * @param {string} [files.coverLetterPath] optional cover letter file path
 * @returns {{
 *   uploads: Array<{type: string, path: string, name: string, sizeBytes: number}>,
 *   blockers: string[],
 *   ready: boolean
 * }}
 */
export function buildUploadPlan({ resumePath, coverLetterPath } = {}) {
  const uploads = [];
  const blockers = [];

  validate('resume', resumePath, true, RESUME_EXTENSIONS, uploads, blockers);
  if (coverLetterPath) {
    validate('coverLetter', coverLetterPath, false, COVER_LETTER_EXTENSIONS, uploads, blockers);
  }

  return { uploads, blockers, ready: blockers.length === 0 && uploads.length > 0 };
}

function validate(type, path, required, allowed, uploads, blockers) {
  if (!path) {
    if (required) blockers.push(`${type}: no file path provided`);
    return;
  }
  if (!existsSync(path)) {
    blockers.push(`${type}: file not found at ${path}`);
    return;
  }
  const ext = extname(path).toLowerCase();
  if (!allowed.has(ext)) {
    blockers.push(`${type}: unsupported file type ${ext}`);
    return;
  }
  const { size } = statSync(path);
  if (size === 0) {
    blockers.push(`${type}: file is empty`);
    return;
  }
  uploads.push({ type, path, name: basename(path), sizeBytes: size });
}

/** Formats a document is rendered in, in the order a form should prefer them. */
const DOCUMENT_FORMATS = ['.pdf', '.docx', '.doc', '.rtf', '.txt'];

/**
 * The same document in every format it exists in: the path itself first, then
 * siblings with the SAME stem in another document format, e.g.
 * `..._Cover_Letter_X.txt` -> [`.txt`, `.pdf`?, `.docx`].
 *
 * The packet writes each document under one stem in several formats (see
 * outputPaths), so a same-stem sibling is that document, not another one. A
 * form that accepts only .doc/.docx/.pdf (Rippling) then gets the .docx cover
 * letter instead of the .txt it rejects (2026-11-12, a Rippling posting).
 *
 * @param {string} path
 * @param {{fileExists?: (p: string) => boolean}} [deps]
 * @returns {string[]} existing paths, `path` first
 */
export function documentFormats(path, { fileExists = existsSync } = {}) {
  if (!path) return [];
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  const out = [path];
  for (const format of DOCUMENT_FORMATS) {
    if (format === ext.toLowerCase()) continue;
    const candidate = `${stem}${format}`;
    try { if (fileExists(candidate)) out.push(candidate); } catch { /* unreadable: skip */ }
  }
  return out;
}

export { RESUME_EXTENSIONS, COVER_LETTER_EXTENSIONS };
