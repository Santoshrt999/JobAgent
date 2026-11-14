/**
 * Screening question answering (Section 6).
 *
 * Matches a screening question against config/screening_answers.json patterns and
 * returns a high-confidence answer or signals that the user must be asked. It is
 * deliberately conservative:
 *
 *   - If no pattern matches, it returns { action: 'ask_user' } (never guesses).
 *   - It NEVER produces a "no sponsorship required" style answer. Sponsorship and
 *     work-authorization answers always come straight from config (truthful).
 *   - All answers are drawn from config; nothing about the candidate is invented.
 */

import { normalizeText, normalizeForMatch, wholeWordIn } from '../utils/textNormalize.js';

/**
 * SPONSORSHIP TRUTH IS A PROPERTY OF THE PERSON, NOT A CONSTANT.
 *
 * This used to be one absolute blocklist of phrases an answer must never
 * contain. Every phrase on it claimed the candidate needs NO sponsorship, which
 * is a lie for someone on an H-1B — and the plain truth for a US citizen.
 *
 * Measured, before this change, for a candidate whose profile says
 * `requiresSponsorship: false`:
 *
 *   answer  "No, I do not require sponsorship to work in the United States."
 *   ->  assertTruthfulSponsorship  : { truthful: false }
 *   ->  validateAnswerEntry        : refused to SAVE it
 *   ->  answerScreeningQuestion    : refused to USE it -> ask_user, every time
 *
 * So the one machine in this repo built to stop a false statement reaching an
 * employer was preventing a truthful one instead, and sending every sponsorship
 * question to manual handling for anyone who does not need sponsorship.
 *
 * The rule is now symmetric and reads the profile: a claim is forbidden when it
 * CONTRADICTS the candidate's stated requirement, in whichever direction.
 */

/** Claims the candidate needs NO sponsorship. Untrue when they do. */
const NO_SPONSORSHIP_CLAIMS = [
  'no sponsorship required',
  'do not require sponsorship',
  'does not require sponsorship',
  'not require sponsorship',
  'no visa sponsorship needed',
];

/**
 * Claims the candidate DOES need sponsorship. Untrue when they do not.
 *
 * Matched only when stated AFFIRMATIVELY (see `claimsAffirmatively`): the
 * truthful answer "No, I do not require sponsorship" contains the substring
 * "require sponsorship", so a plain `includes` test here would forbid exactly
 * the sentence this change exists to permit.
 */
const NEEDS_SPONSORSHIP_CLAIMS = [
  'require sponsorship', 'requires sponsorship', 'will require sponsorship',
  'need sponsorship', 'needs sponsorship', 'will need sponsorship',
  'require visa sponsorship', 'need visa sponsorship',
  'require an employer to sponsor', 'need an employer to sponsor',
  'requires an employer to sponsor', 'seeking sponsorship',
  'h-1b transfer', 'h1b transfer', 'require a visa', 'need a visa',
];

/**
 * Kept for the callers and tests that import it, and still exactly the set of
 * claims forbidden when the candidate's requirement is unknown.
 */
const FORBIDDEN_ANSWER_FRAGMENTS = NO_SPONSORSHIP_CLAIMS;

export { FORBIDDEN_ANSWER_FRAGMENTS, NO_SPONSORSHIP_CLAIMS, NEEDS_SPONSORSHIP_CLAIMS };

/**
 * Questions about sponsorship / visa / work authorization. An answer here is a
 * factual representation of immigration status, so it gets stricter handling
 * than any other field on the form.
 */
const SPONSORSHIP_TOPIC_RE =
  /\b(sponsor(?:ship|ed|ing)?|visa|h-?1-?b|work\s+authoriz|authoriz(?:ed|ation)\s+to\s+work|right\s+to\s+work|employment\s+eligib|immigration\s+status)\b/i;

/**
 * Is this question ABOUT sponsorship / visa / work authorization at all?
 * Exported so the live filler can apply its read-back check to exactly the
 * questions `isInvertedSponsorshipQuestion` and the truthfulness guard judge.
 *
 * @param {string} question
 * @returns {boolean}
 */
export function isSponsorshipTopic(question) {
  return SPONSORSHIP_TOPIC_RE.test(String(question ?? ''));
}

/**
 * Negators that INVERT a sponsorship question's meaning.
 *
 * ATSes ask this both ways, and the two forms take opposite answers:
 *   "Do you REQUIRE sponsorship?"                        -> Yes
 *   "Can you work here WITHOUT sponsorship?"             -> No
 *   "Will you NOT require sponsorship?"                  -> No
 *
 * Bare "no" is deliberately excluded: it appears innocently in helper text
 * such as "(if no, choose No)" and would misfire constantly.
 */
const NEGATION_RE = new RegExp([
  '\\bwithout\\b',
  '\\bnot\\b',
  "\\bn't\\b",
  '\\bcannot\\b',
  '\\bnever\\b',
  '\\bno\\s+(?:visa\\s+|employer\\s+)?sponsorship\\b',
  '\\bno\\s+need\\b',
  '\\bfree\\s+(?:from|of)\\b',
  '\\bindependent\\s+of\\b',
  '\\bother\\s+than\\b',
  '\\bdo\\s+not\\b',
  '\\bdoes\\s+not\\b',
  '\\bwill\\s+not\\b',
].join('|'), 'i');

/** Answers that read as "yes" to whatever was asked. */
const AFFIRMATIVE_RE = /^\s*(?:yes|y|true|affirmative|i\s+(?:do|am|will))\b/i;

/**
 * Is this a sponsorship/authorization question whose meaning is INVERTED?
 *
 * Such a question cannot be answered from a pattern match: the stored answer
 * states the candidate's real need ("I require sponsorship"), and the question
 * asks for its opposite. Auto-inverting would be guessing about immigration
 * status, so the caller must defer to the human instead.
 *
 * @param {string} question raw question text
 * @returns {boolean}
 */
export function isInvertedSponsorshipQuestion(question) {
  const text = String(question ?? '');
  if (!SPONSORSHIP_TOPIC_RE.test(text)) return false;
  return NEGATION_RE.test(text);
}

/**
 * Verify a set of answers never misrepresents the candidate's sponsorship need.
 * Used as a final safety check before any submit.
 *
 * Two independent checks:
 *   1. The answer text itself must not contain a forbidden claim.
 *   2. An affirmative answer to an INVERTED sponsorship question is a
 *      misrepresentation even though its text ("Yes") is innocuous — so when a
 *      question/label is supplied, polarity is checked too. This is the case a
 *      pure phrase blocklist can never catch.
 *
 * @param {Array<{answer?: string, value?: string, label?: string, question?: string}>} answers
 * @param {object} [options]
 * @param {boolean} [options.requiresSponsorship] the candidate's real requirement.
 *   Omitted means unknown — see `contradictingSponsorshipClaim`.
 * @returns {{ truthful: boolean, violations: string[] }}
 */
export function assertTruthfulSponsorship(answers = [], { requiresSponsorship } = {}) {
  const violations = [];
  for (const a of answers) {
    const text = String(a?.answer ?? a?.value ?? '');
    if (isForbidden(text, requiresSponsorship)) {
      violations.push(text);
      continue;
    }
    const question = String(a?.label ?? a?.question ?? '');
    // "Yes" to "can you work WITHOUT sponsorship?" is a misrepresentation only
    // for someone who needs sponsorship. For a candidate who does not, it is
    // simply the right answer, and flagging it would block the truth again.
    if (requiresSponsorship !== false
      && question && isInvertedSponsorshipQuestion(question) && AFFIRMATIVE_RE.test(text)) {
      violations.push(
        `"${text.trim()}" answers an inverted sponsorship question ("${question.trim()}") `
        + 'as if no sponsorship were needed',
      );
    }
  }
  return { truthful: violations.length === 0, violations };
}

/**
 * Questions asking for a DURATION of experience.
 *
 * "10+ years" is a career total. Answering a question that qualifies its
 * subject ("...with SAP ABAP", "...in clinical trials") with a career total
 * states a specific number of years of experience with a technology the
 * candidate may never have touched. Verified against the shipped config before
 * this guard existed — all three returned "10+ years" at confidence 1.0:
 *
 *   "How many years of experience do you have with SAP ABAP?"
 *   "How many years of management experience do you have?"
 *   "How many years of experience do you have in clinical trials?"
 *
 * The `years_experience` entry matches the bare pattern "how many years", which
 * has no notion of years OF WHAT. See `experienceSubject`.
 */
const YEARS_QUESTION_RE = /\b(?:how\s+many\s+years|years?\s+of\s+experience|years?\s+experience|total\s+experience|length\s+of\s+experience)\b/i;

/**
 * Words that modify "experience" without naming a SUBJECT. "Professional",
 * "total" and "relevant" all still mean the candidate's career, so a career
 * total answers them honestly; "SAP ABAP" and "management" do not.
 */
const GENERIC_EXPERIENCE_MODIFIERS = new Set([
  'professional', 'total', 'overall', 'work', 'working', 'industry', 'relevant',
  'related', 'full', 'time', 'fulltime', 'full-time', 'paid', 'combined',
  'cumulative', 'applicable', 'direct', 'hands', 'on', 'hands-on', 'recent',
  'prior', 'previous', 'similar', 'equivalent', 'post', 'graduate', 'career',
  'your', 'you', 'have', 'do', 'the', 'a', 'an', 'of', 'in', 'with', 'and',
  'or', 'any', 'general', 'overall', 'real', 'world', 'real-world', 'years',
  'year', 'experience', 'please', 'specify', 'enter',
]);

/**
 * Patterns that expose the SUBJECT of a years-of-experience question.
 * Each must capture the subject in group 1.
 */
const SUBJECT_PATTERNS = [
  // "...years of experience [do you have] with|in|using|on|of <SUBJECT>".
  // The optional "do you have" clause matters: without it,
  // "How many years of experience do you have with SAP ABAP?" — the single most
  // common phrasing on real forms — read as unqualified and took the career total.
  /years?\s+(?:of\s+)?experience\s+(?:(?:do|does|did|have|has)\s+you\s+(?:have|had|got)?\s*)?(?:with|in|using|on|of|developing|supporting|administering|working\s+with|working\s+in)\s+(.+)/i,
  // "...how many years of <SUBJECT> experience"
  /how\s+many\s+years?\s+(?:of\s+)?(.+?)\s+experience\b/i,
  // "years of <SUBJECT> experience"
  /years?\s+of\s+(.+?)\s+experience\b/i,
  // "how many years have you worked with|in|on <SUBJECT>"
  /how\s+many\s+years?\s+have\s+you\s+(?:worked|used|spent|been)\s+(?:with|in|on|using)\s+(.+)/i,
  // "<SUBJECT> - years of experience" / "<SUBJECT>: years of experience"
  /^(.+?)\s*[-–—:]\s*(?:how\s+many\s+)?years?\s+of\s+experience/i,
];

/** Strip trailing question marks, parentheticals and filler. */
function tidySubject(raw) {
  return String(raw ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[?.!]+\s*$/, '')
    .replace(/\b(?:do|does|did)\s+you\s+have\b/gi, ' ')
    .replace(/\byou\s+have\b/gi, ' ')
    .replace(/[*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The thing a years-of-experience question is asking ABOUT, or null when it
 * asks about the candidate's career as a whole.
 *
 * @param {string} question raw question text
 * @returns {string|null} normalized subject, or null when unqualified
 */
export function experienceSubject(question) {
  const text = String(question ?? '');
  if (!YEARS_QUESTION_RE.test(text)) return null;

  for (const re of SUBJECT_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const subject = tidySubject(m[1]);
    if (!subject) continue;
    // A subject made only of generic modifiers ("professional", "total work")
    // is not a subject at all — the question is about the career.
    const words = normalizeText(subject).split(/[^a-z0-9+#.]+/).filter(Boolean);
    const meaningful = words.filter((w) => !GENERIC_EXPERIENCE_MODIFIERS.has(w));
    if (meaningful.length === 0) continue;
    return meaningful.join(' ');
  }
  return null;
}

/**
 * Look a subject up in the candidate's per-skill experience record.
 *
 * `candidate.skillExperience` is an OPTIONAL map of skill -> duration string
 * ({"python": "8 years"}). It is the only thing that can honestly answer a
 * qualified duration question. When it has no entry for the subject, the
 * question goes to the human — a career total must never stand in for it.
 *
 * @param {string} subject normalized subject from `experienceSubject`
 * @param {object} [candidate] parsed config/candidate.json
 * @returns {string|null} the recorded duration, or null
 */
export function lookupSkillExperience(subject, candidate) {
  const map = candidate?.skillExperience;
  if (!map || typeof map !== 'object' || !subject) return null;
  const want = normalizeText(subject);
  for (const [skill, years] of Object.entries(map)) {
    const key = normalizeText(skill);
    if (!key || !years) continue;
    // Exact, or the question's subject names the skill as a whole word
    // ("experience with azure databricks" -> "databricks").
    if (key === want || wholeWordIn(want, key)) return String(years);
  }
  return null;
}

/**
 * @param {string} question raw screening question text
 * @param {object} screeningAnswers parsed config/screening_answers.json
 * @param {object} [options]
 * @param {string[]} [options.choices] available options for choice questions
 * @param {object} [options.candidate] parsed config/candidate.json — supplies
 *   `skillExperience` for qualified duration questions
 * @returns {{
 *   answered: boolean,
 *   action: 'answer'|'ask_user',
 *   matchedId: string|null,
 *   answer: string|null,
 *   type: string|null,
 *   confidence: number
 * }}
 */
export function answerScreeningQuestion(question, screeningAnswers, { choices, candidate } = {}) {
  const answers = effectiveAnswers(screeningAnswers);
  const defaults = screeningAnswers.defaults ?? {};

  // A QUALIFIED duration question ("years of experience with SAP ABAP") can only
  // be answered from a per-skill record. The stored `years_experience` answer is
  // a career total with no subject binding, and letting it match here stated a
  // specific number of years with a technology the candidate may never have used
  // — at confidence 1.0, on a real employer's form. Never let an unqualified
  // total answer a qualified question.
  const subject = experienceSubject(question);
  if (subject) {
    const recorded = lookupSkillExperience(subject, candidate);
    if (recorded) {
      return {
        answered: true,
        action: 'answer',
        matchedId: 'skill_experience',
        answer: recorded,
        type: 'text',
        confidence: 1,
        subject,
      };
    }
    return {
      ...askUser(defaults),
      // Like the inverted sponsorship case, this must reach the human even when
      // defaults.unknownAction is 'skip': a blank is honest, a guess is not.
      action: 'ask_user',
      subject,
      reason: `asks how long you have worked with "${subject}" — add it to `
        + 'candidate.skillExperience or answer it yourself; your career total does not apply',
    };
  }

  // An inverted sponsorship question ("…work WITHOUT sponsorship?", "…will you
  // NOT require…?") asks for the opposite of what the stored answer states.
  // Pattern matching is polarity-blind, so answering here would assert
  // something untrue about the candidate's immigration status. Always defer to
  // the human — inverting the answer ourselves would be a guess.
  if (isInvertedSponsorshipQuestion(question)) {
    return {
      ...askUser(defaults),
      // Never silently skip this one: even when defaults.unknownAction is
      // 'skip', a required inverted sponsorship question must reach the human.
      action: 'ask_user',
      reason: 'inverted sponsorship question — needs your explicit answer',
    };
  }

  // Match against the question being ASKED, not its follow-up or aside:
  // "Have you worked for Acme before? If so, what was your start date?" asks
  // about prior employment; "start date" in the follow-up must not answer it.
  const asked = mainClause(question);
  const askedText = normalizeText(asked);

  // Every entry that matches, strongest first; on a tie the entry listed first
  // wins, as before. A pay answer stated per YEAR does not answer a question
  // asked per MONTH or per HOUR, so a candidate whose pay period disagrees with
  // the question is passed over for one that agrees.
  const matched = [];
  answers.forEach((entry, index) => {
    const { score, pattern } = matchScoreDetail(askedText, entry.patterns ?? []);
    if (score > 0) matched.push({ entry, score, pattern, index });
  });
  matched.sort((a, b) => b.score - a.score || a.index - b.index);
  // The unit is often in an aside ("(In USD per month)"), so read it from the
  // whole question, not the main clause.
  const period = payPeriodOf(question);
  let pick = matched.find((m) => !period || !statesPay(m.entry.answer) || payPeriodOf(m.entry.answer) === period)
    ?? null;
  // A pay question whose matched answer is in the wrong unit: the same pay
  // answer in the question's unit, if one is stored and the question mentions
  // anything it lists, is the same answer to the same question.
  if (!pick && period && matched.some((m) => statesPay(m.entry.answer))) {
    const full = normalizeForMatch(normalizeText(question));
    const alt = answers.find((e) => statesPay(e.answer) && payPeriodOf(e.answer) === period
      && (e.patterns ?? []).some((pt) => {
        const q = normalizeForMatch(pt).replace(/[^a-z0-9+#]+$/, '').trim();
        return q && wholeWordIn(full, q);
      }));
    if (alt) pick = { entry: alt, score: MAX_SCATTERED_SCORE, pattern: null };
  }
  if (!pick) return askUser(defaults);
  const { entry: best, score: bestScore, pattern: bestPattern } = pick;

  // SENSITIVE TOPICS. A stored answer may be about the same WORDS and still not
  // be about this question: "background check" answered "Have you ever FAILED a
  // background check?" with "Yes", and "will you require" answered "Will you
  // require an ACCOMMODATION?" with the sponsorship answer. For these topics an
  // answer is used only when it was saved for this very question (a pattern
  // that covers every content word of it) or is explicitly tagged for the topic.
  const topic = sensitiveTopic(asked);
  if (topic && !entryCovers(best, topic, bestPattern, askedText)) {
    return { ...askUser(defaults), action: 'ask_user', reason: `${topic.replace(/_/g, ' ')} question — answer it yourself` };
  }

  const answer = String(best.answer ?? '');
  // A question about ANOTHER COUNTRY ("authorized to work in Canada?",
  // "willing to relocate to Germany?") is not answered by a statement about the
  // United States. Unless the stored answer names that country, ask.
  const elsewhere = foreignCountryIn(asked);
  if (elsewhere && !normalizeText(answer).includes(elsewhere)) {
    return { ...askUser(defaults), action: 'ask_user', reason: `asks about ${elsewhere}, which your saved answer does not mention` };
  }
  // Safety net: refuse to emit any answer that CONTRADICTS the candidate's own
  // stated work authorization — in either direction.
  if (isForbidden(answer, candidateRequiresSponsorship(candidate))) {
    return askUser(defaults);
  }

  // For multiple-choice questions, only answer if our value maps to a choice.
  if (Array.isArray(choices) && choices.length) {
    const aboutAuthorization = (best.patterns ?? []).some((p) => AUTHORIZATION_QUESTION.test(String(p)));
    const mapped = mapToChoice(answer, best.type, choices)
      ?? (aboutAuthorization ? authorizationChoice(asked, answer, choices, { status: candidate?.workAuthorization?.status }) : null);
    if (mapped === null) return askUser(defaults);
    return { answered: true, action: 'answer', matchedId: best.id, answer: mapped, type: best.type ?? 'text', confidence: bestScore };
  }

  return { answered: true, action: 'answer', matchedId: best.id, answer, type: best.type ?? 'text', confidence: bestScore };
}

/**
 * The answers to match against: the active profile's DERIVED answers, then the
 * user's own.
 *
 * Derived entries replace a stored entry with the same id and are listed first,
 * so on an equal match they win. That precedence is the point: the stored
 * `require_sponsorship` and `work_authorization` entries state a person's
 * immigration status, and after switching profiles they describe the WRONG
 * person. A generated answer cannot disagree with the profile it came from.
 *
 * Everything the profile does not state is left entirely alone, so hand-written
 * answers to questions only the user can answer survive untouched.
 *
 * @param {object} screeningAnswers parsed config/screening_answers.json
 * @returns {object[]} entries to match, highest precedence first
 */
export function effectiveAnswers(screeningAnswers = {}) {
  const stored = Array.isArray(screeningAnswers.answers) ? screeningAnswers.answers : [];
  const derived = Array.isArray(screeningAnswers.derivedAnswers) ? screeningAnswers.derivedAnswers : [];
  // Questions the ACTIVE PROFILE owns, whether or not it could answer them.
  //
  // Shadowing by derived id alone left a hole exactly where it mattered most.
  // A profile that states its salary replaces the previous person's salary
  // answer; a profile that states NOTHING derives nothing, shadows nothing,
  // and the previous person's answer remains the best match for the question.
  // Measured: a profile with no stated experience and no stated salary
  // answered "12+ years" and "180,000 USD", both somebody else's.
  //
  // So silence shadows too. An owned question the profile cannot answer is
  // withheld entirely and falls through to the human, which is the honest
  // outcome — the alternative is a confident statement about a person that
  // nobody made about them.
  const owned = new Set(
    (Array.isArray(screeningAnswers.profileOwnedAnswerIds) ? screeningAnswers.profileOwnedAnswerIds : [])
      .map((id) => String(id ?? '').toLowerCase()).filter(Boolean),
  );
  const derivedIds = new Set(derived.map((e) => String(e?.id ?? '').toLowerCase()).filter(Boolean));
  if (!derived.length && !owned.size && !screeningAnswers.profileId) return stored;

  // An owned question the user answered THEMSELVES, under the profile that is
  // active now, is still their answer and is still used. `profileId` is stamped
  // when the answer is saved (see `upsertScreeningAnswer`); an answer with no
  // stamp predates profiles, so it cannot be shown to belong to this candidate
  // and is withheld.
  const activeProfileId = String(screeningAnswers.profileId ?? '');
  const keep = (entry) => {
    const id = String(entry?.id ?? '').toLowerCase();
    if (derivedIds.has(id)) return false;       // the profile answered it itself
    // An answer stamped as ANOTHER candidate's is theirs, whatever the question
    // (education, EEO, clearance, prior employer): never used for this one.
    const owner = String(entry?.profileId ?? '');
    if (owner && activeProfileId && owner !== activeProfileId) return false;
    if (!owned.has(id)) return true;            // not a profile-owned question
    return Boolean(activeProfileId) && String(entry?.profileId ?? '') === activeProfileId;
  };
  return [...derived, ...stored.filter(keep)];
}

/**
 * Filler words that carry no identifying weight. Counting them inflated the
 * word-fraction score: the pattern "sponsorship to work" scored a perfect 3/3
 * against any sentence containing those three tokens in any arrangement, which
 * is how one entry hijacked questions meant for another.
 */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or',
  'do', 'does', 'did', 'will', 'would', 'is', 'are', 'was', 'be', 'been',
  'you', 'your', 'yours', 'we', 'our', 'us', 'i', 'my', 'me', 'this', 'that',
  'have', 'has', 'had', 'can', 'any', 'if', 'as', 'it', 'its',
]);

/** Highest score a scattered (non-contiguous) word match may earn. */
const MAX_SCATTERED_SCORE = 0.8;

/**
 * Confidence that `patterns` identify `text`, taking the strongest pattern.
 *
 * WHOLE-WORD matching only: the EEO pattern "race" must match "Race/Ethnicity"
 * but never "embrace diversity" — a substring hit would write a demographic
 * answer into an unrelated free-text field.
 *
 * An exact contiguous phrase always outranks a scattered match, so when two
 * entries both plausibly match, the one that matched as a real phrase wins.
 * Scattered matches must additionally cover EVERY content word and have at
 * least two of them, so a lone keyword can never drag in a whole answer.
 */
/**
 * Words that carry no subject: stopwords plus question scaffolding. A pattern
 * needs at least two words OUTSIDE this set to match a longer question on its
 * own — "will you require" (one: "require") answered accommodation and
 * relocation-assistance questions with the sponsorship answer, "per month"
 * (one: "month") answered "How many hours per month can you travel?" with a
 * monthly salary, and "how many years" (one: "years") answered "How many years
 * have you lived at your current address?" with a career total.
 */
const SCAFFOLD = new Set([
  ...STOPWORDS, 'how', 'many', 'much', 'what', 'which', 'when', 'where', 'why', 'who', 'whom',
  'please', 'describe', 'provide', 'enter', 'list', 'per', 'any', 'so', 'yes', 'no', 'not',
]);

/** Content words of normalized, singularized text. */
function contentWordsOf(normalized) {
  return normalized.split(' ')
    .map((w) => w.replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/g, ''))
    .filter((w) => w && !SCAFFOLD.has(w));
}

/**
 * The strongest pattern match, and which pattern made it.
 * @returns {{score: number, pattern: string|null}}
 */
function matchScoreDetail(text, patterns) {
  let best = 0;
  let bestPattern = null;
  // Both sides are singularized so a plural phrasing matches a singular pattern
  // (see normalizeForMatch). "What are your salary expectations?" used to miss.
  const matchText = normalizeForMatch(text);
  const whole = matchText.replace(/[^a-z0-9+#]+$/, '').trim();
  const questionWords = new Set(contentWordsOf(matchText));
  const questionTopic = sensitiveTopic(text);
  for (const pattern of patterns) {
    // A pattern ending in "?" or "." can never satisfy the word boundary.
    const p = normalizeForMatch(pattern).replace(/[^a-z0-9+#]+$/, '').trim();
    if (!p) continue;
    const content = contentWordsOf(p);
    // One subject word is enough only when it is the WHOLE question
    // ("Salary?" against "salary"), when the pattern IS the question ("Why
    // us?"), or when it names the same sensitive topic the question is about
    // (an EEO answer saved under "race" for "Race/Ethnicity").
    const thin = content.length < 2
      && !(content.length === 1 && questionWords.size === 1)
      && p !== whole
      && !(questionTopic && sensitiveTopic(p) === questionTopic);
    // 1. Exact contiguous phrase — highest confidence.
    if (wholeWordIn(matchText, p)) {
      if (thin) continue;
      if (best < 1) { best = 1; bestPattern = pattern; }
      continue;
    }
    // 2. Scattered content words — every one must be present, min two.
    const scattered = p.split(' ').filter((w) => w && !STOPWORDS.has(w));
    if (scattered.length < 2 || thin) continue;
    const hit = scattered.filter((w) => wholeWordIn(matchText, w)).length;
    if (hit === scattered.length && best < MAX_SCATTERED_SCORE) { best = MAX_SCATTERED_SCORE; bestPattern = pattern; }
  }
  return { score: best, pattern: bestPattern };
}

/**
 * The part of a question that is actually being asked: the first sentence
 * when a follow-up comes after it ("...? If so, ..."), with parenthetical
 * asides removed ("(subject to background check)"). Falls back to the whole
 * text when that would leave nothing.
 *
 * @param {string} question
 * @returns {string}
 */
export function mainClause(question) {
  const raw = String(question ?? '');
  const noAside = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || raw;
  const firstQ = noAside.indexOf('?');
  if (firstQ > 0 && noAside.slice(firstQ + 1).trim().length > 0) {
    const head = noAside.slice(0, firstQ + 1).trim();
    if (head.replace(/[^a-z]/gi, '').length >= 8) return head;
  }
  return noAside;
}

/**
 * Topics where a wrong answer is worse than none, and where sharing words with a
 * stored answer says nothing about meaning. Each maps to a topic id an answer
 * entry may declare in `topics` to be used for it.
 */
const SENSITIVE_TOPICS = [
  ['negative_history', /\b(?:fail(?:ed|ure)?\s+(?:a|an|any|the)?\s*(?:background|drug|screen)|denied|convicted|conviction|terminated|fired|dismissed|discharged|refused|revoked|disciplin\w*|suspended|arrested|felon\w*|misdemeanou?r|guilty|debarred|sanctioned|pled|pleaded)\b/i],
  ['criminal_history', /\bcriminal\b/i],
  ['accommodation', /\b(?:accommodations?|disabilit(?:y|ies)|disabled|medical\s+condition|health\s+condition|impairment)\b/i],
  ['age', /\b(?:age|date\s+of\s+birth|birth\s*date|born|years\s+old)\b/i],
  ['demographic', /\b(?:gender|sex|race|racial|ethnic\w*|veteran|sexual\s+orientation|marital|pregnan\w*|religio\w*|national\s+origin)\b/i],
];

/** The sensitive topic a question is about, or null. */
export function sensitiveTopic(question) {
  const text = String(question ?? '');
  for (const [id, re] of SENSITIVE_TOPICS) if (re.test(text)) return id;
  return null;
}

/**
 * May this entry answer a question on a sensitive topic? Only when it is
 * tagged for the topic, or the pattern that matched covers every content word
 * of the question (the user saved an answer to exactly this question).
 */
function entryCovers(entry, topic, pattern, askedText) {
  const topics = Array.isArray(entry?.topics) ? entry.topics.map((t) => String(t).toLowerCase()) : [];
  if (topics.includes(topic)) return true;
  // An answer whose OWN patterns are about this topic was saved for it
  // ("race", "ethnicity" for an EEO answer). One that merely shares words
  // with the question ("will you require", "background check") was not.
  if ((entry?.patterns ?? []).some((p) => sensitiveTopic(p) === topic)) return true;
  if (!pattern) return false;
  const have = new Set(contentWordsOf(normalizeForMatch(pattern)));
  const need = contentWordsOf(normalizeForMatch(askedText));
  return need.length > 0 && need.every((w) => have.has(w));
}

/**
 * Countries (other than the United States) a question may ask about. Matched
 * as whole words on normalized text; the returned name is normalized too.
 */
const OTHER_COUNTRIES = [
  'canada', 'united kingdom', 'uk', 'england', 'scotland', 'ireland', 'germany', 'france', 'spain',
  'portugal', 'italy', 'netherlands', 'belgium', 'switzerland', 'austria', 'sweden', 'norway',
  'denmark', 'finland', 'poland', 'czech republic', 'romania', 'european union', 'eu', 'india',
  'china', 'japan', 'singapore', 'australia', 'new zealand', 'mexico', 'brazil', 'argentina',
  'israel', 'south africa', 'philippines', 'united arab emirates', 'uae', 'hong kong', 'korea',
];

/** The pay period a text names: 'hour', 'month', 'year', or null. */
export function payPeriodOf(text) {
  const t = String(text ?? '').toLowerCase();
  if (/\b(?:per\s+hour|hourly|an\s+hour|\/\s*(?:hr|hour)\b)/.test(t)) return 'hour';
  if (/\b(?:per\s+month|monthly|a\s+month|\/\s*mo(?:nth)?\b)/.test(t)) return 'month';
  if (/\b(?:per\s+(?:year|annum)|annual(?:ly)?|yearly|a\s+year|\/\s*(?:yr|year)\b)/.test(t)) return 'year';
  return null;
}

/** Does an answer state an amount of money? */
function statesPay(answer) {
  return /\$\s*\d|\b\d[\d,.]*\s*(?:k\b|usd|dollars|per\s+(?:hour|month|year))/i.test(String(answer ?? ''));
}

/** The non-US country a question names, or null. */
export function foreignCountryIn(question) {
  const text = normalizeText(question);
  return OTHER_COUNTRIES.find((c) => wholeWordIn(text, c)) ?? null;
}

/**
 * Map a stored answer onto one of the live form's choices, or null.
 *
 * Exported for tests. Partial matches are WHOLE-WORD in both directions: the
 * substring test this replaced mapped the answer "No" onto the choice
 * "Now or in the future" (and onto "…will NOT require sponsorship"), writing
 * the opposite immigration answer from the one configured.
 *
 * @param {string} answer
 * @param {string|null} type
 * @param {string[]} choices
 * @returns {string|null}
 */
export function mapToChoice(answer, type, choices) {
  const norm = normalizeText(answer);
  // Boolean-style questions.
  if (type === 'boolean_yes' || /^yes\b/.test(norm)) {
    const yes = choices.find((c) => /^(yes|y)\b/i.test(c.trim()));
    if (yes) return yes;
  }
  if (/^no\b/.test(norm)) {
    const no = choices.find((c) => /^(no|n)\b/i.test(c.trim()));
    if (no) return no;
  }
  // Direct/whole-word match against a provided choice.
  const direct = choices.find((c) => normalizeText(c) === norm);
  if (direct) return direct;
  const partial = choices.find((c) => {
    const choice = normalizeText(c);
    return choice && (wholeWordIn(norm, choice) || wholeWordIn(choice, norm));
  });
  return partial ?? null;
}

/** A question asking ONLY whether the candidate may work (in the US). */
const AUTHORIZATION_QUESTION = /\b(?:legally\s+)?(?:authori[sz]ed|eligible|permitted|entitled)\s+to\s+work\b|\bwork\s+authori[sz]ation\b|\bright\s+to\s+work\b/i;
/** ...and one that also asks about sponsorship or a visa is a different question. */
const SPONSORSHIP_WORDS = /\b(?:sponsor\w*|visas?|h-?1-?b|opt|cpt|green\s*card|immigration)\b/i;
/**
 * Narrower questions a visa holder may have to answer "No" to, although they
 * are authorized to work: "for ANY employer", "without restriction", "are you
 * a citizen or permanent resident".
 */
const RESTRICTED_AUTHORIZATION = /\bany\s+(?:u\.?s\.?\s+)?employer\b|\bwithout\s+(?:any\s+)?restrictions?\b|\bunrestricted\b|\bcitizen\w*\b|\bpermanent\s+resident\b|\bnational\b/i;
/** An answer that STATES authorization ("... authorized to work in the United States ..."). */
const STATES_AUTHORIZED = /\b(?:authori[sz]ed|eligible|permitted)\s+to\s+work\b/i;
const DENIES_AUTHORIZED = /\b(?:not|n't|never|un)\s*(?:currently\s+|yet\s+|legally\s+)?(?:authori[sz]ed|eligible|permitted)\b|\bno\s+(?:work\s+)?authori[sz]ation\b/i;

/**
 * "Yes" for a Yes/No "Are you legally authorized to work in the United
 * States?" when the saved answer states that the candidate is.
 *
 * The derived work-authorization answer is a sentence ("H-1B — authorized to
 * work in the United States, and will need continued visa sponsorship."), and
 * mapToChoice only reads a LEADING yes/no, so the question went to the person
 * although the profile answers it (2026-11-12, a Rippling posting). Only the
 * affirmative is inferred, never "No"; never for a question that also asks
 * about sponsorship or a visa (that one has two answers), and never when the
 * answer denies authorization anywhere. Another country is refused earlier
 * (foreignCountryIn).
 *
 * @returns {string|null} the "Yes" choice, or null
 */
export function authorizationChoice(question, answer, choices = [], { status } = {}) {
  const q = String(question ?? '');
  if (!AUTHORIZATION_QUESTION.test(q) || SPONSORSHIP_WORDS.test(q) || RESTRICTED_AUTHORIZATION.test(q)) return null;
  const a = String(answer ?? '');
  if (DENIES_AUTHORIZED.test(a)) return null;
  // The answer says so, or the profile's stated status is one that grants US
  // work authorization (see statusGrantsWork). The profile deriver already
  // states "<status> — authorized to work in the United States" from the
  // status alone; a person's own wording ("Currently on H-1B; requires
  // transfer and continued sponsorship.") says the same without those words.
  if (!STATES_AUTHORIZED.test(a) && !statusGrantsWork(status)) return null;
  return choices.find((c) => /^(yes|y)\b/i.test(String(c).trim())) ?? null;
}

/**
 * US immigration statuses that carry authorization to work, as a profile
 * states them. A status that is pending, expired, applied for or sought is
 * not one, and neither is anything not on this list (J-1, CPT, F-1 without
 * OPT, B-1/B-2): those are left to the person.
 */
const WORK_AUTHORIZING_STATUS = /\b(?:u\.?s\.?\s+)?citizen\b|\bpermanent\s+resident\b|\bgreen\s*card\b|\blpr\b|\bh-?1-?b1?\b|\bh-?4\s*ead\b|\bl-?1[ab]?\b|\bl-?2\s*ead\b|\bo-?1\b|\btn\b|\be-?3\b|\bead\b|\b(?:stem\s+)?opt\b|\basylee\b|\brefugee\b|\btps\b|\bdaca\b/i;
const NOT_YET_STATUS = /\b(?:pending|expired?|expiring|lapsed|applied|applying|apply|awaiting|seeking|need(?:s|ed)?|will\s+need|requires?\s+(?:a\s+)?(?:new|initial)|not|no)\b/i;

/** Does the profile's stated work status grant authorization to work in the US? */
export function statusGrantsWork(status) {
  const s = String(status ?? '').trim();
  return Boolean(s) && WORK_AUTHORIZING_STATUS.test(s) && !NOT_YET_STATUS.test(s);
}

/**
 * Framings that MENTION a requirement without asserting it: questions,
 * conditionals, and the second-person instructions used in template text.
 *
 * Needed because a phrase test alone cannot tell a claim from a prompt. The
 * shipped placeholder "state whether you need visa sponsorship now or in the
 * future" contains the phrase and no negation, and was read as the candidate
 * asserting they need sponsorship — which then refused to save an unrelated
 * answer in the same file.
 */
const NON_ASSERTION_RE =
  /\b(whether|if\s+you|do\s+you|does\s+the|are\s+you|will\s+you|would\s+you|can\s+you|please|state\s+|e\.?g\.?|for\s+example|your\s+truthful)\b/i;

/**
 * Does `text` assert `phrase` rather than merely mention or deny it?
 *
 * Clause-scoped on purpose. "No, I do not require sponsorship" and "I require
 * sponsorship" both contain the phrase; only the second one claims it. Splitting
 * on clause boundaries keeps a negation attached to the clause it governs, so a
 * "not" elsewhere in a long answer cannot silently excuse a real claim.
 */
function claimsAffirmatively(text, phrase) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower.includes(phrase)) return false;
  for (const clause of lower.split(/[.;!?\n,]/)) {
    if (!clause.includes(phrase)) continue;
    if (NEGATION_RE.test(clause)) continue;
    if (NON_ASSERTION_RE.test(clause)) continue;
    return true;
  }
  return false;
}

/**
 * The claim in `answer` that contradicts the candidate's real status, or null.
 *
 * @param {string} answer
 * @param {boolean|null|undefined} requiresSponsorship from the candidate profile.
 *   `undefined`/`null` means UNKNOWN, which keeps the historical behaviour: only
 *   "I need no sponsorship" claims are forbidden. Unknown is never treated as
 *   "does not require", because that would forbid a sponsorship-needing
 *   candidate's truthful answer whenever the profile failed to load.
 * @returns {string|null}
 */
export function contradictingSponsorshipClaim(answer, requiresSponsorship) {
  const text = String(answer ?? '').toLowerCase();
  if (requiresSponsorship === false) {
    return NEEDS_SPONSORSHIP_CLAIMS.find((f) => claimsAffirmatively(text, f)) ?? null;
  }
  return NO_SPONSORSHIP_CLAIMS.find((f) => text.includes(f)) ?? null;
}

function isForbidden(answer, requiresSponsorship) {
  return contradictingSponsorshipClaim(answer, requiresSponsorship) !== null;
}

/**
 * Unanswerable question -> defer to the configured default. `ask_user`
 * (shipped default) surfaces it as a blocker; `skip` leaves the field blank
 * without blocking (the live form's own required-field check still applies).
 * Never anything else — an unknown question is never answered with a guess.
 */
function askUser(defaults) {
  return {
    answered: false,
    action: defaults.unknownAction === 'skip' ? 'skip' : 'ask_user',
    matchedId: null,
    answer: null,
    type: null,
    confidence: 0,
  };
}

/**
 * The candidate's stated sponsorship requirement, from the current field or
 * the legacy top-level one — the SAME read the runner and field filler make.
 * The planner reading only the new field disagreed with them for legacy
 * profiles (safe, but inconsistent: truthful answers went to the human).
 * @returns {boolean|null|undefined}
 */
export function candidateRequiresSponsorship(candidate) {
  return candidate?.workAuthorization?.requiresSponsorship ?? candidate?.sponsorshipRequired;
}
