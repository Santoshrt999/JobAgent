/**
 * Version history for one application's documents (P2-2).
 *
 * Every time an application is prepared, its tailored resume (DOCX and PDF)
 * and cover letter (TXT and DOCX) are copied into the job's folder:
 *
 *   <job folder>/versions/manifest.json
 *   <job folder>/versions/<n>-<cause>/<the files>
 *
 * A version records when, why (generated, restored), each file's sha256, and
 * which LLM task (if any) wrote it. Identical documents are not recorded twice.
 * Restoring copies a version back over the current documents and records that
 * as a new version, so history only ever grows. When the application is
 * submitted, its versions are frozen: the submitted documents can no longer be
 * replaced, which keeps a true record of what was sent.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { extractDocxText } from '../resume/docxText.js';

const KINDS = ['resume', 'resumePdf', 'letter', 'letterDocx'];

const manifestPath = (folder) => join(folder, 'versions', 'manifest.json');

export function readManifest(folder) {
  try {
    const doc = JSON.parse(readFileSync(manifestPath(folder), 'utf8'));
    return Array.isArray(doc?.versions) ? doc : { versions: [] };
  } catch {
    return { versions: [] };
  }
}

function writeManifest(folder, manifest) {
  mkdirSync(join(folder, 'versions'), { recursive: true });
  writeFileAtomic(manifestPath(folder), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The versions of a job folder, oldest first. */
export function listVersions(folder) {
  return folder ? readManifest(folder).versions : [];
}

/**
 * Record the current documents as a new version.
 * @param {string} folder the job's output folder
 * @param {{ cause: string, files: Record<string, string|null>, task?: string|null, now?: Date }} args
 * @returns {object|null} the version (the previous one when nothing changed)
 */
export function recordVersion(folder, { cause, files, task = null, now = new Date() }) {
  if (!folder) return null;
  const present = Object.fromEntries(KINDS
    .filter((k) => files?.[k] && existsSync(files[k]))
    .map((k) => [k, files[k]]));
  if (!Object.keys(present).length) return null;
  const hashes = Object.fromEntries(Object.entries(present).map(([k, p]) => [k, sha(p)]));
  const manifest = readManifest(folder);
  const last = manifest.versions[manifest.versions.length - 1];
  if (last && JSON.stringify(last.hashes) === JSON.stringify(hashes)) return last;
  const n = (last?.n ?? 0) + 1;
  const dirName = `${n}-${String(cause).replace(/[^a-z-]/gi, '')}`;
  const dir = join(folder, 'versions', dirName);
  mkdirSync(dir, { recursive: true });
  const stored = {};
  for (const [kind, path] of Object.entries(present)) {
    const name = basename(path);
    copyFileSync(path, join(dir, name));
    stored[kind] = name;
  }
  const version = { n, cause, at: now.toISOString(), dir: dirName, files: stored, hashes, task, frozen: Boolean(last?.frozen) };
  manifest.versions.push(version);
  writeManifest(folder, manifest);
  return version;
}

/** Freeze every version: called once the application is submitted. */
export function freezeVersions(folder, { reason = 'submitted', now = new Date() } = {}) {
  if (!folder) return false;
  const manifest = readManifest(folder);
  if (!manifest.versions.length) return false;
  for (const v of manifest.versions) v.frozen = true;
  manifest.frozenAt = now.toISOString();
  manifest.frozenBecause = reason;
  writeManifest(folder, manifest);
  return true;
}

/**
 * Undo a freeze: the person said the submission did not go through, so the
 * documents were not sent after all and may be changed again.
 * @returns {boolean} true when a freeze was removed
 */
export function unfreezeVersions(folder) {
  if (!folder) return false;
  const manifest = readManifest(folder);
  if (!manifest.frozenAt) return false;
  for (const v of manifest.versions) delete v.frozen;
  delete manifest.frozenAt;
  delete manifest.frozenBecause;
  writeManifest(folder, manifest);
  return true;
}

/**
 * Put version `n` back as the current documents, recorded as a new version.
 * @param {string} folder
 * @param {number} n
 * @param {Record<string, string|null>} current the current document paths by kind
 */
export function restoreVersion(folder, n, current, { now = new Date() } = {}) {
  const manifest = readManifest(folder);
  if (manifest.frozenAt) {
    throw Object.assign(new Error('This application was submitted, so its documents are frozen as sent.'), { statusCode: 409 });
  }
  const version = manifest.versions.find((v) => v.n === Number(n));
  if (!version) throw Object.assign(new Error(`There is no version ${n}.`), { statusCode: 404 });
  for (const [kind, name] of Object.entries(version.files)) {
    const target = current?.[kind];
    if (!target) continue;
    copyFileSync(join(folder, 'versions', version.dir, name), target);
  }
  // A PDF that was not part of the version no longer matches the DOCX.
  if (!version.files.resumePdf && current?.resumePdf) rmSync(current.resumePdf, { force: true });
  // Likewise a Word letter newer than the restored text: leaving it would put
  // two different letters on disk under one name (the caller may regenerate it).
  if (version.files.letter && !version.files.letterDocx && current?.letterDocx) rmSync(current.letterDocx, { force: true });
  return recordVersion(folder, { cause: 'restored', files: current, task: version.task, now });
}

/** The resume text of version `n`, paragraph by paragraph (for diffs). */
export function versionText(folder, n) {
  const version = readManifest(folder).versions.find((v) => v.n === Number(n));
  if (!version) throw Object.assign(new Error(`There is no version ${n}.`), { statusCode: 404 });
  const name = version.files.resume;
  if (!name) return { n: version.n, paragraphs: [] };
  const { paragraphs } = extractDocxText(readFileSync(join(folder, 'versions', version.dir, name)));
  return { n: version.n, paragraphs };
}
