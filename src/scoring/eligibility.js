/**
 * Eligibility gates: does the posting's stated FLOOR — years of experience, a
 * degree, an active clearance — exclude this candidate?
 *
 * WHY THIS EXISTS. Fit scoring measured overlap (title, stack, domain) and
 * never read the requirement a recruiter screens on first. A "10+ years"
 * principal role and a "3+ years" mid-level role with the same stack scored the
 * same for a candidate with five years, so the board ranked jobs the candidate
 * would be screened out of beside jobs they clear.
 *
 * WHAT IT IS NOT. It is not an exclusion: an unmet floor is a PENALTY, bounded
 * and penalty-only like payFit (scoring.weights.eligibility, default 8 raw
 * points, nothing added to the denominator). Posted floors are soft in
 * practice, and extraction from free text is never certain, so a verdict here
 * must never silently delete a job. The only floor that already discards —
 * an active security clearance — stays in exclusionFilter.js and is REUSED
 * here (`hardClearanceRequirement`), never re-implemented.
 *
 * PRECISION RULES, each from a false positive seen on real descriptions:
 *   - company age: "for over 25 years", "a 100-year history", "in business for
 *     30 years" are about the employer, not the candidate;
 *   - preferred material: "5+ years preferred", a "Nice to have:" section, "a
 *     plus", "bonus" — never a floor;
 *   - a range "3-5 years" states its LOW end as the floor;
 *   - bare "N years" needs "experience" in its clause; the stronger forms ("N+",
 *     "at least N", "minimum of N", "N or more") stand on their own;
 *   - a degree "or equivalent experience" is not a hard floor, and "or foreign
 *     equivalent" does not soften anything.
 *
 * Every pattern is compiled once at module load; one assessment is a handful of
 * linear regex scans over the description.
 */

import { normalizeText } from '../utils/textNormalize.js';
import { hardClearanceRequirement } from './exclusionFilter.js';

/**
 * Version of the eligibility semantics, part of the scoring fingerprint. Bump
 * whenever extraction or verdict rules change so stored verdicts re-score.
 */
export const ELIGIBILITY_VERSION = 2;

/** Raw points an ineligible posting loses when scoring.weights.eligibility is unset. */
export const DEFAULT_ELIGIBILITY_PENALTY = 8;

/** Years short of the floor at which a posting is ineligible rather than a stretch. */
const INELIGIBLE_GAP_YEARS = 3;

/** A stated floor above this is not a hiring requirement (it is company age). */
const MAX_PLAUSIBLE_FLOOR = 20;

/* ───────────────────────── degree levels ───────────────────────── */

/** Ordered degree ladder. `none` is a high-school/GED path: no degree needed. */
export const DEGREE_LEVELS = Object.freeze({ none: 0, associate: 1, bachelor: 2, master: 3, doctorate: 4 });
const DEGREE_NAMES = Object.freeze({
  0: 'no degree', 1: "an associate's degree", 2: "a bachelor's degree", 3: "a master's degree", 4: 'a PhD',
});

/**
 * Degree mentions in a JOB DESCRIPTION. "master data" and "scrum master" are
 * deliberately unmatched: a master's needs "'s", "s", "of" or a degree word.
 */
const JD_DEGREE_PATTERNS = [
  // A PhD as a DEGREE ("PhD in", "a PhD", "PhD required"), not as a noun for
  // people ("the AI/ML PhD recruiting team").
  // Professional doctorates named by their letters, in a requirement's own words.
  [DEGREE_LEVELS.doctorate, /\b(?:j\.?d\.?|ll\.?m\.?|pharm\.?\s?d|dnp|d\.?n\.?p\.?)(?=\s*(?:or\b|and\b|degree|required|,|\/|\(|\.|;|$|from\b))/],
  [DEGREE_LEVELS.doctorate, /\b(?:ph\.?\s?d\b\.?|doctorate|doctoral\s+degree)(?=\s*(?:in\b|degree|required|or\b|and\b|with\b|,|\/|\(|\)|\.|;|:|$|preferred|level|program|candidates?\b|holders?\b|from\b|is\b))/],
  [DEGREE_LEVELS.master, /\b(?:msn\b|mph\b|msw\b|macc\b|m\.?acc\b|mpa\b|master'?s\b|masters\b|master\s+of\b|master(?=\s*(?:in\b|degree|\/|,|or\b))|m\.s\.|m\.sc\b|msc\b|m\.tech\b|mba\b|ms\s+(?:degree|in)\b|ms(?=\s*(?:,|\/|or\b))|graduate\s+degree\b|advanced\s+degree\b|m\.a\.\/m\.s\.)/],
  [DEGREE_LEVELS.bachelor, /\b(?:bsn\b|bba\b|bsba\b|bachelor'?s?\b|bachelors\b|b\.s\.|b\.a\.|bs\/ba\b|ba\/bs\b|bs\s+or\s+ba\b|b\.sc\b|bsc\b|b\.tech\b|b\.e\.|bs\s+(?:degree|in)\b|ba\s+(?:degree|in)\b|bs(?=\s*(?:,|\/|or\b))|undergraduate\s+degree\b|(?:4|four)[\s-]year\s+(?:college\s+|university\s+)?degree\b|(?:college|university)\s+degree\b)/],
  [DEGREE_LEVELS.associate, /\bassociate'?s?\s+degree\b|\b(?:2|two)[\s-]year\s+(?:college\s+)?degree\b/],
  [DEGREE_LEVELS.none, /\b(?:high\s+school\s+(?:diploma|degree|education)|hs\s+diploma|ged\b)/],
];

/**
 * Clauses that mention degrees without requiring one: tuition benefits ("from
 * high school completion to bachelor's degrees" — Walmart's Live Better U
 * blurb read as a bachelor's requirement), reimbursement, scholarships.
 */
const DEGREE_NOT_REQUIREMENT = /\b(?:tuition|reimburse\w*|education(?:al)?\s+(?:benefits?|assistance|programs?)|scholarships?|degrees\b|pay\s+(?:for|up\s+to)|we\s+offer|pursue|earn\s+(?:a|your))/;

/** Cheap prefilter: a clause that names no education cannot state a degree. */
const EDUCATION_HINT = /degree|bachelor|master|ph\.?\s?d|doctor|b\.[sae]\.|m\.[sa]\.|\bbs\b|\bba\b|\bms\b|msc|bsc|mba|b\.tech|m\.tech|high\s+school|\bged\b|diploma|\bbsn\b|\bmsn\b|\bbba\b|\bmph\b|\bmsw\b|\bj\.?d\b|\bll\.?m\b|pharm\.?\s?d|\bdnp\b/;

/** A candidate's degree string -> level. */
const CANDIDATE_DEGREE_PATTERNS = [
  [DEGREE_LEVELS.doctorate, /\b(?:ph\.?\s?d|doctor(?:ate)?\s+of|doctorate|d\.phil|ed\.?d|j\.?d|pharm\.?\s?d|dnp)\b/],
  [DEGREE_LEVELS.master, /\b(?:master|masters|m\.?s\.?c?|m\.?a\.?|mba|m\.?tech|m\.?eng|mca|mcs|mphil|msn|mph|msw|macc|mpa)\b/],
  // "BSN" (nursing) was unrecognised, so a nurse's degree read as unknown and
  // every degree floor on a nursing posting went unjudged.
  [DEGREE_LEVELS.bachelor, /\b(?:bachelor|bachelors|b\.?s\.?c?|b\.?a\.?|b\.?tech|b\.?e\.?|b\.?eng|bca|bcom|b\.?com|bsn|bba|bsba)\b/],
  [DEGREE_LEVELS.associate, /\b(?:associate|a\.?a\.?s?|a\.?s\.?)\b/],
];

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)';

/**
 * "or equivalent experience" and its relatives, in the degree's own clause.
 * "or foreign equivalent" / "or equivalent degree" do NOT soften anything —
 * they still require a degree.
 */
const DEGREE_EQUIVALENCE = new RegExp([
  '\\bor\\s+(?:an?\\s+|the\\s+)?equivalent\\b(?!\\s+(?:degree|foreign|international|qualification|university))',
  '\\bequivalent\\s+(?:combination|(?:work|practical|professional|industry|relevant)\\s+experience|experience)\\b',
  '\\bin\\s+lieu\\s+of\\b',
  '\\bor\\s+(?:related|relevant|comparable)\\s+(?:work\\s+|professional\\s+|industry\\s+)?experience\\b',
  '\\bcombination\\s+of\\s+(?:education|training|schooling|coursework)\\s+and\\s+(?:work\\s+|relevant\\s+)?experience\\b',
  `\\b(?:and\\/)?or\\s+${NUM}\\s*(?:\\+|plus)?\\s*(?:or\\s+more\\s+)?(?:additional\\s+)?(?:years?|yrs?)\\b`,
].join('|'));

/**
 * The same softening stated ANYWHERE in the posting, in forms specific enough
 * to be about the degree: "While possessing the stated degree is preferred,
 * Comcast also may consider ... some combination of coursework and experience"
 * sits two clauses away from "Bachelor's Degree".
 */
const DOCUMENT_EQUIVALENCE = /\bequivalent\s+combination\s+of\s+education\s+and\s+experience\b|\bcombination\s+of\s+(?:education|coursework|training|schooling)\s+and\s+(?:work\s+|relevant\s+)?experience\b|\bdegree\s+is\s+preferred\b|\bin\s+lieu\s+of\s+(?:a\s+)?degree\b|\bexperience\s+in\s+lieu\s+of\b/;

/* ───────────────────────── section + clause context ───────────────────────── */

/**
 * Clause-level cues that a requirement is optional. "preferably" and "ideally"
 * are deliberately absent: "5+ years, preferably in fintech" still requires
 * five years — the adverb qualifies the domain, not the floor.
 */
const PREFERRED_CUE = /\b(?:preferred|prefer|nice[\s-]to[\s-]haves?|a\s+plus|is\s+a\s+plus|plus\s+if|bonus|desired|desirable|advantageous|beneficial|would\s+be\s+great|good[\s-]to[\s-]have|not\s+required)\b/;

/**
 * Section headings: a short line of its own, or a short label before a colon.
 * A heading switches the "preferred section" state only when the WHOLE label
 * reads as one — a bullet like "Kafka experience is desired" is a clause, not
 * a heading, and must not mark everything after it optional.
 */
// The line end is a LOOKAHEAD: consuming it meant the newline before the next
// line was gone, so a "Preferred:" heading straight after a bullet line was
// never seen and everything under it counted as required.
const HEADING = /(^|\n)[ \t•*·\-#]*([a-z][a-z '&/()-]{2,60}?)[ \t]*(?=:|\n)/g;
const PREFERRED_HEADING = /^(?:(?:preferred|desired|desirable|bonus|additional|optional)(?:\s+(?:qualifications?|skills?|experience|requirements|attributes|points|knowledge))*|(?:nice|good)[\s-]to[\s-]haves?|pluses|extra\s+credit|(?:it'?s\s+)?(?:a\s+)?(?:big\s+)?plus(?:\s+if\s+you\s+have)?|what\s+(?:would\s+)?(?:makes?|sets?)\s+you\s+(?:stand\s+out|apart)|(?:you\s+)?(?:might|may)\s+also\s+have)$/;
/** Headings that END a preferred section. Generic labels must match whole. */
const OTHER_HEADING = /\b(?:qualifications|requirements|required|minimum|basic|must[\s-]haves?|what\s+you(?:'ll|\s+will)?\s+(?:need|bring)|who\s+you\s+are|about\s+you|you\s+have|responsibilities|what\s+you(?:'ll|\s+will)\s+do|benefits|about\s+(?:us|the\s+(?:company|team|role))|compensation|what\s+we\s+offer|perks)\b|^(?:(?:relevant\s+)?(?:work\s+|professional\s+)?experience(?:\s+(?:level|required))?|education(?:\s+(?:and|&)\s+experience)?|certifications?(?:\s+\(if\s+applicable\))?|skills|job\s+(?:summary|description|overview)|overview|summary)$/;
const MAX_HEADING_WORDS = 7;

/**
 * Clause boundaries: newline, bullet, semicolon, or a sentence-ending mark —
 * but not the dots of a one-letter abbreviation ("b.s.", "e.g.") or a common
 * one ("inc.", "sr.").
 */
const CLAUSE_BREAK = /\n|[•·;]|(?<![\s.(/][a-z])(?<!\b(?:etc|inc|ltd|co|jr|sr|vs|approx))[.!?](?=\s)/g;

/**
 * Split the text into clauses [{text, preferred}], `preferred` meaning the
 * clause sits in a preferred section or carries a preferred cue itself.
 * @param {string} text lowercased, newline-preserving
 */
function clausesOf(text) {
  const sections = [];
  HEADING.lastIndex = 0;
  let h;
  while ((h = HEADING.exec(text)) !== null) {
    const label = h[2].trim().replace(/\s+/g, ' ');
    if (label.split(' ').length > MAX_HEADING_WORDS) continue;
    if (PREFERRED_HEADING.test(label)) sections.push([h.index, true]);
    else if (OTHER_HEADING.test(label)) sections.push([h.index, false]);
  }
  const bounds = [];
  let start = 0;
  CLAUSE_BREAK.lastIndex = 0;
  let m;
  while ((m = CLAUSE_BREAK.exec(text)) !== null) {
    if (m.index > start) bounds.push([start, m.index]);
    start = m.index + 1;
  }
  if (text.length > start) bounds.push([start, text.length]);
  const clauses = [];
  let s = 0;
  let inPreferred = false;
  for (const [from, to] of bounds) {
    while (s < sections.length && sections[s][0] <= from) {
      inPreferred = sections[s][1];
      s += 1;
    }
    // A preferred ASIDE does not make its clause optional: in "5+ years of
    // experience (8+ preferred)" the floor is 5. The aside is removed so its
    // number is not read as the floor either.
    const clauseText = text.slice(from, to).replace(/\(([^)]*)\)/g, (m, inner) => (PREFERRED_CUE.test(inner) ? ' ' : m));
    if (!clauseText.trim()) continue;
    clauses.push({ text: clauseText, preferred: inPreferred || PREFERRED_CUE.test(clauseText) });
  }
  return clauses;
}

/**
 * The REQUIRED part of a description: every clause not in a preferred section
 * and carrying no preferred cue (see clausesOf). Scoring uses it to give a
 * skill named only under "Nice to have" less credit than a required one.
 * With no section structure at all, this is the whole text.
 *
 * @param {string} jdText raw description
 * @returns {string} lowercased required text
 */
export function requiredText(jdText) {
  const text = prepare(jdText);
  if (!text) return '';
  return clausesOf(text).filter((c) => !c.preferred).map((c) => c.text).join('\n');
}

/* ───────────────────────── years of experience ───────────────────────── */

/**
 * One years phrase: optional qualifier, a number (or "five (5)"), optional "+",
 * optional range end, then "years". Groups: 1 qualifier, 2 low, 3 paren digit,
 * 4 plus, 5 range high, 6 "or more".
 */
const YEARS_PHRASE = new RegExp(
  '(?:\\b(at\\s+least|a\\s+minimum\\s+of|minimum\\s+of|minimum|min\\.?|over|more\\s+than|in\\s+excess\\s+of)\\s+)?'
  + `\\b${NUM}(?:\\s*\\((\\d{1,2})\\))?\\s*(\\+|plus\\b)?`
  + `(?:\\s*(?:-|–|—|to)\\s*${NUM}\\s*\\+?)?`
  + '\\s*(or\\s+more\\s+|plus\\s+)?(?:years?|yrs?)\\b',
  'g',
);

/** Words directly after "years" that make it not a requirement. */
const YEARS_NOT_REQUIREMENT_AFTER = /^['’]?\s*(?:old\b|of\s+age\b|ago\b|in\s+business\b|of\s+(?:history|service|excellence|innovation|growth|success|operation|leadership\s+in\s+the)\b|warranty\b|from\s+now\b|history\b|running\b|in\s+a\s+row\b|of\s+serving\b)/;

/**
 * Context before the number that makes it the employer's age or a timeline:
 * "for over 25 years", "within 2 years", "over the past 10 years".
 */
const YEARS_NOT_REQUIREMENT_BEFORE = /(?:\b(?:founded|established|serving|served|trusted|history|legacy|heritage|been\s+around|in\s+business|decades?|(?:has|have|we've)\s+been|within|up\s+to|every|after|(?:in\s+)?the\s+(?:past|last|next|first)|for\s+(?:the\s+)?(?:past|last))\b[^\n]{0,40}|\bfor\s+(?:over\s+|nearly\s+|almost\s+|more\s+than\s+|close\s+to\s+)?)$/;

/**
 * "a transportation company with over 20 years of experience delivering…" —
 * the experience is the employer's. Rejected even though "experience" follows.
 */
const EMPLOYER_EXPERIENCE_BEFORE = /\b(?:company|firm|organization|organisation|business|agency|leader|provider|partner|brand|institution|we|who)\s+(?:with|that\s+has|has|have|brings?|bringing|boasts?)\s+(?:over\s+|more\s+than\s+|nearly\s+|almost\s+)?$/;

/** Bare "N years" needs an experience word somewhere in its clause. */
const EXPERIENCE_WORD = /\b(?:experience|exp\b|experienced|background|track\s+record|hands[\s-]on|working\s+(?:in|with|as|on)|professional|industry|relevant)\b/;

/** Alternatives between two years phrases: "8 years, or 6 with a master's". */
const ALTERNATIVE = /\bor\b|\balternatively\b/;

/** Any years count at all, including zero — marks an education + years path. */
const ANY_YEARS = new RegExp(`\\b(?:0|zero|${NUM.slice(1, -1)})\\s*\\+?\\s*(?:years?|yrs?)\\b`);

/** "Option 2: 5 years' experience" — Walmart-style alternative paths. */
const OPTION_CLAUSE = /^\s*(?:[-*•]\s*)?option\s+\d\b/;

function toNumber(token) {
  if (token === undefined) return null;
  return WORD_NUMBERS[token] ?? Number(token);
}

/**
 * Required years phrases in one clause, [{years, index}], company-age,
 * timeline and implausible numbers removed.
 */
/** "Experience (years): 5", "Years of experience: 4" — a form field, not prose. */
const KEY_VALUE_YEARS = /\b(?:years?\s+of\s+experience|experience\s*\(\s*(?:years?|yrs?)\s*\)|(?:years?|yrs?)\s+of\s+exp(?:erience)?|minimum\s+experience)\s*[:=]\s*(\d{1,2})\b/g;

function yearsIn(clauseText) {
  if (!clauseText.includes('year') && !clauseText.includes('yr')) return [];
  const found = [];
  KEY_VALUE_YEARS.lastIndex = 0;
  let kv;
  while ((kv = KEY_VALUE_YEARS.exec(clauseText)) !== null) {
    const n = Number(kv[1]);
    if (n >= 1 && n <= MAX_PLAUSIBLE_FLOOR) found.push({ years: n, index: kv.index });
  }
  const experienceInClause = EXPERIENCE_WORD.test(clauseText);
  YEARS_PHRASE.lastIndex = 0;
  let m;
  while ((m = YEARS_PHRASE.exec(clauseText)) !== null) {
    const low = toNumber(m[3] ?? m[2]);
    const high = m[5] !== undefined ? toNumber(m[5]) : null;
    if (!Number.isFinite(low) || low < 1 || low > MAX_PLAUSIBLE_FLOOR) continue;
    if (high !== null && (high < low || high > MAX_PLAUSIBLE_FLOOR + 5)) continue;
    const before = clauseText.slice(Math.max(0, m.index - 60), m.index);
    const after = clauseText.slice(m.index + m[0].length);
    if (YEARS_NOT_REQUIREMENT_AFTER.test(after)) continue;
    if (EMPLOYER_EXPERIENCE_BEFORE.test(before)) continue;
    if (YEARS_NOT_REQUIREMENT_BEFORE.test(before) && !experienceInClause) continue;
    // "over 15 years" / "more than 15 years" is how an employer states its
    // own age, so those qualifiers need an experience word like a bare number.
    const firm = m[1] && !/^(?:over|more|in\s+excess)/.test(m[1]);
    const strong = Boolean(firm || m[4] || m[6] || high !== null);
    if (!strong && !experienceInClause) continue;
    found.push({ years: low, index: m.index });
  }
  return found;
}

/**
 * One clause's floor: the LOWEST path when the clause offers education-keyed
 * alternatives ("8 years, or 6 with a master's"), otherwise the HIGHEST number —
 * "8+ years of platform experience, including 2+ years leading engineers"
 * requires eight, not two.
 */
function clauseFloor(clauseText, found) {
  let pick = found[0];
  for (let i = 1; i < found.length; i += 1) {
    const between = clauseText.slice(found[i - 1].index, found[i].index);
    // Only an education-qualified "or" offers another PATH; "8+ years of data
    // engineering or platform experience, including 2+ years leading" is one
    // requirement with a sub-requirement, and its floor is eight.
    const alternative = ALTERNATIVE.test(between) && EDUCATION_HINT.test(clauseText);
    if (alternative ? found[i].years < pick.years : found[i].years > pick.years) pick = found[i];
  }
  return pick;
}

/** Lowest education level named in a clause, or null. */
function degreeIn(clauseText) {
  if (!EDUCATION_HINT.test(clauseText) || DEGREE_NOT_REQUIREMENT.test(clauseText)) return null;
  let best = null;
  for (const [level, re] of JD_DEGREE_PATTERNS) {
    const m = re.exec(clauseText);
    if (m && (best === null || level < best.level)) best = { level, index: m.index };
  }
  // "5+ years (or Ph.D. with 3+ years)": a degree offered as an ALTERNATIVE to
  // experience, with no lower degree before it, is a shortcut, not a floor.
  if (best && /(?:\bor|\()\s*$/.test(clauseText.slice(Math.max(0, best.index - 6), best.index))) return null;
  // "Degree in Accounting, Finance or related field" names no level; the
  // ordinary reading is a bachelor's. Only when no level was named at all.
  if (!best) {
    const generic = /\b(?:a\s+)?(?:college\s+)?degree\s+in\b/.exec(clauseText);
    if (generic) best = { level: DEGREE_LEVELS.bachelor, index: generic.index };
  }
  return best;
}

/**
 * Both requirements from one pass over the description.
 *
 * Alternative PATHS are recognized across clauses: "Bachelor's degree and 10+
 * years, or" / "Master's degree and 6+ years" / "High school diploma and 12
 * years" each state one way in. When two or more clauses pair an education
 * level with years (or are labelled "Option N"), the posting's floor is the
 * EASIEST path — lowest years, lowest education — not the maximum of all of
 * them, which read "12 years AND a master's" out of a posting that required
 * neither.
 *
 * @param {string} jdText raw description
 * @returns {{years: object|null, degree: object|null}}
 */
export function analyzeRequirements(jdText) {
  const text = prepare(jdText);
  if (!text) return { years: null, degree: null };
  const clauses = clausesOf(text);
  const docEquivalent = DOCUMENT_EQUIVALENCE.test(text);

  let years = null;
  let preferredYears = null;
  let degree = null;
  const paths = [];

  for (const clause of clauses) {
    const found = yearsIn(clause.text);
    const edu = degreeIn(clause.text);
    if (clause.preferred) {
      if (found.length && !preferredYears) preferredYears = evidenceOf(clause.text, found[0].index);
      continue;
    }
    const floor = found.length ? clauseFloor(clause.text, found) : null;
    // "Master's with 0 years of experience" is a path too, though 0 is no floor.
    if ((edu && (floor || ANY_YEARS.test(clause.text))) || OPTION_CLAUSE.test(clause.text)) {
      paths.push({ clause, floor, edu });
      continue;
    }
    if (floor && (!years || floor.years > years.years)) {
      years = { years: floor.years, evidence: evidenceOf(clause.text, floor.index) };
    }
    if (edu && edu.level > DEGREE_LEVELS.none) {
      const equivalent = DEGREE_EQUIVALENCE.test(clause.text) || docEquivalent;
      if (!degree || edu.level > degree.level || (edu.level === degree.level && degree.equivalent && !equivalent)) {
        degree = { level: edu.level, equivalent, evidence: evidenceOf(clause.text, edu.index) };
      }
    }
  }

  if (paths.length === 1) {
    // A single "degree + years" clause is not an alternative; it is both.
    const [{ clause, floor, edu }] = paths;
    if (floor && (!years || floor.years > years.years)) {
      years = { years: floor.years, evidence: evidenceOf(clause.text, floor.index) };
    }
    if (edu && edu.level > DEGREE_LEVELS.none && (!degree || edu.level > degree.level)) {
      const equivalent = DEGREE_EQUIVALENCE.test(clause.text) || docEquivalent;
      degree = { level: edu.level, equivalent, evidence: evidenceOf(clause.text, edu.index) };
    }
  } else if (paths.length > 1) {
    const withYears = paths.filter((p) => p.floor);
    const easiest = withYears.reduce((a, b) => (b.floor.years < a.floor.years ? b : a), withYears[0]);
    if (easiest && (!years || easiest.floor.years > years.years)) {
      years = { years: easiest.floor.years, evidence: evidenceOf(easiest.clause.text, easiest.floor.index) };
    }
    // A path with no education named ("Option 2: 5 years' experience") means
    // no degree is required on that path.
    const lowest = paths.reduce((min, p) => Math.min(min, p.edu ? p.edu.level : DEGREE_LEVELS.none), Infinity);
    if (lowest > DEGREE_LEVELS.none && (!degree || lowest > degree.level)) {
      const p = paths.find((x) => x.edu?.level === lowest);
      degree = { level: lowest, equivalent: docEquivalent, evidence: evidenceOf(p.clause.text, p.edu.index) };
    }
  }

  return {
    years: years
      ? { years: years.years, evidence: years.evidence, preferredOnly: false }
      : (preferredYears ? { years: null, evidence: preferredYears, preferredOnly: true } : null),
    degree: degree ? { ...degree, label: DEGREE_NAMES[degree.level] } : null,
  };
}

/**
 * The required years-of-experience floor a description states.
 *
 * @param {string} jdText raw description (newlines matter: they bound clauses)
 * @returns {{years: number|null, evidence: string, preferredOnly: boolean}|null}
 *   null when no years requirement is stated at all; `preferredOnly` when the
 *   only years stated are preferred (then `years` is null)
 */
export function extractYearsRequirement(jdText) {
  return analyzeRequirements(jdText).years;
}

/**
 * The degree a description REQUIRES (preferred-only degrees are ignored).
 *
 * @param {string} jdText raw description
 * @returns {{level: number, label: string, equivalent: boolean, evidence: string}|null}
 */
export function extractDegreeRequirement(jdText) {
  return analyzeRequirements(jdText).degree;
}

/* ───────────────────────── candidate side ───────────────────────── */

/**
 * Template values copied from config/candidate.example.json ("Example Corp",
 * "Example University"). Measured: the live active profile still carried both,
 * so judging against them would grade real postings against invented history.
 * They are treated as unknown.
 */
const PLACEHOLDER = /^\s*(?:example|sample|your)\b/i;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a résumé date ("January 2020", "Jan 2020", "2020-01", "01/2020",
 * "2020") to a month index (year*12 + month). Null when unparseable.
 */
export function parseResumeMonth(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^([a-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 4)] !== undefined) return Number(m[2]) * 12 + MONTHS[m[1].slice(0, 4)];
  if (m && MONTHS[m[1].slice(0, 3)] !== undefined) return Number(m[2]) * 12 + MONTHS[m[1].slice(0, 3)];
  m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s);
  if (m) return Number(m[1]) * 12 + Math.min(11, Number(m[2]) - 1);
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return Number(m[2]) * 12 + Math.min(11, Number(m[1]) - 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return Number(m[1]) * 12;
  return null;
}

/**
 * The candidate's years of experience: stated (`background.yearsExperience`,
 * then `yearsExperience`), else derived from work-history dates with
 * overlapping roles merged. Null when unknown.
 *
 * @param {object} candidate
 * @param {Date} [now]
 * @returns {number|null} one decimal place
 */
export function candidateYearsOfExperience(candidate = {}, now = new Date()) {
  for (const v of [candidate?.background?.yearsExperience, candidate?.yearsExperience]) {
    const n = Number(v);
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0) return Math.round(n * 10) / 10;
  }
  const history = candidate?.background?.workHistory ?? candidate?.workHistory;
  if (!Array.isArray(history) || !history.length) return null;
  const nowMonth = now.getFullYear() * 12 + now.getMonth();
  const spans = [];
  for (const role of history) {
    if (!role || PLACEHOLDER.test(String(role.employer ?? role.company ?? ''))) continue;
    const start = parseResumeMonth(role.startDate);
    if (start === null) continue;
    const endRaw = String(role.endDate ?? '').trim().toLowerCase();
    const end = role.current || !endRaw || /^(?:present|current|now)$/.test(endRaw)
      ? nowMonth
      : parseResumeMonth(endRaw);
    if (end === null || end < start) continue;
    spans.push([start, Math.min(end, nowMonth) + 1]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curStart, curEnd] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else { months += curEnd - curStart; [curStart, curEnd] = [s, e]; }
  }
  months += curEnd - curStart;
  return Math.round((months / 12) * 10) / 10;
}

/**
 * The candidate's highest degree level (DEGREE_LEVELS), or null when unknown.
 * @param {object} candidate
 * @returns {number|null}
 */
export function candidateDegreeLevel(candidate = {}) {
  const education = candidate?.background?.education ?? candidate?.education;
  if (!Array.isArray(education)) return null;
  let best = null;
  for (const entry of education) {
    const degree = typeof entry === 'string' ? entry : entry?.degree;
    if (!degree || PLACEHOLDER.test(String(entry?.institution ?? ''))) continue;
    const d = String(degree).toLowerCase();
    for (const [level, re] of CANDIDATE_DEGREE_PATTERNS) {
      if (re.test(d)) { if (best === null || level > best) best = level; break; }
    }
  }
  return best;
}

/* ───────────────────────── licences and credentials ───────────────────────── */

/**
 * Credentials a posting can REQUIRE that no amount of fit makes up for: a
 * nurse practitioner role scored 88, Priority, for a registered nurse because
 * nothing read "Active Nurse Practitioner license required". Each entry is the
 * requirement as written and the evidence that the candidate holds it. Only a
 * clause that says required/must/active/current counts, and never a preferred
 * one, so "CPA preferred" is not a floor.
 */
const CREDENTIALS = Object.freeze([
  { label: 'a nurse practitioner license', re: /\b(?:nurse\s+practitioner|aprn|acnp(?:-bc)?|agacnp(?:-bc)?|fnp(?:-bc)?)\b/, held: /\b(?:nurse\s+practitioner|np|aprn|acnp|agacnp|fnp)\b/ },
  { label: 'a CPA license', re: /\bcpa\b/, held: /\bcpa\b/ },
  { label: 'a professional engineer (PE) license', re: /\b(?:pe\s+licen[cs]e|professional\s+engineer(?:ing)?\s+licen[cs]e|licensed\s+professional\s+engineer)\b/, held: /\b(?:pe|professional\s+engineer)\b/ },
  { label: 'a pharmacist license', re: /\b(?:pharmacist|rph)\s+licen[cs]e\b|\blicensed\s+pharmacist\b/, held: /\b(?:pharmacist|rph|pharm\.?\s?d)\b/ },
  { label: 'a DEA registration', re: /\bdea\s+(?:registration|licen[cs]e|number)\b/, held: /\bdea\b/ },
  { label: 'an RN license', re: /\b(?:rn|registered\s+nurse)\s+licen[cs]e\b|\blicensed\s+(?:as\s+an?\s+)?(?:rn|registered\s+nurse)\b/, held: /\b(?:rn|registered\s+nurse)\b/ },
  { label: 'admission to the bar', re: /\b(?:bar\s+admission|admitted\s+to\s+(?:practice|the\s+\w+\s+bar|the\s+bar)|licensed\s+attorney|active\s+bar\s+membership)\b/, held: /\b(?:bar|attorney|esq)\b/ },
  { label: 'a CFA charter', re: /\bcfa\s+(?:charter|charterholder|designation)\b/, held: /\bcfa\b/ },
]);
const REQUIRED_CUE = /\b(?:required|requires?|must|mandatory|active|current|valid|unrestricted)\b/;

/**
 * Required credentials a description names that the candidate's stated
 * certifications, skills and degrees do not show. Null when the candidate has
 * stated no certifications at all (nothing to compare: unknown, not unmet).
 *
 * @param {string} jdText
 * @param {object} candidate
 * @returns {string[]|null} labels of the missing credentials
 */
export function missingCredentials(jdText, candidate = {}) {
  const certs = candidate?.certifications ?? candidate?.background?.certifications;
  if (!Array.isArray(certs) || !certs.length) return null;
  const education = candidate?.background?.education ?? candidate?.education;
  const stack = candidate?.technicalStack ? Object.values(candidate.technicalStack).flat() : [];
  const have = normalizeText([...certs, ...stack,
    ...(Array.isArray(education) ? education.map((e) => (typeof e === 'string' ? e : e?.degree)) : [])]
    .filter((t) => typeof t === 'string').join(' \n '));
  const text = prepare(jdText);
  if (!text) return [];
  const missing = new Set();
  for (const clause of clausesOf(text)) {
    if (clause.preferred || !REQUIRED_CUE.test(clause.text)) continue;
    for (const cred of CREDENTIALS) {
      if (cred.re.test(clause.text) && !cred.held.test(have)) missing.add(cred.label);
    }
  }
  return [...missing];
}

/** A candidate who has stated they hold a clearance. */
function candidateHoldsClearance(candidate = {}) {
  const v = candidate?.securityClearance ?? candidate?.workAuthorization?.securityClearance;
  return Boolean(v) && !/^(?:none|no|false)$/i.test(String(v).trim());
}

/* ───────────────────────── verdict ───────────────────────── */

/**
 * Eligibility of one posting for one candidate.
 *
 * @param {{jdText?: string, title?: string}} job
 * @param {object} candidate parsed config/candidate.json
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object} [options.exclusions] config/exclusions.json — enables the
 *   clearance check (the same rule the exclusion stage applies)
 * @returns {{verdict: 'eligible'|'stretch'|'ineligible'|'unknown', reasons: string[],
 *   gapYears: number|null, blocking: boolean, requirements: object}} `blocking` is
 *   true when ineligibility has a cause other than years (degree, clearance)
 */
export function assessEligibility(job = {}, candidate = {}, { now = new Date(), exclusions = null } = {}) {
  const { years, degree } = analyzeRequirements(job.jdText);
  // Whole years, as a posting states them. It also keeps the verdict a function
  // of an integer the scoring fingerprint can hash: fractional tenure would
  // move the penalty (and invalidate every stored score) every month.
  const tenure = candidateYearsOfExperience(candidate, now);
  const haveYears = tenure === null ? null : Math.floor(tenure);
  const haveDegree = candidateDegreeLevel(candidate);
  const reasons = [];
  let ineligible = false;
  // Ineligible for a reason other than years (degree, clearance): full penalty.
  let blocking = false;
  let stretch = false;
  let judged = false;
  let gapYears = null;

  if (years?.years && haveYears !== null) {
    judged = true;
    const gap = years.years - haveYears;
    if (gap >= INELIGIBLE_GAP_YEARS) {
      ineligible = true; gapYears = gap;
      reasons.push(`requires ${years.years}+ years, you have ${haveYears} ("${years.evidence}")`);
    } else if (gap >= 1) {
      stretch = true; gapYears = gap;
      reasons.push(`requires ${years.years}+ years, you have ${haveYears} — a stretch ("${years.evidence}")`);
    }
  }

  if (degree && haveDegree !== null) {
    judged = true;
    if (degree.level > haveDegree) {
      if (degree.equivalent) {
        reasons.push(`asks for ${degree.label} or equivalent experience ("${degree.evidence}")`);
      } else {
        ineligible = true; blocking = true;
        reasons.push(`requires ${degree.label} ("${degree.evidence}")`);
      }
    }
  }

  // Only a MISSING credential is a judgement; none required says nothing
  // about whether the rest of the posting's floor is met.
  const credentials = missingCredentials(job.jdText, candidate);
  if (credentials?.length) {
    judged = true; ineligible = true; blocking = true;
    for (const label of credentials) reasons.push(`requires ${label}`);
  }

  // An ADVANCED degree floor (master's or above, no "or equivalent") that the
  // profile cannot answer is not a reason to rank a role at the top: a PhD
  // research post scored 90, Priority, for an engineer whose profile lists no
  // education. Reported so the tier can be held back; never a penalty.
  const advancedUnknown = Boolean(degree && !degree.equivalent && degree.level >= DEGREE_LEVELS.master && haveDegree === null);
  if (advancedUnknown) reasons.push(`asks for ${degree.label}, which your profile does not state ("${degree.evidence}")`);

  if (exclusions && !candidateHoldsClearance(candidate)) {
    const clearance = hardClearanceRequirement(normalizeText([job.title, job.jdText].join(' \n ')), exclusions);
    if (clearance) {
      judged = true; ineligible = true; blocking = true;
      reasons.push(`requires a security clearance (${clearance.join(', ')})`);
    }
  }

  // Nothing compared. If the posting states nothing checkable and the
  // candidate is known, nothing stands in the way; if the posting states a
  // floor the candidate's data cannot answer, say "unknown" rather than guess.
  if (!judged) {
    const unanswerable = (years?.years && haveYears === null) || (degree && haveDegree === null);
    judged = !unanswerable && (haveYears !== null || haveDegree !== null);
  }

  let verdict = 'unknown';
  if (ineligible) verdict = 'ineligible';
  else if (stretch) verdict = 'stretch';
  else if (judged) verdict = 'eligible';

  return {
    verdict,
    reasons,
    gapYears,
    blocking,
    advancedUnknown,
    requirements: {
      years: years?.years ?? null,
      yearsEvidence: years?.evidence ?? null,
      degree: degree ? degree.label : null,
      degreeEquivalent: degree?.equivalent ?? null,
      degreeEvidence: degree?.evidence ?? null,
    },
  };
}

/**
 * The score penalty for an eligibility verdict, as a breakdown entry — or null
 * when nothing is subtracted. Penalty-only: weight 0 in the denominator.
 *
 * Years short of the floor cost weight × gap/3 (linear, complete at the
 * ineligible gap); any other ineligibility costs the full weight.
 *
 * @param {ReturnType<typeof assessEligibility>} eligibility
 * @param {number} [weight] scoring.weights.eligibility
 * @returns {{points: number, weight: 0, matched: string[]}|null}
 */
export function eligibilityPenalty(eligibility, weight) {
  if (!eligibility || (eligibility.verdict !== 'stretch' && eligibility.verdict !== 'ineligible')) return null;
  const n = weight === null || weight === undefined || weight === '' ? NaN : Number(weight);
  const max = Number.isFinite(n) && n >= 0 ? n : DEFAULT_ELIGIBILITY_PENALTY;
  const share = eligibility.blocking
    ? 1
    : Math.min(1, (eligibility.gapYears ?? 0) / INELIGIBLE_GAP_YEARS);
  if (share <= 0) return null;
  return { points: -Math.round(max * share * 100) / 100, weight: 0, matched: eligibility.reasons };
}

/* ───────────────────────── helpers ───────────────────────── */

/** Lowercase, keep newlines (they bound clauses), fold curly apostrophes and nbsp. */
function prepare(jdText) {
  if (!jdText) return '';
  return String(jdText).toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    // Scraped descriptions keep non-breaking spaces as entities ("10+ years &#xa0").
    .replace(/&(?:nbsp|#xa0|#160);/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ');
}

/** A short, single-line quote around a match, for the explanation. */
function evidenceOf(clause, index) {
  const start = Math.max(0, index - 30);
  const text = clause.slice(start, index + 70).replace(/\s+/g, ' ').replace(/^[-*•·\s]+/, '').trim();
  return (start > 0 ? '…' : '') + text + (index + 70 < clause.length ? '…' : '');
}
