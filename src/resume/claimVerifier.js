// @ts-check
/**
 * The claim verifier for grounded rewrites (P1-2). Deterministic and pure.
 *
 * A model may propose rewording a resume bullet, citing the master-resume
 * units it relies on. This decides whether the proposal is allowed. It passes
 * only when every checkable claim in it is backed by the CITED master-resume
 * units or by the candidate's own profile:
 *
 *   numbers   every number, percentage, money amount, multiplier and number
 *             word appears in the cited evidence;
 *   terms     every named thing (capitalized or acronym-like words, and every
 *             term from the technology vocabulary, such as a skill named in the
 *             job posting) appears in the evidence or the profile;
 *   ownership the strongest ownership verb ("led", "owned", "architected") is
 *             no stronger than the strongest one in the evidence;
 *   length    within 0.6x to 1.4x of the original bullet;
 *   citations the cited ids exist, include the bullet itself, and come from
 *             the same role (no borrowing achievements across jobs).
 *
 * The job posting is NEVER evidence: a skill the posting asks for but the
 * resume and profile do not contain fails the terms check, however natural it
 * would sound. A failed proposal is never applied; the original bullet stays.
 * Passing is necessary, not sufficient: a person still accepts each rewrite.
 */

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'hundreds', 'thousand', 'thousands',
  'million', 'millions', 'billion', 'billions', 'dozen', 'dozens', 'double', 'doubled', 'triple', 'tripled',
  'half', 'halved',
]);

/** Ownership ladder: a rewrite may not climb above what the evidence shows. */
const OWNERSHIP = [
  ['assisted', 'supported', 'helped', 'contributed', 'participated', 'collaborated', 'partnered'],
  ['built', 'developed', 'implemented', 'created', 'designed', 'delivered', 'wrote', 'engineered', 'automated',
    'migrated', 'optimized', 'improved', 'reduced', 'increased', 'maintained', 'deployed', 'integrated', 'modeled'],
  ['led', 'lead', 'leading', 'owned', 'own', 'managed', 'headed', 'directed', 'spearheaded', 'architected',
    'drove', 'established', 'founded', 'mentored', 'supervised', 'oversaw', 'championed'],
];

/** Capitalized words that are ordinary English, not claims. */
const COMMON_CAPITALIZED = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on', 'by', 'from', 'across', 'into',
  'using', 'via', 'as', 'at', 'over', 'through', 'within', 'while', 'per', 'end', 'cross',
]);

const norm = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[‐-―−]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

/** Numbers in a text as normalized strings ("40%", "$2m", "3x", "2023", "1.5"). */
export function numbersIn(text) {
  const out = new Set();
  const raw = String(text ?? '');
  for (const m of raw.matchAll(/[$£€]?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|[kmb]\b|x\b|\+)?/gi)) {
    const digits = m[0].replace(/[\s,]/g, '').toLowerCase().replace('percent', '%');
    out.add(digits.replace(/^[$£€]/, ''));
  }
  for (const word of norm(raw).match(/[a-z]+/g) ?? []) {
    if (NUMBER_WORDS.has(word)) out.add(word);
  }
  return [...out];
}

function numberBacked(number, evidenceText) {
  const ev = norm(evidenceText).replace(/,/g, '');
  const bare = number.replace(/[%+]|x$|[kmb]$/, '');
  if (!bare) return false;
  if (/^\d/.test(number)) {
    // The digits must appear as a whole number in the evidence ("40" in "40%").
    return new RegExp(`(^|[^\\d.])${bare.replace('.', '\\.')}(?![\\d])`).test(ev);
  }
  return new RegExp(`\\b${number}\\b`).test(ev);
}

/**
 * Named things in a text: words with a capital after the first letter or
 * digits or symbols (PySpark, S3, C#, .NET), all-caps acronyms, and
 * capitalized words that are not the first word of the bullet.
 */
export function namedTermsIn(text) {
  /** @type {string[]} */
  const words = String(text ?? '').match(/[A-Za-z0-9][A-Za-z0-9+#./-]*[A-Za-z0-9+#]|[A-Za-z]/g) ?? [];
  const out = new Set();
  words.forEach((word, index) => {
    const bare = word.replace(/[.,;:]+$/, '');
    if (bare.length < 2 || COMMON_CAPITALIZED.has(bare.toLowerCase())) return;
    const acronym = /^[A-Z0-9][A-Z0-9+#&./-]+$/.test(bare) && /[A-Z]/.test(bare);
    const mixed = /[a-z][A-Z]|[A-Za-z]\d|\d[A-Za-z]|[#+]/.test(bare);
    const capitalized = /^[A-Z][a-z]/.test(bare) && index > 0;
    if (acronym || mixed || capitalized) out.add(bare);
  });
  return [...out];
}

function termBacked(term, haystack) {
  const t = norm(term).replace(/[.]+$/, '');
  if (!t) return true;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}

function ownershipLevel(text) {
  const words = new Set(norm(text).match(/[a-z]+/g) ?? []);
  let level = -1;
  OWNERSHIP.forEach((verbs, i) => { if (verbs.some((v) => words.has(v))) level = i; });
  return level;
}

/** Every term a profile states about the candidate (skills, employers, titles, schools, certifications). */
export function profileTerms(candidate = {}) {
  const terms = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) terms.push(v.trim()); };
  for (const list of Object.values(candidate.technicalStack ?? {})) if (Array.isArray(list)) list.forEach(push);
  (candidate.certifications ?? []).forEach((c) => push(typeof c === 'string' ? c : c?.name));
  (candidate.domainExperience ?? []).forEach(push);
  for (const job of candidate.workHistory ?? []) { push(job?.employer); push(job?.title); }
  for (const ed of candidate.education ?? []) { push(ed?.institution); push(ed?.degree); push(ed?.field); }
  for (const t of candidate.targetTitles ?? []) push(t);
  return terms;
}

/**
 * Verify one proposed rewrite.
 *
 * @param {object} args
 * @param {{ id: string, text: string, role: string|null }} args.unit the bullet being rewritten
 * @param {string} args.rewrite the proposed text
 * @param {string[]} args.evidenceIds cited unit ids
 * @param {Map<string, {id: string, text: string, role: string|null}>} args.units every master unit by id
 * @param {string[]} [args.profile] profileTerms(candidate)
 * @param {string[]} [args.vocabulary] technology terms to police even in lowercase
 *   (the scoring keywords and the posting's requirement phrases)
 * @returns {{ ok: boolean, reasons: string[], evidence: string[] }}
 */
export function verifyRewrite({ unit, rewrite, evidenceIds = [], units, profile = [], vocabulary = [] }) {
  const reasons = [];
  const text = String(rewrite ?? '').trim();
  if (!unit || !units?.has(unit.id)) return { ok: false, reasons: ['the bullet being rewritten is not in the master resume'], evidence: [] };
  if (!text) return { ok: false, reasons: ['the rewrite is empty'], evidence: [] };
  if (norm(text) === norm(unit.text)) return { ok: false, reasons: ['the rewrite does not change anything'], evidence: [] };

  // Citations: known ids, same role, and always the bullet itself.
  const cited = [...new Set([unit.id, ...evidenceIds.map(String)])];
  const unknown = cited.filter((id) => !units.has(id));
  if (unknown.length) reasons.push(`cites units that are not in the master resume: ${unknown.join(', ')}`);
  const known = cited.filter((id) => units.has(id));
  const otherRole = known.filter((id) => (units.get(id).role ?? null) !== (unit.role ?? null));
  if (otherRole.length) reasons.push(`cites evidence from a different role (${otherRole.join(', ')}); achievements cannot move between jobs`);
  // The role heading (employer, title, dates) of the cited bullets is resume
  // text too, so it counts as evidence.
  const sameRole = known.filter((id) => !otherRole.includes(id));
  const evidenceText = [...sameRole.map((id) => units.get(id).text), unit.role ?? ''].join('\n');
  const haystack = norm(`${evidenceText}\n${profile.join('\n')}`);

  // Length.
  const ratio = text.length / Math.max(1, String(unit.text).length);
  if (ratio < 0.6 || ratio > 1.4) reasons.push(`length changed too much (${ratio.toFixed(2)}x the original; allowed 0.6x to 1.4x)`);

  // Numbers: only from the evidence, never the profile or the posting.
  const missingNumbers = numbersIn(text).filter((n) => !numberBacked(n, evidenceText));
  if (missingNumbers.length) reasons.push(`numbers not in the cited resume text: ${missingNumbers.join(', ')}`);

  // Named things and technology vocabulary.
  const named = namedTermsIn(text).filter((t) => !termBacked(t, haystack));
  const vocab = vocabulary
    .filter((term) => term && term.length >= 2 && termBacked(term, norm(text)) && !termBacked(term, haystack));
  const missingTerms = [...new Set([...named, ...vocab])];
  if (missingTerms.length) reasons.push(`names things not in the cited resume text or your profile: ${missingTerms.join(', ')}`);

  // Ownership.
  const claimed = ownershipLevel(text);
  // Evidence with no ladder verb at all allows the middle rung at most.
  const evidenceLevel = ownershipLevel(evidenceText);
  const shown = evidenceLevel >= 0 ? evidenceLevel : 1;
  if (claimed > shown) reasons.push('claims more ownership than the resume shows (for example "led" where it says "built" or "contributed")');

  return { ok: reasons.length === 0, reasons, evidence: known };
}

/**
 * Verify one cover-letter paragraph (P1-3). The same rules as a bullet
 * rewrite, without the length and same-role checks (a letter draws on the
 * whole resume): every number from the cited units, every named thing from
 * the cited units, the profile, or the `literals` (the company and the role
 * title, which name the application, not the candidate), and no ownership
 * stronger than the cited units show.
 */
export function verifyParagraph({ text, evidenceIds = [], units, profile = [], vocabulary = [], literals = [], allowNoEvidence = false }) {
  const reasons = [];
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reasons: ['the paragraph is empty'], evidence: [] };
  const cited = [...new Set(evidenceIds.map(String))];
  // A courtesy sentence ("Thank you for the update.") may cite nothing; the
  // number and named-thing checks below still apply to it in full.
  if (!cited.length && !allowNoEvidence) reasons.push('cites no resume text');
  const unknown = cited.filter((id) => !units.has(id));
  if (unknown.length) reasons.push(`cites units that are not in the master resume: ${unknown.join(', ')}`);
  const known = cited.filter((id) => units.has(id));
  const roles = [...new Set(known.map((id) => units.get(id).role).filter(Boolean))];
  const evidenceText = [...known.map((id) => units.get(id).text), ...roles].join('\n');
  const haystack = norm(`${evidenceText}\n${profile.join('\n')}\n${literals.filter(Boolean).join('\n')}`);

  const missingNumbers = numbersIn(body).filter((n) => !numberBacked(n, evidenceText));
  if (missingNumbers.length) reasons.push(`numbers not in the cited resume text: ${missingNumbers.join(', ')}`);
  const named = namedTermsIn(body).filter((t) => !termBacked(t, haystack));
  const vocab = vocabulary.filter((term) => term && term.length >= 2 && termBacked(term, norm(body)) && !termBacked(term, haystack));
  const missingTerms = [...new Set([...named, ...vocab])];
  if (missingTerms.length) reasons.push(`names things not in the cited resume text or your profile: ${missingTerms.join(', ')}`);
  const evidenceLevel = ownershipLevel(evidenceText);
  if (ownershipLevel(body) > (evidenceLevel >= 0 ? evidenceLevel : 1)) {
    reasons.push('claims more ownership than the resume shows');
  }
  return { ok: reasons.length === 0, reasons, evidence: known };
}
