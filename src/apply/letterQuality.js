// @ts-check
/**
 * Reads a cover letter the way a hiring manager would skim it, and says what
 * would make them stop: too thin, too long, the same sentence twice, a stock
 * phrase, a leftover placeholder, or a letter that never names the employer.
 *
 * Pure and deterministic. Used for the master cover letter while it is being
 * written, and for every tailored letter before it is saved.
 */

/** Stock phrases that make a letter read as a template. */
export const STOCK_PHRASES = Object.freeze([
  'i am writing to express my interest', 'to whom it may concern', 'dear sir or madam',
  'team player', 'hard-working', 'hardworking', 'go-getter', 'think outside the box',
  'results-driven', 'detail-oriented', 'self-starter', 'synergy', 'perfect fit',
  'i believe i would be a great fit', 'i am confident that i am the ideal candidate',
  'proven track record', 'wear many hats', 'fast-paced environment', 'passionate about',
  'thank you for your time and consideration',
]);

const STOP = new Set(('about above after again against all also and any are because been before being below between both '
  + 'but can could did does doing down during each few for from further had has have having her here hers him his how '
  + 'into its itself just more most other our ours out over own same she should some such than that the their them then '
  + 'there these they this those through too under until very was were what when where which while who whom why will '
  + 'with would you your yours role team work working company years experience').split(' '));

/** @param {string} s */
export const countWords = (s) => (String(s ?? '').match(/\b[\w'’-]+\b/g) ?? []).length;

/** Bracketed writing prompts left in a draft: "[One result you are proud of]". */
export const PROMPT_RE = /\[[^\]\n]{3,120}\]/;
/** Template tokens the tailor fills: {company}, {title}. */
export const TOKEN_RE = /\{(\w+)\}/;

/** @param {string} text */
export function sentencesOf(text) {
  return String(text ?? '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

/**
 * @param {string} text the letter (greeting and sign-off allowed)
 * @param {{ company?: string, title?: string, master?: boolean }} [context]
 *   `master: true` judges a master letter, where {company}/{title} tokens are
 *   expected and the employer cannot be named yet.
 * @returns {{ words: number, paragraphs: number, score: number, label: string,
 *   issues: { code: string, level: 'block'|'warn'|'info', message: string }[] }}
 */
export function assessLetter(text, { company = '', title = '', master = false } = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const blocks = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const body = blocks.filter((p) => !/^(dear|hello|hi|to whom|greetings)\b/i.test(p) || countWords(p) > 12)
    .filter((p) => !/^(sincerely|best|regards|kind regards|warm regards|respectfully|yours|thank you|cheers)\b[^.]{0,40}$/i.test(p));
  const bodyText = body.join('\n\n');
  const words = countWords(bodyText);
  /** @type {{ code: string, level: 'block'|'warn'|'info', message: string }[]} */
  const issues = [];
  const add = (code, level, message) => issues.push({ code, level, message });

  if (!raw) return { words: 0, paragraphs: 0, score: 0, label: 'Empty', issues: [{ code: 'empty', level: 'block', message: 'The letter is empty.' }] };

  const prompt = raw.match(PROMPT_RE);
  if (prompt) add('prompt', 'block', `Still has a writing prompt to replace: ${prompt[0]}`);
  const token = raw.match(TOKEN_RE);
  if (token && !master) add('token', 'block', `Still has an unfilled placeholder: ${token[0]}`);
  if (token && master && !['company', 'title', 'role', 'hiringManager'].includes(token[1])) {
    add('token', 'warn', `${token[0]} is not filled in automatically. Use {company} or {title}.`);
  }

  if (words < 150) add('short', 'warn', `${words} words reads thin. Aim for 220 to 380: one specific result per paragraph.`);
  else if (words > 450) add('long', 'warn', `${words} words is long for a first read. Keep it under about 400.`);
  if (body.length < 3) add('paragraphs', 'info', 'Three or four short paragraphs are easier to skim than one or two long ones.');
  for (const p of body) {
    if (countWords(p) > 140) { add('dense', 'info', 'One paragraph runs past 140 words. Split it where the topic changes.'); break; }
  }

  const sentences = sentencesOf(bodyText);
  const seen = new Set();
  for (const s of sentences) {
    const k = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (k.length > 20 && seen.has(k)) { add('repeat', 'warn', `This sentence appears twice: "${s.slice(0, 80)}"`); break; }
    seen.add(k);
  }
  const iStarts = sentences.filter((s) => /^i\b/i.test(s)).length;
  if (sentences.length >= 6 && iStarts / sentences.length > 0.6) {
    add('i-start', 'info', `${iStarts} of ${sentences.length} sentences start with "I". Lead some with the result or the work.`);
  }

  const lower = bodyText.toLowerCase();
  const nameWords = new Set(`${company} ${title}`.toLowerCase().split(/\W+/));
  const counts = new Map();
  for (const w of lower.match(/\b[a-z]{5,}\b/g) ?? []) {
    if (STOP.has(w) || nameWords.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const overused = [...counts].filter(([, n]) => n >= Math.max(4, Math.ceil(words / 70))).map(([w]) => w);
  if (overused.length) add('overused', 'info', `Used often: ${overused.slice(0, 3).join(', ')}. Vary the wording.`);

  for (const phrase of STOCK_PHRASES) {
    if (lower.includes(phrase)) { add('stock', 'info', `"${phrase}" is a stock phrase. Replace it with something specific.`); }
  }
  if (!master && company && !lower.includes(company.toLowerCase())) {
    add('no-company', 'warn', `The letter never names ${company}.`);
  }
  if (master && !/\{company\}/.test(raw)) {
    add('no-company-token', 'info', 'Add {company} where the employer\'s name belongs, so each letter names it.');
  }

  const weight = { block: 30, warn: 12, info: 4 };
  let score = Math.max(0, 100 - issues.reduce((sum, i) => sum + weight[i.level], 0));
  // A letter under ~100 words cannot carry one specific result per paragraph,
  // however clean its sentences are.
  if (words < 100) score = Math.min(score, 60);
  const hasWarn = issues.some((i) => i.level === 'warn');
  const label = issues.some((i) => i.level === 'block') ? 'Unfinished'
    : score >= 85 && !hasWarn ? 'Strong' : score >= 70 ? 'Good' : 'Needs work';
  return { words, paragraphs: body.length, score, label, issues };
}
