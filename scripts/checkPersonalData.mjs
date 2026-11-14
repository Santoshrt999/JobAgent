#!/usr/bin/env node
/**
 * Fail when personal data could be (or could become) public.
 *
 *  1. HISTORY: no commit reachable from any ref may ever have touched a
 *     personal-data path (the real profile, answers, letter settings, master
 *     resume). Gitignore stops new adds; this catches a forced add, a rename,
 *     or history imported from somewhere else.
 *  2. TRACKED CONTENT (optional): when PERSONAL_DATA_DENYLIST is set (a CI
 *     secret: one value per line, such as a real name, phone, street or email),
 *     no tracked text file may contain any of those values, case-insensitive.
 *     The values are never printed: a hit reports the file and the denylist
 *     line NUMBER only.
 *
 * Usage: node scripts/checkPersonalData.mjs [--history-only]
 * Needs full history in CI (actions/checkout with fetch-depth: 0).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Paths that hold the owner's real data and must never be committed. */
export const PERSONAL_PATHS = [
  /^config\/candidate\.json$/,
  /^config\/screening_answers\.json$/,
  /^config\/cover_letter\.json$/,
  /^config\/profiles\/(?!README|\.gitkeep|.*\.example\.)[^/]+$/,
  /^resumes\/base\/MASTER_RESUME\.docx$/,
  /^\.env$/,
  /^data\/.*\.db(-wal|-shm)?$/,
  /^exports\//,
  /\.jobagent$/,
];

/** Which of these paths are personal-data paths? */
export function personalPaths(paths) {
  return [...new Set(paths.filter((p) => PERSONAL_PATHS.some((re) => re.test(p))))].sort();
}

/**
 * Denylist hits in some text, as 1-based denylist line numbers. Values shorter
 * than 4 characters are ignored (too many false hits).
 * @param {string} text
 * @param {string[]} denylist
 */
export function denylistHits(text, denylist) {
  const haystack = String(text).toLowerCase();
  const hits = [];
  denylist.forEach((value, index) => {
    const needle = String(value).trim().toLowerCase();
    if (needle.length >= 4 && haystack.includes(needle)) hits.push(index + 1);
  });
  return hits;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main(argv) {
  const problems = [];

  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  if (shallow) problems.push('history check needs full history (checkout with fetch-depth: 0)');
  const everPaths = git(['log', '--all', '--name-only', '--format=']).split('\n').map((s) => s.trim()).filter(Boolean);
  for (const p of personalPaths(everPaths)) problems.push(`personal-data path in history: ${p}`);

  const raw = process.env.PERSONAL_DATA_DENYLIST ?? '';
  const denylist = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!argv.includes('--history-only') && denylist.length) {
    const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
    for (const file of files) {
      let text;
      try { text = readFileSync(file); } catch { continue; }
      if (text.includes(0)) continue; // binary
      const hits = denylistHits(text.toString('utf8'), denylist);
      if (hits.length) problems.push(`${file}: contains denylisted value(s) on denylist line(s) ${hits.join(', ')}`);
    }
  }

  if (problems.length) {
    console.error('Personal-data check FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Personal-data check passed (${everPaths.length} path entries in history${denylist.length ? `, ${denylist.length} denylisted values` : ', no denylist set'}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
