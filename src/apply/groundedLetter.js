/**
 * Grounded cover letters (P1-3).
 *
 * Off unless COVER_LETTER_MODE=grounded AND LLM assist is on; the template
 * letter (coverLetter.js) stays the default and the fallback. When on, the
 * model (task `cover-letter`) writes the body as 2 to 4 paragraphs, each citing
 * the master-resume units it draws on. Every paragraph goes through the claim
 * verifier (verifyParagraph): numbers, named things and ownership must come
 * from the cited resume text or the profile, never from the posting; only the
 * company name and role title may come from the posting, because they name the
 * application rather than the candidate. Paragraphs that fail are dropped. If
 * fewer than two survive, the template letter is used and the reason recorded.
 * The surviving body then goes through the template path's own greeting,
 * closing, humanizer, word limit and leftover-placeholder check.
 */
import { llmSettings } from '../llm/client.js';
import { runTask, SYSTEM_UNTRUSTED_RULE } from '../llm/task.js';
import { profileTerms, verifyParagraph } from '../resume/claimVerifier.js';
import { readMasterUnits, vocabularyFromScoring } from '../resume/tailorRunner.js';
import { readMasterLetterText } from './masterLetter.js';
import { parseLetter } from './letterTailor.js';

export function letterSettings(env = process.env, { root = null } = {}) {
  const llm = llmSettings(env, { root });
  const mode = String(env.COVER_LETTER_MODE ?? 'template').trim().toLowerCase();
  if (mode !== 'grounded') return { enabled: false, reason: 'COVER_LETTER_MODE is template', llm };
  if (!llm.enabled) return { enabled: false, reason: `grounded letters need the LLM assist: ${llm.reason}`, llm };
  return { enabled: true, reason: null, llm };
}

const SYSTEM = [
  'You write the body of a short, specific cover letter (2 to 4 paragraphs, under 250 words in total).',
  '',
  'Rules:',
  '1. Every paragraph cites, in "evidence", the resume units (ids like u3) whose facts it uses.',
  '2. Use only facts written in the cited units. Never add a number, tool, technology, employer, product,',
  '   certification, degree or achievement that is not in them.',
  '3. The company name and role title may be used. Requirement phrases from the posting are hints about',
  '   what to bring forward, not facts about the candidate: mention one only if the cited units contain it.',
  '4. Never strengthen ownership ("contributed" never becomes "led").',
  '5. No greeting, no sign-off, no placeholders: body paragraphs only. Plain, specific, no cliches.',
  '   Units with ids like l2 are paragraphs of the person\'s OWN cover letter: keep their voice and',
  '   reuse their wording where it fits; they are evidence like any other unit.',
  `6. ${SYSTEM_UNTRUSTED_RULE}`,
  '',
  'Respond with JSON only: {"paragraphs":[{"text":"...","evidence":["u2","u5"]}]}',
].join('\n');

export const COVER_LETTER_TASK = Object.freeze({
  name: 'cover-letter',
  version: 1,
  system: SYSTEM,
  maxTokens: 3000,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['paragraphs'],
    properties: {
      paragraphs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'evidence'],
          properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  },
  buildUser: ({ company, title, requirements, bullets }) => [
    `COMPANY: ${company}`,
    `ROLE: ${title}`,
    '',
    'REQUIREMENT PHRASES (hints only):',
    requirements.length ? requirements.map((r) => `- ${r}`).join('\n') : '- (none)',
    '',
    'RESUME UNITS:',
    ...bullets.map((u) => `${u.id}: ${u.text}${u.role ? `  [${u.role}]` : ''}`),
  ].join('\n'),
  postValidate: (data) => {
    const n = data.paragraphs?.length ?? 0;
    return n >= 1 && n <= 5 ? [] : [`expected 2 to 4 paragraphs, got ${n}`];
  },
});

/**
 * Write and verify a letter body.
 * @returns {Promise<{ ok: boolean, body?: string, paragraphs?: object[], dropped?: object[],
 *   reason?: string, provenance?: object }>}
 */
export async function composeGroundedLetter({ job, config, requirements = [], env = process.env, deps = {} }) {
  const root = config?.root ?? null;
  const settings = letterSettings(env, { root });
  if (!settings.enabled) return { ok: false, reason: settings.reason };
  let units;
  try {
    units = await (deps.readMasterUnitsFn ?? readMasterUnits)({ root, deps });
  } catch (err) {
    return { ok: false, reason: `could not read the master resume: ${err.message}` };
  }
  // The person's own master cover letter joins the evidence: its paragraphs
  // are their words about their own work, cited like resume lines.
  const letterText = deps.masterLetterText ?? readMasterLetterText(root);
  const letterUnits = letterText
    ? parseLetter(letterText).body.filter((t) => !/\[[^\]]{3,}\]/.test(t))
      .map((text, i) => ({ id: `l${i + 1}`, kind: 'paragraph', text: text.replace(/\{(?:company|title|role)\}/g, (m) => (m === '{company}' ? String(job.company ?? '') : String(job.title ?? ''))) }))
    : [];
  units = [...units, ...letterUnits];
  const bullets = units.filter((u) => u.kind === 'bullet' || u.kind === 'paragraph').slice(0, 60 + letterUnits.length);
  const company = String(job.company ?? '').trim();
  const title = String(job.title ?? '').trim();
  const result = await runTask(COVER_LETTER_TASK, { company, title, requirements: requirements.slice(0, 30), bullets },
    { settings: settings.llm, deps });
  if (!result.ok) return { ok: false, reason: result.error };

  const unitMap = new Map(units.map((u) => [u.id, u]));
  const profile = profileTerms(config?.candidate ?? {});
  const vocabulary = [...new Set([...vocabularyFromScoring(config?.scoring ?? {}), ...requirements])].map((t) => String(t).toLowerCase());
  const kept = []; const dropped = [];
  for (const p of result.data.paragraphs) {
    const verdict = verifyParagraph({ text: p.text, evidenceIds: p.evidence, units: unitMap, profile, vocabulary, literals: [company, title] });
    if (verdict.ok) kept.push({ text: String(p.text).trim(), evidence: verdict.evidence });
    else dropped.push({ text: String(p.text).trim(), reasons: verdict.reasons });
  }
  if (kept.length < 2) {
    return { ok: false, reason: `only ${kept.length} paragraph(s) were backed by your resume`, dropped, provenance: result.provenance };
  }
  return { ok: true, body: kept.map((p) => p.text).join('\n\n'), paragraphs: kept, dropped, provenance: result.provenance };
}
