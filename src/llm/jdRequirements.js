/**
 * LLM-assisted job-description requirement extraction — GROUNDED.
 *
 * ## Why this exists
 *
 * The deterministic tailor can only recognize requirements that already appear
 * in `config/scoring.json`'s keyword vocabulary. A posting asking for
 * "dimensional modeling", "Iceberg", or "dbt exposures" surfaces nothing if
 * those terms were never listed, so the resume is never reordered to answer
 * them and they are never reported as gaps. Maintaining that vocabulary by hand
 * across every employer's phrasing does not scale.
 *
 * ## Why this is safe
 *
 * The model is used ONLY to read the job description — never to write resume
 * prose. Its entire output is a list of phrases claimed to appear in the JD,
 * and every phrase is then VERIFIED to occur literally in that JD text before
 * it is accepted. A phrase the model invented cannot survive that check, so
 * hallucination is structurally impossible rather than merely discouraged.
 *
 * Accepted phrases are handed to the EXISTING deterministic machinery, which
 * only reorders and emphasizes text already present in the master resume and
 * reports everything else as an honest gap. The model therefore cannot add,
 * reword, or overstate a single claim about the candidate.
 *
 * ## Privacy boundary
 *
 * Only the public job description and its title are sent. The resume, the
 * candidate profile, contact details, EEO answers, and salary expectations are
 * never included in a request.
 */

import { llmSettings } from './client.js';
import { runTask, SYSTEM_UNTRUSTED_RULE, untrusted } from './task.js';

/** Most requirement phrases to accept from one posting. */
const MAX_REQUIREMENTS = 40;
/** Reject absurdly long or short "phrases". */
const MIN_PHRASE_CHARS = 2;
const MAX_PHRASE_CHARS = 60;

const SYSTEM_PROMPT = [
  'You extract hiring requirements from job descriptions for a resume-matching system.',
  '',
  'Rules:',
  '1. Only output skill, technology, or qualification phrases that appear VERBATIM in the',
  '   job description text you are given. Copy them exactly as written.',
  '2. Never infer, expand, translate, or normalize a phrase. If the text says "ADF", output',
  '   "ADF" — not "Azure Data Factory".',
  '3. Classify each as "required" or "preferred" based on the heading or wording it appears',
  '   under. If genuinely unclear, use "unclassified".',
  '4. Extract concrete skills and technologies, not soft skills, benefits, company boilerplate,',
  '   equal-opportunity text, or recruiting-fraud warnings.',
  '5. Output at most 40 items.',
  '',
  '6. ' + SYSTEM_UNTRUSTED_RULE,
  '',
  'Respond with JSON only, in exactly this shape:',
  '{"requirements":[{"phrase":"<verbatim text>","importance":"required|preferred|unclassified"}]}',
].join('\n');

/**
 * The task, versioned (P1-1). Bump the version whenever the prompt or schema
 * changes: it is part of the cache key and of every result's provenance.
 * The schema is deliberately lenient (a bare string item, any importance
 * word): the grounding check below is what decides what is accepted.
 */
export const JD_REQUIREMENTS_TASK = Object.freeze({
  name: 'jd-requirements',
  version: 2,
  system: SYSTEM_PROMPT,
  maxTokens: 1600,
  effort: 'low',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['requirements'],
    properties: {
      requirements: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['phrase', 'importance'],
              properties: { phrase: { type: 'string' }, importance: { type: 'string' } },
            },
          ],
        },
      },
    },
  },
  buildUser: ({ title, jd }) => `JOB TITLE: ${String(title ?? '').slice(0, 200)}\n\n${untrusted('job_posting', jd)}`,
});

/**
 * Normalize for the grounding comparison: lowercase, collapse whitespace, and
 * flatten the punctuation variants that differ cosmetically between a JD and a
 * copied phrase (curly quotes, en/em dashes, non-breaking spaces).
 */
function groundingForm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract requirement phrases from a job description, keeping only phrases that
 * are provably present in it.
 *
 * @param {object} args
 * @param {string} args.jdText the job description body
 * @param {string} [args.title] job title (context only)
 * @param {string} [args.root] project root (enables the on-disk response cache)
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {object} [deps] { fetchImpl, settings } for tests
 * @returns {Promise<{
 *   ok: boolean,
 *   available: boolean,
 *   phrases: string[],
 *   required: string[],
 *   preferred: string[],
 *   items: Array<{phrase: string, importance: string}>,
 *   rejected: Array<{phrase: string, reason: string}>,
 *   provenance: object
 * }>}
 */
export async function extractJdRequirements({
  jdText, title = '', root = null, env = process.env,
} = {}, deps = {}) {
  const settings = deps.settings ?? llmSettings(env, { root });
  const empty = (reason, available = false) => ({
    ok: false,
    available,
    phrases: [],
    required: [],
    preferred: [],
    items: [],
    rejected: [],
    provenance: {
      source: 'llm-jd-requirements',
      enabled: settings.enabled,
      model: settings.enabled ? settings.model : null,
      skipped: reason,
      verified: 0,
      rejected: 0,
    },
  });

  const jd = String(jdText ?? '').trim();
  if (!settings.enabled) return empty(settings.reason ?? 'LLM assist disabled');
  // A stub JD cannot yield trustworthy requirements and is not worth a call.
  if (jd.length < 200) return empty('job description too short to analyze', true);

  const result = await runTask(JD_REQUIREMENTS_TASK, { title, jd }, { settings, deps });
  if (!result.ok) return empty(result.error ?? 'extraction failed', true);
  result.model = result.provenance.model;

  const raw = Array.isArray(result.data?.requirements) ? result.data.requirements : null;
  if (!raw) return empty('response did not contain a requirements array', true);

  // ── Grounding verification ────────────────────────────────────────────────
  // This is the load-bearing safety step. Every phrase must occur literally in
  // the job description; anything else is dropped and counted.
  const haystack = groundingForm(jd);
  const titleHay = groundingForm(title);
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const entry of raw) {
    const phrase = typeof entry === 'string' ? entry : entry?.phrase;
    const text = String(phrase ?? '').trim();
    const probe = groundingForm(text);

    if (!probe || probe.length < MIN_PHRASE_CHARS) {
      rejected.push({ phrase: text, reason: 'empty or too short' });
      continue;
    }
    if (probe.length > MAX_PHRASE_CHARS) {
      rejected.push({ phrase: text, reason: 'too long to be a requirement phrase' });
      continue;
    }
    if (seen.has(probe)) continue;
    // The decisive test: is it actually in the posting?
    if (!haystack.includes(probe) && !titleHay.includes(probe)) {
      rejected.push({ phrase: text, reason: 'not present in the job description' });
      continue;
    }
    seen.add(probe);
    const importance = ['required', 'preferred'].includes(entry?.importance)
      ? entry.importance
      : 'unclassified';
    accepted.push({ phrase: text, importance });
    if (accepted.length >= MAX_REQUIREMENTS) break;
  }

  return {
    ok: true,
    available: true,
    phrases: accepted.map((x) => x.phrase),
    required: accepted.filter((x) => x.importance === 'required').map((x) => x.phrase),
    preferred: accepted.filter((x) => x.importance === 'preferred').map((x) => x.phrase),
    items: accepted,
    rejected,
    provenance: {
      source: 'llm-jd-requirements',
      enabled: true,
      model: result.model,
      task: result.provenance.task,
      provider: result.provenance.provider,
      cached: result.cached,
      skipped: null,
      verified: accepted.length,
      rejected: rejected.length,
      // Recorded so a reviewer can see the safety property held for this run.
      groundingRule: 'every accepted phrase was found verbatim in the job description',
      note: 'The model only READ the posting. Resume content remains deterministic: '
        + 'these phrases are matched against the existing master resume, never inserted into it.',
    },
  };
}
