// @ts-check
/**
 * Tailor the MASTER cover letter to one job, deterministically.
 *
 * The person's own letter is the source of voice and of every claim. For each
 * job it:
 *   1. fills {company} and {title} (and the "[Company]"/"[Role]" bracket
 *      forms people paste from templates), and points a generic "this role"
 *      or "your company" in the opening at this job;
 *   2. keeps the opening and closing, and chooses which middle paragraphs to
 *      use by how much of THIS posting each one speaks to, in their original
 *      order, within a word budget that grows with how strong the match is;
 *   3. when the letter has little concrete evidence, adds one short paragraph
 *      of results taken verbatim from the profile's own work-history
 *      highlights, the ones that best match the posting;
 *   4. names, in one sentence, posting requirements the profile evidences that
 *      the letter has not mentioned yet.
 *
 * Nothing is invented. Every sentence is the person's own letter, a highlight
 * they wrote about their own work, or a connective sentence that states only
 * evidenced facts. A paragraph that still contains a writing prompt
 * ("[A result you are proud of]") or an unknown placeholder is skipped.
 */
import { presentableSkills } from './coverLetter.js';
import { countWords, PROMPT_RE, sentencesOf } from './letterQuality.js';

/** How long the letter may be, by how strong the match is. */
export const DEPTHS = Object.freeze({
  focused: { min: 170, max: 280, middle: 1 },
  standard: { min: 220, max: 340, middle: 2 },
  full: { min: 260, max: 400, middle: 3 },
});

/** @param {number} score @param {boolean} required */
export function letterDepth(score, required = false) {
  if (required || score >= 85) return 'full';
  if (score >= 75) return 'standard';
  return 'focused';
}

const GREETING_RE = /^(dear|hello|hi|to whom|greetings)\b/i;
const SIGNOFF_RE = /^(sincerely|best(?: regards| wishes)?|regards|kind regards|warm regards|warmly|respectfully|yours(?: truly| sincerely)?|thank you|thanks|cheers|with appreciation)[,.!]?$/i;
const CLOSING_HINT = /\b(thank you|thanks for|look forward|welcome the (?:chance|opportunity)|happy to (?:talk|discuss)|discuss how|speak with you|hear from you)\b/i;
const KNOWN_TOKENS = new Set(['company', 'title', 'role']);

/**
 * Split a letter into greeting, body paragraphs and sign-off.
 * @param {string} text
 */
export function parseLetter(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const flat = (b) => b.replace(/\s*\n\s*/g, ' ').trim();
  let greeting = null;
  if (raw.length) {
    const lines = raw[0].split('\n');
    if (GREETING_RE.test(lines[0]) && countWords(lines[0]) <= 12) {
      greeting = lines[0].trim();
      const rest = lines.slice(1).join('\n').trim();
      if (rest) raw[0] = rest; else raw.shift();
    }
  }
  const signoff = [];
  // The sign-off block: "Sincerely," with the name under it, on one block or
  // two. A block whose FIRST line is a sign-off ends the letter.
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const lines = raw[i].split('\n').map((l) => l.trim()).filter(Boolean);
    if (SIGNOFF_RE.test(lines[0]) && lines.length <= 3) {
      signoff.unshift(...lines);
      raw.splice(i);
      break;
    }
    // A bare name after the sign-off block.
    if (i === raw.length - 1 && lines.length === 1 && countWords(lines[0]) <= 5 && !/[.!?:]$/.test(lines[0])
      && i > 0 && SIGNOFF_RE.test(raw[i - 1].split('\n')[0].trim())) continue;
    break;
  }
  return { greeting, body: raw.map(flat), signoff };
}

/** "[Company]", "[Company Name]", "<Role>" and friends become tokens. */
function normalizeTokens(text) {
  return text
    .replace(/[[<]\s*(?:company|company name|employer|organization|organisation)\s*[\]>]/gi, '{company}')
    .replace(/[[<]\s*(?:role|job title|position|title|position title)\s*[\]>]/gi, '{title}')
    .replace(/\{role\}/g, '{title}');
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Point a generic opening at this job, once each:
 *   "this position"  -> "the Data Engineer role at Northwind"
 *   "your company"   -> "Northwind"
 */
function aimOpening(text, { company, title }) {
  let out = text;
  const names = (s) => new RegExp(`\\b${escapeRe(company)}\\b`, 'i').test(s);
  if (!/\{company\}|\{title\}/.test(out)) {
    out = out.replace(/\b(?:this|the|your)\s+(?:open\s+)?(?:role|position|opening|opportunity|vacancy)\b/i,
      () => (names(out) ? `the ${title} role` : `the ${title} role at ${company}`));
  }
  out = out.replace(/\b(?:your|this)\s+(?:company|organization|organisation|firm)\b/i, company);
  return out;
}

/** @param {string} text @param {Record<string, string>} values */
function fillTokens(text, values) {
  return text.replace(/\{(\w+)\}/g, (whole, name) => (values[name] ?? whole));
}

/** @param {string} s */
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A highlight that reads as "I <verb>…": it starts with a past-tense action. */
const ACTION_VERB = /^(?:[a-z]+ed|built|led|ran|drove|grew|cut|won|made|wrote|set up|saw|took|brought|began|became|chose|found|gave|got|held|kept|lent|lost|met|paid|put|rose|sent|shot|sold|spent|stood|taught|told|thought|understood|oversaw|shipped|spun up|stood up)\b/i;

/** Terms from the posting, for ranking which paragraphs speak to it. */
function postingTerms(job, score) {
  const matched = (score?.matchedKeywords ?? []).map((t) => String(t).toLowerCase());
  const titleWords = String(job?.title ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !['senior', 'junior', 'lead', 'staff', 'principal', 'the', 'and'].includes(w));
  return [...new Set([...matched, ...titleWords])].filter(Boolean);
}

/** @param {string} text @param {string[]} terms */
function relevance(text, terms) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (new RegExp(`(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])`).test(lower)) hits += 1;
  return hits;
}

const METRIC_RE = /[$€£]\s?\d|\d+(?:\.\d+)?\s?(?:%|percent|x\b|×|million|billion|hours?|days?|weeks?)|\b(?!(?:19|20)\d{2}\b)\d{2,}\+?/i;

/**
 * Compose the body of a job-specific letter from the master letter.
 *
 * @param {object} args
 * @param {string} args.master the master letter text
 * @param {any} args.job normalized job (title, company)
 * @param {any} [args.score] scoreJob result (total, matchedKeywords)
 * @param {any} [args.candidate] candidate config
 * @param {boolean} [args.required]
 * @returns {{ ok: boolean, reason?: string, body: string, depth: string, limits: {min: number, max: number},
 *   paragraphs: {text: string, source: 'master'|'profile'|'connective'}[], skipped: {text: string, reason: string}[],
 *   greeting: string|null, signoff: string[], warnings: string[] }}
 */
export function composeFromMaster({ master, job, score = {}, candidate = {}, required = false }) {
  const company = String(job?.company ?? '').trim() || 'your team';
  const title = String(job?.title ?? '').trim() || 'this role';
  const depthName = letterDepth(Number(score?.total ?? 0), required);
  const depth = DEPTHS[depthName];
  const limits = { min: depth.min, max: depth.max };
  const values = { company, title };
  const warnings = [];
  const parsed = parseLetter(normalizeTokens(String(master ?? '')));
  /** @type {{text: string, reason: string}[]} */
  const skipped = [];

  const usable = (text) => {
    if (PROMPT_RE.test(text)) { skipped.push({ text, reason: 'still has a writing prompt' }); return false; }
    const unknown = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((t) => !KNOWN_TOKENS.has(t));
    if (unknown.length) { skipped.push({ text, reason: `has a placeholder JobAgent cannot fill: {${unknown[0]}}` }); return false; }
    return true;
  };
  const body = parsed.body.filter(usable);
  if (!body.length) {
    return { ok: false, reason: 'the master cover letter has no finished paragraphs yet', body: '', depth: depthName, limits, paragraphs: [], skipped, greeting: null, signoff: [], warnings };
  }
  if (!/\{company\}/.test(parsed.body.join(' '))
    && !new RegExp(`\\b${escapeRe(company)}\\b`, 'i').test(parsed.body.join(' '))) {
    warnings.push('Your master letter has no {company} placeholder, so the employer is named only where JobAgent could place it.');
  }

  // Opening and closing are structural; the middle is chosen per posting.
  const opening = body[0];
  const closingIndex = body.length >= 3 && CLOSING_HINT.test(body[body.length - 1]) ? body.length - 1 : -1;
  const closing = closingIndex > 0 ? body[closingIndex] : null;
  const middle = body.slice(1, closingIndex > 0 ? closingIndex : undefined);
  const terms = postingTerms(job, score);
  const ranked = middle.map((text, index) => ({ text, index, rel: relevance(text, terms), metric: METRIC_RE.test(text) }))
    .sort((a, b) => (b.rel - a.rel) || (Number(b.metric) - Number(a.metric)) || (a.index - b.index));

  let openingText = aimOpening(fillTokens(opening, values), { company, title });
  if (!new RegExp(`\\b${escapeRe(company)}\\b`, 'i').test(openingText) && company !== 'your team') {
    openingText = `I am applying for the ${title} role at ${company}. ${openingText}`;
  }
  const closingText = closing
    ? fillTokens(closing, values)
    : `I would welcome the chance to talk about how I could contribute to ${company}. Thank you for your consideration.`;

  // Choose middle paragraphs: most relevant first, up to the depth's count,
  // then fill toward the minimum while the budget allows.
  const chosen = new Set();
  let words = countWords(openingText) + countWords(closingText);
  for (const p of ranked) {
    if (chosen.size >= depth.middle) break;
    const w = countWords(p.text);
    if (words + w > depth.max && chosen.size > 0) continue;
    chosen.add(p.index); words += w;
  }
  for (const p of ranked) {
    if (words >= depth.min) break;
    if (chosen.has(p.index)) continue;
    const w = countWords(p.text);
    if (words + w > depth.max) continue;
    chosen.add(p.index); words += w;
  }
  for (const p of ranked) if (!chosen.has(p.index)) skipped.push({ text: p.text, reason: p.rel ? 'less relevant to this posting than the paragraphs kept' : 'does not speak to this posting' });

  /** @type {{text: string, source: 'master'|'profile'|'connective'}[]} */
  const paragraphs = [{ text: openingText, source: 'master' }];
  for (const p of middle.map((text, index) => ({ text, index })).filter((p) => chosen.has(p.index))) {
    paragraphs.push({ text: fillTokens(p.text, values), source: 'master' });
  }

  // Evidence: when the chosen paragraphs state fewer than two measured
  // results, add the profile's own best-matching highlights, verbatim.
  const letterSoFar = paragraphs.map((p) => p.text).join(' ');
  const metricsSoFar = sentencesOf(letterSoFar).filter((s) => METRIC_RE.test(s)).length;
  if (metricsSoFar < 2) {
    const highlights = [];
    for (const role of candidate?.workHistory ?? []) {
      for (const h of role?.highlights ?? []) {
        const text = String(h ?? '').trim().replace(/\.\s*$/, '');
        if (!text || /one-line, metric-backed/i.test(text) || !ACTION_VERB.test(text)) continue;
        if (letterSoFar.toLowerCase().includes(text.toLowerCase().slice(0, 40))) continue;
        highlights.push({ text, employer: String(role?.employer ?? '').trim(), rel: relevance(text, terms), metric: METRIC_RE.test(text) });
      }
    }
    highlights.sort((a, b) => (b.rel - a.rel) || (Number(b.metric) - Number(a.metric)));
    const picks = [];
    for (const h of highlights) {
      if (picks.length >= (depthName === 'focused' ? 1 : 2)) break;
      if (!h.rel && !h.metric) continue;
      if (picks.some((p) => p.employer === h.employer) && highlights.some((o) => o.employer !== h.employer && !picks.includes(o) && (o.rel || o.metric))) continue;
      picks.push(h);
    }
    if (picks.length) {
      const sentences = picks.map((h, i) => {
        const where = h.employer ? (i === 0 ? `At ${h.employer}, ` : `${picks[0].employer === h.employer ? 'There, ' : `At ${h.employer}, `}`) : '';
        return `${where}I ${lowerFirst(h.text)}.`;
      });
      const text = sentences.join(' ');
      if (words + countWords(text) <= depth.max + 20) {
        paragraphs.push({ text, source: 'profile' }); words += countWords(text);
      }
    }
  }

  // Requirements the profile evidences that the letter has not named yet.
  const said = paragraphs.map((p) => p.text).join(' ').toLowerCase();
  const unsaid = presentableSkills(score?.matchedKeywords ?? [], candidate)
    .filter((s) => !said.includes(s.toLowerCase())).slice(0, 3);
  if (unsaid.length >= 2) {
    const list = unsaid.length === 2 ? unsaid.join(' and ') : `${unsaid.slice(0, -1).join(', ')} and ${unsaid.at(-1)}`;
    const text = `The posting also asks for ${list}, which are part of my background.`;
    if (words + countWords(text) <= depth.max + 20) {
      // Never appended to the person's own paragraph: it joins the profile
      // results, or stands as its own short paragraph.
      const last = paragraphs[paragraphs.length - 1];
      if (last.source === 'profile') last.text = `${last.text} ${text}`;
      else paragraphs.push({ text, source: 'connective' });
    }
  }

  paragraphs.push({ text: closingText, source: 'master' });
  return {
    ok: true,
    body: paragraphs.map((p) => p.text).join('\n\n'),
    depth: depthName,
    limits,
    paragraphs,
    skipped,
    greeting: parsed.greeting ? fillTokens(parsed.greeting, values) : null,
    signoff: parsed.signoff,
    warnings,
  };
}
