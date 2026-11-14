/**
 * Conditions buried in a job description that change whether the job is worth
 * applying to at all (audit Backlog #15).
 *
 * The motivating posting said "the first 90 days are 100% onsite, Monday to
 * Friday" in its eleventh paragraph, under a "Hybrid" location. Nobody reads
 * an 8,000-character description in a 360px rail closely enough to find that.
 *
 * Deterministic, pure and quote-backed: every callout carries the sentence it
 * came from, so the person can check it rather than trust it. Nothing here
 * scores or filters a job; it only says what the posting says.
 */

/** Longest quote kept per clause. */
const MAX_QUOTE = 220;

/**
 * [kind, label(match) -> string, pattern]. Patterns run on one sentence at a
 * time, lowercase. Order is display order: the hardest constraints first.
 */
const RULES = [
  ['clearance', () => 'Security clearance required',
    /\b(?:active|current|must (?:hold|have|possess)|requires?|required)\b[^.]{0,60}\b(?:ts\/sci|top secret|secret|public trust|security) clearance\b|\b(?:ts\/sci|top secret)\b[^.]{0,40}\brequired\b/],
  ['onsite_ramp', (m) => `Onsite for the first ${m[1]} ${m[2]}`,
    /\bfirst (\d{1,3}|thirty|sixty|ninety) (days|weeks|months)\b[^.]{0,80}\b(?:onsite|on-site|on site|in[- ]office|in the office)\b/],
  ['onsite_full', () => 'Fully onsite',
    /\b(?:100%|fully|five days a week|5 days a week|full[- ]time) (?:onsite|on-site|on site|in[- ]office|in the office)\b|\b(?:onsite|on-site|in[- ]office) (?:5|five) days(?: a| per)? week\b|\bthis is not a remote (?:role|position)\b|\bno remote\b/],
  ['travel', (m) => `Travel up to ${m[1]}%`,
    /\b(?:travel(?:ling)?(?: is)?(?: required)?(?: up to| of up to| approximately| about)?|up to) (\d{2,3})\s?%[^.]{0,30}\btravel|\btravel[^.]{0,40}?\b(?:up to |approximately |about )?(\d{2,3})\s?%/],
  ['on_call', () => 'On-call rotation',
    /\bon[- ]call\b(?! basis)|\bpager(?:duty)? rotation\b|\b24\s?\/\s?7 (?:support|coverage|rotation)\b/],
  ['shifts', () => 'Nights, weekends or rotating shifts',
    /\b(?:night|overnight|weekend|rotating|graveyard|evening) shifts?\b|\bmust be (?:able|willing) to work (?:nights|weekends|holidays)\b/],
  ['w2_only', () => 'W2 only (no C2C or 1099)',
    /\bw-?2 only\b|\bno c2c\b|\bno corp[- ]to[- ]corp\b|\bno 1099\b|\bnot (?:open to|accepting) c2c\b/],
  ['contract', (m) => (m[1] ? `Contract, ${m[1]} ${m[2] ?? 'months'}` : 'Contract role'),
    /\b(?:contract|temporary|temp) (?:role|position|assignment|engagement)\b(?:[^.]{0,40}?\b(\d{1,2})[- ](months?|weeks?)\b)?|\b(\d{1,2})[- ]month contract\b/],
  ['relocation', () => 'Relocation required',
    /\b(?:must|required to|will need to|willing to) relocate\b|\brelocation (?:is )?required\b/],
  ['citizenship', () => 'US citizenship required',
    /\b(?:must be|requires?|required to be) (?:a )?(?:u\.?s\.?|united states) citizen\b|\bu\.?s\.? citizenship (?:is )?required\b/],
  ['deadline', (m) => `Applications close ${m[1].replace(/^[a-z]/, (c) => c.toUpperCase())}`,
    /\b(?:applications?|this posting|posting) (?:will )?(?:close|closes|be accepted until|accepted through|deadline(?: is)?:?)\s+(?:on\s+)?([a-z]{3,9}\.? \d{1,2}(?:,? \d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/],
];

const WORD_NUM = { thirty: '30', sixty: '60', ninety: '90' };
const RAMP = /\bfirst (?:\d{1,3}|thirty|sixty|ninety) (?:days|weeks|months)\b/;

/** Split text into sentence-ish units without losing list items. */
function sentences(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+|\s*[•·▪●]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

/** A sentence that only negates the clause ("no on-call", "not required to relocate"). */
const NEGATED = /\b(?:no|not|never|without|zero)\b[^.]{0,20}$/;

/**
 * The dealbreaker-class clauses a posting states, each with its quote.
 *
 * @param {string} jdText the posting's description
 * @returns {Array<{kind: string, label: string, quote: string}>} at most one per kind
 */
export function extractHiddenClauses(jdText) {
  const out = [];
  const seen = new Set();
  const units = sentences(jdText);
  for (const [kind, label, pattern] of RULES) {
    for (const unit of units) {
      const lower = unit.toLowerCase();
      const m = pattern.exec(lower);
      if (!m) continue;
      // "There is no on-call rotation" states the opposite of the clause.
      if (kind !== 'onsite_full' && kind !== 'w2_only' && NEGATED.test(lower.slice(0, m.index))) continue;
      // "100% onsite for the first 90 days" is a ramp-up, not a fully onsite job.
      if (kind === 'onsite_full' && RAMP.test(lower)) continue;
      if (seen.has(kind)) break;
      seen.add(kind);
      const groups = m.slice(1).map((g) => (g && WORD_NUM[g] ? WORD_NUM[g] : g)).filter((g) => g !== undefined);
      const filled = [m[0], ...groups];
      out.push({
        kind,
        label: label(filled),
        quote: unit.length > MAX_QUOTE ? `${unit.slice(0, MAX_QUOTE - 1)}…` : unit,
      });
      break;
    }
  }
  return out;
}
