// @ts-check
/**
 * What kind of reply is this? (P1-7)
 *
 * Deterministic phrase rules first. Each verdict carries the sentence that
 * triggered it, so a person sees WHY. Ambiguous messages stay `unclassified`
 * rather than being guessed. The optional LLM task (`classify-reply`) is asked
 * only about those, and its answer is kept only when the evidence it quotes
 * appears word for word in the message.
 */
import { runTask, SYSTEM_UNTRUSTED_RULE, untrusted } from '../llm/task.js';

export const REPLY_KINDS = Object.freeze(['rejection', 'interview', 'assessment', 'offer', 'acknowledgement', 'unclassified']);

/** Kind -> the application outcome it suggests (acknowledgement suggests none). */
export const KIND_TO_OUTCOME = Object.freeze({ rejection: 'rejected', interview: 'interviewing', assessment: 'interviewing', offer: 'offer' });

/** @type {Array<[string, RegExp[]]>} */
const RULES = [
  ['offer', [/\b(pleased|delighted|happy) to (extend|offer) you\b/, /\boffer letter\b/, /\bverbal offer\b/, /\bjob offer\b/]],
  ['rejection', [
    /\b(will not|won't|not) be (moving|proceeding) forward\b/, /\bdecided (not )?to (move|proceed) forward with other\b/,
    /\bdecided to pursue other candidates\b/, /\bnot (been )?selected\b/, /\bposition has (been|now been) filled\b/,
    /\bunfortunately\b[^.]{0,120}\b(not|other candidates|another candidate|unable)\b/, /\bregret to inform\b/,
    /\bno longer (being )?consider/, /\bmove forward with (another|other) (candidate|applicant)s?\b/,
  ]],
  ['assessment', [/\b(online|technical|coding) (assessment|challenge|test)\b/, /\bhackerrank\b|\bcodility\b|\bcodesignal\b|\bcoderpad\b/, /\btake[- ]home (assignment|exercise|project)\b/]],
  ['interview', [
    /\bschedule (a|an|your) (call|interview|chat|conversation|phone screen)\b/, /\b(phone|video|technical|onsite|on-site) (screen|interview)\b/,
    /\binterview with (our|the)\b/, /\byour availability\b/, /\bcalendly\.com\b/, /\bnext (step|round) (is|will be) (a|an)\b/,
    /\binvite you to (an? )?(interview|conversation|call)\b/,
  ]],
  ['acknowledgement', [
    /\b(thank you|thanks) for (applying|your application|your interest)\b/, /\bwe (have )?received your application\b/,
    /\bapplication (has been )?received\b/, /\bapplication (was|has been) (successfully )?submitted\b/,
  ]],
];

/** The sentence around a match, trimmed for display. */
function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('\n', index - 1)) + 1;
  const endDot = text.indexOf('.', index);
  const endNl = text.indexOf('\n', index);
  const end = [endDot, endNl].filter((n) => n !== -1).reduce((a, b) => Math.min(a, b), text.length);
  return text.slice(start, Math.min(end + 1, start + 240)).replace(/\s+/g, ' ').trim();
}

/** Rule-based verdict: { kind, evidence, method: 'rules' }. */
export function classifyByRules({ subject = '', body = '' }) {
  const text = `${subject}\n${body}`.replace(/\r/g, '');
  const lower = text.toLowerCase();
  const hits = [];
  for (const [kind, patterns] of RULES) {
    for (const re of patterns) {
      const m = re.exec(lower);
      if (m) { hits.push({ kind, index: m.index }); break; }
    }
  }
  // An acknowledgement that also says "unfortunately ... not" is a rejection;
  // a rejection never becomes an interview because it mentions "next steps".
  const order = ['offer', 'rejection', 'assessment', 'interview', 'acknowledgement'];
  const best = order.map((k) => hits.find((h) => h.kind === k)).find(Boolean);
  if (!best) return { kind: 'unclassified', evidence: null, method: 'rules' };
  return { kind: best.kind, evidence: sentenceAround(text, best.index), method: 'rules' };
}

export const CLASSIFY_TASK = Object.freeze({
  name: 'classify-reply',
  version: 1,
  effort: 'low',
  maxTokens: 600,
  system: [
    'You classify an email a job applicant received about one application.',
    'Kinds: rejection, interview (a request to schedule or attend one), assessment (a test or take-home),',
    'offer, acknowledgement (confirms the application arrived), unclassified (anything else, or unsure).',
    'Quote, in "evidence", one sentence copied EXACTLY from the email that shows the kind. If no sentence',
    'clearly shows it, answer unclassified with evidence null.',
    SYSTEM_UNTRUSTED_RULE,
    'Respond with JSON only: {"kind":"rejection","evidence":"..."}',
  ].join('\n'),
  schema: {
    type: 'object', additionalProperties: false, required: ['kind', 'evidence'],
    properties: { kind: { type: 'string', enum: REPLY_KINDS }, evidence: { type: ['string', 'null'] } },
  },
  buildUser: ({ subject, body }) => `SUBJECT: ${String(subject).slice(0, 300)}\n\n${untrusted('email', String(body).slice(0, 6000))}`,
});

/**
 * Classify, asking the model only when the rules found nothing and keeping
 * its answer only when its evidence is verbatim in the message.
 */
export async function classifyReply(message, { llm = null, deps = {} } = {}) {
  const ruled = classifyByRules(message);
  if (ruled.kind !== 'unclassified' || !llm?.enabled) return ruled;
  const r = await runTask(CLASSIFY_TASK, message, { settings: llm, deps });
  if (!r.ok || r.data.kind === 'unclassified' || !r.data.evidence) return ruled;
  const squash = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!squash(`${message.subject}\n${message.body}`).includes(squash(r.data.evidence))) return ruled;
  return { kind: r.data.kind, evidence: r.data.evidence.trim(), method: 'llm', task: r.provenance.task };
}
