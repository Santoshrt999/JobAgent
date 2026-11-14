/**
 * Unanswered-question queue — the auto-apply learning loop.
 *
 * When a live application form asks something the screening matcher cannot
 * answer with confidence, the runner refuses to guess: it records the question
 * and stops for the human. Until now that was the end of it — you answered the
 * question by hand in the open browser and the answer was thrown away, so the
 * next employer asking the same thing blocked the run all over again.
 *
 * This store keeps every question the runner could not answer, deduplicated by
 * its normalized text, together with the jobs that asked it and how often. The
 * dashboard turns that queue into "answer it once": the answer is written into
 * config/screening_answers.json (the ONE file the filler reads), and every
 * future application fills it automatically. Coverage therefore only grows.
 *
 * This module stores QUESTIONS, never answers. Nothing here can cause a value
 * to be typed into a form — that remains the validated screening-answers
 * config's job, so every truthfulness guard still applies.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { workspacePaths } from '../profile/workspace.js';
import { normalizeText, slugify } from '../utils/textNormalize.js';
import { STOPWORDS } from './screeningQA.js';

/** On-disk format version, so a future migration can recognize old files. */
export const QUEUE_VERSION = 1;

/** Questions kept in total. Beyond this, resolved ones are dropped first. */
const MAX_QUESTIONS = 300;

/** Example jobs remembered per question — enough to recognize it, not a log. */
const MAX_JOBS_PER_QUESTION = 5;

/** A form label is a question, not a document. Longer text is truncated. */
const MAX_LABEL_CHARS = 300;

/** Choice lists are shown to help you answer; an ATS never needs more. */
const MAX_OPTIONS = 24;

/** Longest suggested short pattern, in words. */
const MAX_SHORT_PATTERN_WORDS = 5;

/**
 * Words that make a phrase a QUESTION rather than a subject, dropped when
 * suggesting a pattern. They are deliberately NOT added to the matcher's own
 * stopword list — that would change how every existing answer scores. Here they
 * only affect which phrase is proposed.
 *
 * Without this, "How many years of Python experience do you have?" proposed
 * "how many years", which is both generic and already claimed by the shipped
 * `years_experience` entry — a new answer built on it would fight an existing
 * one for every question about duration.
 */
const QUESTION_WORDS = new Set([
  'how', 'what', 'which', 'when', 'where', 'who', 'whom', 'whose', 'why',
  'please', 'kindly', 'tell', 'enter', 'provide', 'select', 'indicate',
  'specify', 'choose', 'confirm', 'list', 'describe',
]);

/**
 * The ACTIVE PERSON's queue file. Each workspace owns one: a shared file showed
 * one candidate's unanswered employer questions (companies, job links) in the
 * next candidate's Application profile. The original workspace keeps the
 * original path, data/question_queue.json.
 *
 * @returns {string} absolute path of the queue file for a project root
 */
export function questionQueuePath(root) {
  return join(workspacePaths(root).dataDir, 'question_queue.json');
}

/**
 * Stable identity for a question across employers: its normalized text with
 * punctuation and casing removed, so "Do you require sponsorship?" and
 * "Do you require sponsorship" are the same question.
 *
 * @param {unknown} label
 * @returns {string} '' when the label carries no words
 */
export function questionKey(label) {
  return normalizeText(label)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

/** Trim a label to a single clean line, bounded. */
function cleanLabel(label) {
  return String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
}

/**
 * WHAT KIND OF QUESTION THIS IS (audit follow-up, 2026-11-13).
 *
 * Three kinds of entry reached the queue that must never be offered as "answer
 * once, used on every application":
 *
 *  - NOISE. Labels that are not questions at all: a control's placeholder
 *    ("Search", "Select..."), its role ("textbox"), site chrome ("Display
 *    language"), or a generated field id ("z0v_CCXsxi"). Older fills recorded
 *    them before the label fixes; they are hidden, never counted, never
 *    recorded again.
 *  - EMPLOYER. The true answer depends on the employer or the posting: "Have
 *    you ever been employed by this company?", "Were you referred by a current
 *    employee?", "Why are you a good fit for this role?", or one that names the
 *    employer. A saved "No" would be typed onto EVERY employer's form,
 *    including one the person did work for — an untrue statement on an
 *    application. They are shown, but answered on each form, never saved.
 *  - VOLUNTARY. Self-identification (gender, race, veteran, disability):
 *    optional everywhere, grouped and labelled so.
 *
 * Everything else is GENERAL: answer it once.
 *
 * @param {unknown} label the question as the form wrote it
 * @param {{companies?: string[]}} [context] employers whose forms asked it
 * @returns {'noise'|'employer'|'voluntary'|'general'}
 */
export function questionKind(label, { companies = [] } = {}) {
  const text = cleanLabel(label);
  const lower = text.toLowerCase();
  if (!/[a-z]{2}/i.test(text) || text.length < 3) return 'noise';
  if (NOISE_LABELS.has(lower.replace(/[.…:*\s]+$/, ''))) return 'noise';
  // A generated id: one token with digits or underscores, nothing a person reads.
  if (!/\s/.test(text) && text.length >= 6 && /[\d_]/.test(text)) return 'noise';

  if (EMPLOYER_RE.test(lower)) return 'employer';
  if (THIS_JOB_RE.test(lower) && JOB_CONDITION_RE.test(lower)) return 'employer';
  for (const company of companies) {
    const name = String(company ?? '').toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 4 && !GENERIC_COMPANY_WORDS.has(w));
    if (name && new RegExp(`\\b${name}\\b`).test(lower)) return 'employer';
  }
  if (VOLUNTARY_RE.test(lower)) return 'voluntary';
  return 'general';
}

const NOISE_LABELS = new Set([
  'search', 'select', 'select one', 'select an option', 'please select', 'choose', 'choose one',
  'textbox', 'text box', 'combobox', 'listbox', 'input', 'field', 'dropdown', 'type here', 'enter',
  'display language', 'language', 'answer', 'your answer', 'start typing', '--',
]);
const EMPLOYER_RE = new RegExp([
  String.raw`\b(employed|worked) (by|for|at|with) (this|our|the) (company|organi[sz]ation|employer|firm)`,
  String.raw`\bever (been )?(employed|worked) (by|for|at) (us|this)`,
  String.raw`\breferr(ed|al)\b`,
  String.raw`\bcurrent(ly)? .{0,40}\bemployees?\b`,
  String.raw`\bwhy (do|are|would|should) (you|we)\b.{0,60}\b(fit|interest|want|apply|join|hire|choose)`,
  String.raw`\bwhy (this|our) (company|role|position|team)`,
  String.raw`\b(know|related to) (anyone|someone) (who works|at|employed)`,
].join('|'));
const THIS_JOB_RE = /\bthis (role|position|job|opportunity)\b/;
// Relocation is NOT here: willingness to relocate is the person's own
// preference (the profile states it), so it stays answer-once.
const JOB_CONDITION_RE = /\b(onsite|on-site|on site|in[- ]office|office each day|commute|travel|schedule|shift|hybrid)\b/;
const VOLUNTARY_RE = /\b(gender|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(y|ies)|pronouns?|sexual orientation|transgender)\b/;
const GENERIC_COMPANY_WORDS = new Set(['services', 'service', 'group', 'holdings', 'company', 'corporation', 'insurance', 'technologies', 'solutions', 'systems', 'international', 'global']);

/**
 * Suggest `patterns` for a new screening-answer entry.
 *
 * The matcher in screeningQA scores an exact contiguous phrase highest, and
 * falls back to "every content word present" (minimum two). So the two useful
 * suggestions are the whole question — which will always re-match this exact
 * wording — and the most DISTINCTIVE phrase in it, which generalizes to other
 * employers asking the same thing in different words.
 *
 * Distinctiveness is scored by total word length, not by run length. The longest
 * run is usually the most generic part of the sentence: in "How many years of
 * Python experience do you have?" it is "how many years", which says nothing
 * about the subject and collides with any other duration question. Long words
 * ("Databricks", "certifications") are what identify a question.
 *
 * Trailing punctuation is stripped deliberately: the matcher wraps a pattern in
 * word boundaries, and a pattern ending in "?" can never match anything.
 *
 * @param {unknown} label
 * @returns {string[]} 1–2 suggested patterns, whole question first
 */
export function suggestPatterns(label) {
  const full = normalizeText(label).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').trim();
  if (!full) return [];

  const runs = [];
  let run = [];
  for (const token of full.split(' ')) {
    const word = token.replace(/[^a-z0-9]/g, '');
    if (!word || STOPWORDS.has(word) || QUESTION_WORDS.has(word)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push(word);
  }
  if (run.length) runs.push(run);

  const weight = (words) => words.reduce((sum, w) => sum + w.length, 0);
  const best = runs
    .filter((words) => words.length >= 2)
    .sort((a, b) => weight(b) - weight(a) || b.length - a.length)[0] ?? [];

  const short = best.slice(0, MAX_SHORT_PATTERN_WORDS).join(' ');
  const out = [full];
  if (short && short !== full) out.push(short);
  return out;
}

/** Suggest a stable id for a new screening-answer entry. */
export function suggestAnswerId(label) {
  const [, short] = suggestPatterns(label);
  return slugify(short || label, 40);
}

/**
 * Read the queue. A missing file is an empty queue (the normal first-run case).
 *
 * A file that exists but cannot be parsed is NOT silently treated as empty —
 * that would quietly discard every question you have collected. The error is
 * returned so the dashboard can say so instead of showing a reassuring zero.
 *
 * @param {string} root project root
 * @returns {{version: number, questions: object[], error?: string}}
 */
export function loadQuestionQueue(root) {
  const path = questionQueuePath(root);
  if (!existsSync(path)) return { version: QUEUE_VERSION, questions: [] };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { version: QUEUE_VERSION, questions: [], error: `queue unreadable: ${err.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    return { version: Number(parsed?.version) || QUEUE_VERSION, questions };
  } catch (err) {
    return {
      version: QUEUE_VERSION,
      questions: [],
      error: `queue file is not valid JSON (${err.message}) — it was left untouched at ${path}`,
    };
  }
}

/**
 * Persist the queue atomically, applying the size cap.
 *
 * @param {string} root
 * @param {{questions: object[]}} queue
 * @returns {{path: string, total: number}}
 */
export function saveQuestionQueue(root, queue) {
  const questions = capQuestions(queue?.questions ?? []);
  const path = questionQueuePath(root);
  writeFileAtomic(path, `${JSON.stringify({ version: QUEUE_VERSION, questions }, null, 2)}\n`);
  return { path, total: questions.length };
}

/**
 * Drop the least valuable questions once the cap is exceeded: resolved ones
 * first (they are already covered by the config), then the ones seen least
 * recently. Open questions are what the human still has to act on, so they are
 * the last thing discarded.
 */
function capQuestions(questions) {
  if (questions.length <= MAX_QUESTIONS) return questions;
  const rank = (q) => (q.status === 'open' ? 0 : 1);
  return [...questions]
    .sort((a, b) => rank(a) - rank(b)
      || String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')))
    .slice(0, MAX_QUESTIONS);
}

/**
 * Merge the questions one assist run could not answer into the queue.
 *
 * Re-seeing a question does not resurrect an answered one: if you have already
 * written a screening answer for it and the runner still could not match it,
 * that is a pattern problem, and the entry is reopened with a note rather than
 * silently counted again.
 *
 * @param {string} root project root
 * @param {object} args
 * @param {string} args.jobId
 * @param {string|null} [args.company]
 * @param {string|null} [args.title]
 * @param {string|null} [args.url]
 * @param {string|null} [args.ats]
 * @param {Array<{label: string, required?: boolean, kind?: string, options?: object[]}>} args.questions
 * @param {Date} [args.now]
 * @returns {{added: number, updated: number, reopened: number, total: number, path: string|null}}
 */
export function recordUnansweredQuestions(root, {
  jobId, company = null, title = null, url = null, ats = null, questions = [], now = new Date(),
} = {}) {
  if (!root || !Array.isArray(questions) || questions.length === 0) {
    return { added: 0, updated: 0, reopened: 0, total: 0, path: null };
  }
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const queue = loadQuestionQueue(root);
  // A corrupt file must never be overwritten by a merge — that would destroy
  // whatever is still recoverable in it.
  if (queue.error) return { added: 0, updated: 0, reopened: 0, total: 0, path: null, error: queue.error };

  const byKey = new Map(queue.questions.map((q) => [q.key, q]));
  let added = 0;
  let updated = 0;
  let reopened = 0;

  for (const raw of questions) {
    const label = cleanLabel(raw?.label ?? raw);
    const key = questionKey(label);
    if (!key) continue;
    if (questionKind(label) === 'noise') continue; // not a question: never queued

    const sighting = { jobId, company, title, url, ats, at };
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        label,
        required: raw?.required === true,
        kind: raw?.kind ?? null,
        options: normalizeOptions(raw?.options),
        status: 'open',
        seenCount: 0,
        firstSeenAt: at,
        lastSeenAt: at,
        jobs: [],
        answeredWith: null,
      };
      byKey.set(key, entry);
      queue.questions.push(entry);
      added += 1;
    } else if (entry.status === 'answered') {
      // Already answered in config yet asked again and still unmatched — the
      // stored patterns do not cover this wording.
      entry.status = 'open';
      entry.note = 'asked again after you answered it — the saved patterns did not match this wording';
      reopened += 1;
    } else {
      updated += 1;
    }

    entry.label = label || entry.label;
    entry.required = entry.required || raw?.required === true;
    entry.kind = raw?.kind ?? entry.kind;
    if (!entry.options?.length) entry.options = normalizeOptions(raw?.options);
    entry.seenCount = Number(entry.seenCount ?? 0) + 1;
    entry.lastSeenAt = at;
    entry.jobs = [sighting, ...(entry.jobs ?? []).filter((j) => j.jobId !== jobId)]
      .slice(0, MAX_JOBS_PER_QUESTION);
  }

  const saved = saveQuestionQueue(root, queue);
  return { added, updated, reopened, total: saved.total, path: saved.path };
}

/** Normalize a scanned field's option list to `{value, label}` pairs, bounded. */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (typeof o === 'string'
      ? { value: o, label: o }
      : { value: String(o?.value ?? ''), label: String(o?.label ?? o?.value ?? '') }))
    .filter((o) => o.label)
    .slice(0, MAX_OPTIONS);
}

/**
 * Mark a question resolved by a screening-answer entry.
 *
 * @param {string} root
 * @param {string} key questionKey
 * @param {{answerId?: string, now?: Date}} [options]
 * @returns {{ok: boolean, reason?: string}}
 */
export function markQuestionAnswered(root, key, { answerId = null, now = new Date() } = {}) {
  return updateQuestion(root, key, (entry) => {
    entry.status = 'answered';
    entry.answeredWith = { id: answerId, at: (now instanceof Date ? now : new Date(now)).toISOString() };
    delete entry.note;
  });
}

/**
 * Dismiss a question: you will keep answering it by hand. It stays in the file
 * (so it is not re-added on every run) but leaves the "waiting on you" list.
 *
 * @param {string} root
 * @param {string} key
 * @param {{now?: Date}} [options]
 */
export function dismissQuestion(root, key, { now = new Date() } = {}) {
  return updateQuestion(root, key, (entry) => {
    entry.status = 'dismissed';
    entry.dismissedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  });
}

/** Reopen a dismissed/answered question so it shows up as work again. */
export function reopenQuestion(root, key) {
  return updateQuestion(root, key, (entry) => {
    entry.status = 'open';
    delete entry.dismissedAt;
  });
}

function updateQuestion(root, key, mutate) {
  if (!root) return { ok: false, reason: 'no project root configured' };
  const queue = loadQuestionQueue(root);
  if (queue.error) return { ok: false, reason: queue.error };
  const entry = queue.questions.find((q) => q.key === key);
  if (!entry) return { ok: false, reason: 'that question is no longer in the queue' };
  mutate(entry);
  saveQuestionQueue(root, queue);
  return { ok: true };
}

/**
 * Queue summary for the dashboard: open questions first (required before
 * optional, then most-asked), followed by everything already resolved.
 *
 * @param {string} root
 * @returns {{open: object[], resolved: object[], openCount: number, requiredCount: number, error?: string}}
 */
export function summarizeQuestionQueue(root) {
  if (!root) return { open: [], resolved: [], openCount: 0, requiredCount: 0 };
  const queue = loadQuestionQueue(root);
  if (queue.error) return { open: [], resolved: [], openCount: 0, requiredCount: 0, error: queue.error };

  const kindOf = (q) => questionKind(q.label, { companies: (q.jobs ?? []).map((j) => j.company) });
  const open = queue.questions
    .filter((q) => q.status === 'open')
    .map((q) => ({ ...q, kind: kindOf(q) }))
    .filter((q) => q.kind !== 'noise')
    .sort((a, b) => Number(b.required === true) - Number(a.required === true)
      || Number(b.seenCount ?? 0) - Number(a.seenCount ?? 0)
      || String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));
  const resolved = queue.questions
    .filter((q) => q.status !== 'open')
    .sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));

  // Counts cover what the person can answer ONCE; employer-specific
  // questions are answered on each form and counted apart.
  const answerable = open.filter((q) => q.kind !== 'employer');
  return {
    open,
    resolved,
    openCount: answerable.length,
    requiredCount: answerable.filter((q) => q.required === true).length,
    employerCount: open.length - answerable.length,
  };
}
