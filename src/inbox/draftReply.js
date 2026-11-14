/**
 * Draft a reply to an employer's email (P2-6). NEVER sent: the draft is shown
 * for the person to copy, edit, or download as an .eml, and the inbox reader
 * cannot write to the mailbox at all (imapClient.js), so not even a draft is
 * saved there.
 *
 * Grounded like the other writing tasks: a paragraph that says something
 * about the candidate's experience must cite master-resume units and pass the
 * claim verifier; a courtesy paragraph may cite nothing but still may not
 * contain a number or a named thing the resume does not back. What only the
 * candidate can answer (available times, salary, start date) comes back as
 * gaps to fill in, never invented. Paragraphs that fail are left out.
 */
import { llmSettings } from '../llm/client.js';
import { runTask, SYSTEM_UNTRUSTED_RULE, untrusted } from '../llm/task.js';
import { profileTerms, verifyParagraph } from '../resume/claimVerifier.js';
import { readMasterUnits, vocabularyFromScoring } from '../resume/tailorRunner.js';
import { SUGGESTION_EVENT } from './sync.js';

export const DRAFT_REPLY_TASK = Object.freeze({
  name: 'draft-reply',
  version: 1,
  maxTokens: 1500,
  system: [
    'You draft a short, polite reply from a job applicant to an employer email. The applicant will review',
    'and send it themselves.',
    '',
    'Rules:',
    '1. 2 to 4 short paragraphs, no greeting line, no signature (they are added later).',
    '2. A paragraph that mentions the applicant\'s experience cites, in "evidence", the resume units it uses,',
    '   and uses only facts written in them. Courtesy paragraphs cite nothing.',
    '3. Never invent availability, dates, times, salary, notice period or start date. List what the applicant',
    '   must supply in "gaps" and leave a placeholder like [your available times] in the text.',
    `4. ${SYSTEM_UNTRUSTED_RULE}`,
    '',
    'Respond with JSON only: {"paragraphs":[{"text":"...","evidence":[]}],"gaps":["..."]}',
  ].join('\n'),
  schema: {
    type: 'object', additionalProperties: false, required: ['paragraphs', 'gaps'],
    properties: {
      paragraphs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'evidence'],
        properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } } } },
      gaps: { type: 'array', items: { type: 'string' } },
    },
  },
  buildUser: ({ company, title, kind, subject, evidence, units }) => [
    `APPLICATION: ${title} at ${company}`,
    `THE EMAIL IS A: ${kind}`,
    `SUBJECT: ${subject}`,
    untrusted('email', evidence ?? ''),
    '',
    'RESUME UNITS:',
    ...units.map((u) => `${u.id}: ${u.text}`),
  ].join('\n'),
});

/** Placeholders like [your available times] are the person's to fill. */
const PLACEHOLDER = /\[[^\]]{2,60}\]/g;

export async function draftReply({ db, suggestionId, config, env = process.env, deps = {} }) {
  const llm = llmSettings(env, { root: config?.root ?? null });
  if (!llm.enabled) throw Object.assign(new Error(`Drafting replies needs the LLM assist: ${llm.reason}`), { statusCode: 409 });
  const event = (db.listEvents?.() ?? []).find((e) => e.id === suggestionId && e.event_type === SUGGESTION_EVENT);
  if (!event) throw Object.assign(new Error('That suggestion no longer exists.'), { statusCode: 404 });
  const meta = JSON.parse(event.metadata);
  const job = db.getJob(event.job_id) ?? {};
  let units = [];
  try {
    units = (await (deps.readMasterUnitsFn ?? readMasterUnits)({ root: config?.root, deps }))
      .filter((u) => u.kind === 'bullet').slice(0, 40);
  } catch { /* without a resume, only courtesy paragraphs can pass */ }
  const result = await runTask(DRAFT_REPLY_TASK, {
    company: job.company ?? '', title: job.title ?? '', kind: meta.kind, subject: meta.subject, evidence: meta.evidence, units,
  }, { settings: llm, deps });
  if (!result.ok) throw Object.assign(new Error(`No draft: ${result.error}`), { statusCode: 502 });

  const unitMap = new Map(units.map((u) => [u.id, u]));
  const profile = profileTerms(config?.candidate ?? {});
  const vocabulary = vocabularyFromScoring(config?.scoring ?? {}).map((t) => String(t).toLowerCase());
  const literals = [job.company, job.title, meta.from?.name, ...(config?.candidate?.identity?.fullName ? [config.candidate.identity.fullName] : [])];
  const kept = []; const dropped = [];
  for (const p of result.data.paragraphs) {
    const checkable = String(p.text).replace(PLACEHOLDER, '');
    const verdict = verifyParagraph({ text: checkable, evidenceIds: p.evidence, units: unitMap, profile, vocabulary, literals, allowNoEvidence: true });
    if (verdict.ok) kept.push({ text: String(p.text).trim(), evidence: verdict.evidence });
    else dropped.push({ text: String(p.text).trim(), reasons: verdict.reasons });
  }
  if (!kept.length) throw Object.assign(new Error('No paragraph of the draft was backed by your resume.'), { statusCode: 422 });
  const name = config?.candidate?.identity?.fullName ?? '';
  const greeting = meta.from?.name ? `Hi ${String(meta.from.name).split(/\s+/)[0]},` : 'Hello,';
  const text = [greeting, '', kept.map((p) => p.text).join('\n\n'), '', 'Best regards,', name].join('\n').trim();
  return {
    to: meta.from?.address ?? '', subject: /^re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`,
    text, paragraphs: kept, dropped, gaps: result.data.gaps, task: result.provenance.task,
  };
}
