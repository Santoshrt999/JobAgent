// @ts-check
/**
 * The master cover letter: the person's own letter, in their own words, that
 * every tailored letter starts from. It is the cover-letter counterpart of the
 * master resume and lives beside it in the active person's workspace:
 *
 *   resumes/base/MASTER_COVER_LETTER.txt            (or resumes/profiles/<id>/…)
 *   resumes/base/history/MASTER_COVER_LETTER.<stamp>.txt
 *
 * Plain text on purpose: it is edited in the dashboard, diffed, and composed
 * paragraph by paragraph. A .docx, .txt or .md upload is converted to text on
 * the way in. Every save keeps the previous version, so any edit is undoable,
 * and restoring is itself a save (validated, and the version it replaces kept).
 *
 * `{company}` and `{title}` in the text are filled for each job. Bracketed
 * prompts ("[A result you are proud of]") mark a draft as unfinished: a
 * paragraph that still has one is never sent to an employer.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { extractDocxText, isDocxBuffer } from '../resume/docxText.js';
import { workspacePaths } from '../profile/workspace.js';
import { assertInsideDirectory } from '../utils/pathSafe.js';
import { writeFileAtomic } from '../utils/fsSafe.js';
import { assessLetter, countWords } from './letterQuality.js';

export const MASTER_LETTER_NAME = 'MASTER_COVER_LETTER.txt';
export const MAX_LETTER_CHARS = 20_000;
export const MAX_LETTER_UPLOAD_BYTES = 4 * 1024 * 1024;
const MIN_LETTER_WORDS = 40;
const MAX_VERSIONS = 30;
const VERSION_RE = /^MASTER_COVER_LETTER\.[0-9TZ-]+(?:-\d+)?\.txt$/;

/** @param {string} message @param {number} statusCode */
const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };

/** Where the active person's master letter and its history live. */
export function masterLetterPaths(root) {
  if (!root) fail('the master cover letter is unavailable because no project root is configured', 503);
  const ws = workspacePaths(root);
  const file = join(ws.resumeDir, MASTER_LETTER_NAME);
  assertInsideDirectory(root, file, 'master cover letter path escapes the Job Agent workspace');
  assertInsideDirectory(root, ws.history, 'master cover letter history escapes the Job Agent workspace');
  return { file, historyDir: ws.history };
}

/** Normalise line endings and spacing without touching the words. */
export function normalizeLetterText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ /g, ' ')
    .trim();
}

/** The master letter, if any, as plain text. Never throws for a missing file. */
export function readMasterLetterText(root) {
  try {
    const { file } = masterLetterPaths(root);
    return existsSync(file) ? normalizeLetterText(readFileSync(file, 'utf8')) : '';
  } catch {
    return '';
  }
}

function listVersions(historyDir) {
  /** @type {string[]} */
  let names;
  try { names = readdirSync(historyDir); } catch { return []; }
  return names
    .filter((name) => VERSION_RE.test(name))
    .map((name) => {
      try {
        const path = join(historyDir, name);
        const st = statSync(path);
        const text = readFileSync(path, 'utf8');
        return { name, bytes: st.size, modifiedAt: st.mtime.toISOString(), words: countWords(text), preview: normalizeLetterText(text).slice(0, 160) };
      } catch { return null; }
    })
    .filter((v) => v !== null)
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)) || b.name.localeCompare(a.name));
}

/**
 * Everything the dialog shows: the text, its facts, its quality read and the
 * kept versions (newest first).
 */
export function masterLetterState(root) {
  const { file, historyDir } = masterLetterPaths(root);
  const exists = existsSync(file);
  const text = exists ? normalizeLetterText(readFileSync(file, 'utf8')) : '';
  const st = exists ? statSync(file) : null;
  return {
    exists,
    path: file,
    text,
    words: countWords(text),
    modifiedAt: st ? st.mtime.toISOString() : null,
    quality: exists ? assessLetter(text, { master: true }) : null,
    versions: listVersions(historyDir),
  };
}

function backupName(historyDir, now) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let candidate = join(historyDir, `MASTER_COVER_LETTER.${stamp}.txt`);
  for (let n = 2; existsSync(candidate) && n < 100; n += 1) {
    candidate = join(historyDir, `MASTER_COVER_LETTER.${stamp}-${n}.txt`);
  }
  return candidate;
}

function prune(historyDir) {
  for (const stale of listVersions(historyDir).slice(MAX_VERSIONS)) {
    try { rmSync(join(historyDir, stale.name), { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Save new master-letter text. The version it replaces is kept first; the
 * write is atomic. Saving the same text again is a no-op.
 * @param {string} root
 * @param {string} text
 * @param {{ now?: Date }} [options]
 */
export function saveMasterLetter(root, text, { now = new Date() } = {}) {
  const clean = normalizeLetterText(text);
  if (!clean) fail('the letter is empty', 400);
  if (clean.length > MAX_LETTER_CHARS) fail(`the letter is ${clean.length} characters; the limit is ${MAX_LETTER_CHARS}`, 413);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) fail('the letter contains unreadable characters; paste it as plain text', 400);
  const words = countWords(clean);
  if (words < MIN_LETTER_WORDS) {
    fail(`only ${words} words: a master cover letter needs at least ${MIN_LETTER_WORDS}, so tailoring has something real to work from`, 422);
  }
  const { file, historyDir } = masterLetterPaths(root);
  mkdirSync(join(file, '..'), { recursive: true });
  let backup = null;
  if (existsSync(file)) {
    const current = normalizeLetterText(readFileSync(file, 'utf8'));
    if (current === clean) return { saved: false, backup: null, state: masterLetterState(root) };
    mkdirSync(historyDir, { recursive: true });
    const target = backupName(historyDir, now);
    copyFileSync(file, target);
    backup = basename(target);
    prune(historyDir);
  }
  writeFileAtomic(file, `${clean}\n`, 'utf8');
  return { saved: true, backup, state: masterLetterState(root) };
}

/** Read one kept version's text, by its bare file name. */
export function readMasterLetterVersion(root, name) {
  const { historyDir } = masterLetterPaths(root);
  const safe = basename(String(name ?? ''));
  if (!VERSION_RE.test(safe)) fail('that is not a kept cover letter version', 400);
  const path = join(historyDir, safe);
  assertInsideDirectory(historyDir, path, 'version path escapes the cover letter history');
  if (!existsSync(path)) fail(`no kept version named ${safe}`, 404);
  return { name: safe, text: normalizeLetterText(readFileSync(path, 'utf8')) };
}

/** Make a kept version current again (the current one is kept too). */
export function restoreMasterLetter(root, name, { now = new Date() } = {}) {
  const { text, name: safe } = readMasterLetterVersion(root, name);
  return { ...saveMasterLetter(root, text, { now }), restored: safe };
}

/**
 * Text from an uploaded file: .docx, .txt or .md.
 * @param {string} filename
 * @param {Buffer} bytes
 */
export function letterTextFromUpload(filename, bytes) {
  const name = String(filename ?? '');
  if (!bytes?.length) fail('the uploaded file is empty', 400);
  if (bytes.length > MAX_LETTER_UPLOAD_BYTES) fail('the file is larger than 4 MB', 413);
  if (/\.docx$/i.test(name)) {
    if (!isDocxBuffer(bytes)) fail('that file has a .docx name but is not a Word document. Save it again as .docx', 415);
    try {
      // A letter's lines are paragraphs: join them back with blank lines.
      return normalizeLetterText(extractDocxText(bytes).paragraphs.join('\n\n'));
    } catch (err) {
      return fail(`the .docx could not be read: ${/** @type {Error} */ (err).message}`, 422);
    }
  }
  if (/\.(txt|md|markdown|text)$/i.test(name)) {
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    // Markdown: keep the words, drop the markup a letter does not need.
    return normalizeLetterText(text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2'));
  }
  return fail('use a .docx, .txt or .md file', 415);
}

/**
 * A first draft to edit, built ONLY from what the profile states. Where the
 * profile cannot say something true and specific, the draft leaves a
 * bracketed prompt for the person to write; a letter that still has one is
 * never used for an application.
 * @param {any} candidate parsed candidate config
 */
export function starterLetter(candidate = {}) {
  const headline = String(candidate?.identity?.headline ?? candidate?.targetTitles?.[0] ?? '').trim();
  const years = Number(candidate?.background?.yearsExperience ?? candidate?.yearsExperience);
  const current = (candidate?.workHistory ?? []).find((w) => w?.current) ?? candidate?.workHistory?.[0];
  const highlight = (current?.highlights ?? []).find((h) => typeof h === 'string' && h.trim() && !/one-line, metric-backed/i.test(h));
  const domains = (candidate?.domainExperience ?? []).slice(0, 2).join(' and ');
  const name = String(candidate?.identity?.fullName ?? '').trim();

  const who = headline
    ? `I am a ${headline}${Number.isFinite(years) && years > 0 ? ` with ${years}+ years of experience` : ''}${domains ? ` in ${domains}` : ''}.`
    : '[One sentence on who you are professionally]';
  const result = current?.employer && highlight
    ? `At ${current.employer}, I ${highlight.charAt(0).toLowerCase()}${highlight.slice(1).replace(/\.\s*$/, '')}. [What that result made possible, in one sentence]`
    : '[Your strongest result: what you did, for whom, and the measurable outcome]';
  return [
    'Dear Hiring Team,',
    `I am applying for the {title} role at {company}. ${who} [Why this kind of work, or this company, interests you]`,
    result,
    '[A second example that shows a different strength: a project, a problem you solved, or how you work with others]',
    'I would welcome the chance to talk about how I could help {company}. Thank you for your consideration.',
    'Sincerely,',
    name || '[Your name]',
  ].join('\n\n');
}
