/**
 * Deterministic, explainable, configurable scoring engine.
 *
 * Produces a normalized 0-100 score from weighted categories defined entirely
 * in config/scoring.json. The same inputs always yield the same output.
 *
 * Categories (each capped at its configured weight):
 *   titleFit, seniorityFit, azureFabricStack, dataEngineeringStack,
 *   biSemanticDepth, pythonSqlPyspark, domainFit, sponsorshipFeasibility,
 *   geographyFit, freshness, directAtsAvailability,
 *   companySponsorshipLikelihood, resumeKeywordAlignment
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';
import { ageInDays } from '../utils/dates.js';
import { candidateNeedsSponsorship } from './exclusionFilter.js';
import { excludedLocationMatch, postedPay, usdPayPreference } from './searchConstraints.js';
import { seniorityRank } from '../profile/roleFamilies.js';
import { matchedTitlePhrases } from './titleMatch.js';
import { assessEligibility, eligibilityPenalty, requiredText } from './eligibility.js';
import { FRESHNESS_WINDOW_DAYS } from '../utils/credentialManager.js';

/**
 * Sources considered "direct ATS" for the directAtsAvailability category — a
 * posting we can apply to on the employer's own ATS, with no aggregator in the
 * way. This must track the discovery adapters in search/sources.js: when Ashby,
 * SmartRecruiters, Workday, and company careers pages were added as real
 * discovery sources, they kept scoring 0 here, quietly penalizing 43% of the
 * corpus against otherwise-identical Greenhouse/Lever roles.
 *
 * `manual` / `manual-url` are direct by definition: the human pasted the
 * employer's own application URL.
 *
 * The single list: jobRanking.js imports it for its tie-break, so the score
 * and the ordering can no longer disagree about what "direct" means.
 */
export const DIRECT_ATS_SOURCES = Object.freeze(new Set([
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'careers',
  'icims', 'rippling', 'oracleRecruiting', 'amazonJobs',
  'manual', 'manual-url',
]));

/**
 * Seniority ranking for seniorityFit — ONE ladder, shared with the profile
 * taxonomy (`SENIORITY_LEVELS` in src/profile/roleFamilies.js).
 *
 * There were two, and they disagreed. This table had associate and mid on the
 * same rung while the taxonomy separates them, so the two implementations
 * counted a different number of rungs and "one step up" meant different things
 * in each; `staff` sat at 5 here (level with principal) and at 5-of-8 there
 * (level with lead). Seniority credit therefore depended on which module
 * happened to be asking.
 *
 * Aliases map the words a candidate or a posting actually uses onto the
 * taxonomy's keys. Keeping them here rather than in the taxonomy is deliberate:
 * the taxonomy defines the LADDER, this defines how loosely we read a title.
 */
/**
 * Version of the scoring SEMANTICS (not its config), part of the scoring
 * fingerprint. Bump whenever how a posting is read changes, so stored scores
 * are recomputed instead of looking current. 2: seniority per profession,
 * preferred-only skills at partial credit (audit 2026-11-11).
 */
export const SCORER_VERSION = 3; // 3: people-manager vs IC track (audit 2026-11-13)

/** Credit for a skill the posting names only as preferred / nice to have. */
export const PREFERRED_SKILL_CREDIT = 0.3;

const SENIORITY_ALIASES = {
  junior: 'entry', jr: 'entry', graduate: 'entry', 'new grad': 'entry',
  sr: 'senior', intermediate: 'mid', 'mid level': 'mid',
  staff: 'lead', manager: 'lead', head: 'director',
  vp: 'executive', 'vice president': 'executive', chief: 'executive',
};

/** Rank for a seniority word, on the shared ladder. Null when unrecognized. */
function rankOf(word) {
  const key = normalizeText(word);
  if (!key) return null;
  return seniorityRank(SENIORITY_ALIASES[key] ?? key);
}

/**
 * Level words a JOB TITLE may declare, highest first so the strongest claim in
 * a title wins ("Senior Staff Engineer" is staff, not senior).
 *
 * The old detector recognized only principal/staff, lead/manager, senior,
 * junior/entry and mid-level — so intern, associate, director and executive
 * postings read as "seniority unstated" even though they say so plainly, while
 * the candidate side of the comparison had ranked all of them since the ladder
 * was generalized. A director role scored as though its level were unknown.
 */
const SENIORITY_PATTERNS = [
  [/\b(chief|c-level|cxo|ceo|cto|cio|coo)\b|\bvice\s+president\b|\bvp\b/, 'executive'],
  [/\b(director|head\s+of)\b/, 'director'],
  [/\bprincipal\b/, 'principal'],
  // "Staff" is a level above senior only in engineering-style ladders. A staff
  // accountant is the entry rung of accounting; reading it as lead scored an
  // entry-level post as a step UP for a senior. A staff nurse states no level
  // at all (it is the role at every level), so it matches nothing here.
  [/\bstaff\s+(?:accountant|auditor|tax|accounting)\b/, 'entry'],
  [/\bstaff\s+(?:software|data|machine|ml|ai|platform|backend|back-end|frontend|front-end|full[\s-]?stack|infrastructure|security|site|product|research|systems|cloud|devops|mobile|ios|android|engineer|developer|scientist|architect|designer|analytics|technical)\b/, 'lead'],
  // "Manager" in an individual-contributor title is not a management rung.
  [/\b(?:account|case|project|product|program|programme|property|community|social\s+media|office|territory|relationship|client\s+success|customer\s+success|care|campaign|content|category|release|delivery|scrum|event|events)\s+manager\b/, 'mid'],
  [/\b(lead|manager|charge\s+nurse|supervisor)\b/, 'lead'],
  [/\b(senior|sr\.?)\b/, 'senior'],
  [/\bmid[-\s]?level\b/, 'mid'],
  [/\bassociate\b/, 'associate'],
  // "Data entry" is a kind of work, not a level.
  [/\b(junior|jr\.?|(?<!data\s)entry[-\s]level|(?<!data\s)entry|new\s+grad(?:uate)?)\b/, 'entry'],
  [/\b(intern|internship|co[-\s]?op)\b/, 'intern'],
];

/**
 * A level numeral at the end of a title ("Accountant II", "Clinical Nurse
 * III", "Software Engineer IV"): I entry, II mid, III senior, IV lead, V
 * principal. Read only when no level WORD is present, after trailing asides
 * ("(Remote)", "- R012345") are removed.
 */
const LEVEL_NUMERALS = { i: 'entry', ii: 'mid', iii: 'senior', iv: 'lead', v: 'principal' };
function numeralLevel(title) {
  const core = String(title ?? '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s[-–—|]\s.*$/, ' ')
    .trim();
  const m = /\b(i{1,3}|iv|v)$/.exec(core);
  return m ? LEVEL_NUMERALS[m[1]] : null;
}

/**
 * Score a single job.
 *
 * @param {object} job normalized job
 * @param {object} args
 * @param {object} args.scoring parsed config/scoring.json
 * @param {{status: string}} args.sponsorship classifier result
 * @param {object} [args.candidate] parsed config/candidate.json (for alignment + geo + seniority)
 * @param {string[]} [args.resumeKeywords] keywords present in the master resume (optional)
 * @param {Date} [args.now]
 * @param {{discoveryDays: number, retentionDays: number}} [args.freshnessModel] grade
 *   freshness against the discovery window (see freshnessFactor); omitted, the
 *   legacy scoring.freshness curve applies
 * @param {object} [args.exclusions] parsed config/exclusions.json — lets the
 *   eligibility assessment report a hard clearance requirement
 * @returns {object} score result with breakdown, matched/missing keywords and
 *   `eligibility` ({verdict, reasons}, see src/scoring/eligibility.js)
 */
export function scoreJob(job = {}, {
  scoring, sponsorship, candidate = {}, resumeKeywords, now = new Date(), freshnessModel = null,
  exclusions = null,
} = {}) {
  const weights = scoring.weights;
  const kw = scoring.keywords;
  const text = normalizeText([job.title, job.jdText].join(' \n '));

  const breakdown = {};
  const matchedAll = new Set();

  // KEYWORD CATEGORIES ARE DECLARATIVE.
  //
  // These were six hardcoded JavaScript identifiers — azureFabricStack,
  // dataEngineeringStack, biSemanticDepth, pythonSqlPyspark, domainFit and a
  // titleFit that read a fixed keyword list. Together they own 64 of the 110
  // available points, so any candidate outside that one stack could not reach
  // them at all. Measured against perfectly-matching postings, with a floor of
  // 50: a registered nurse scored 21, a frontend engineer 26, an accountant 27
  // and a marketing manager 27, while the profile the vocabulary was written
  // for scored 78. Their theoretical ceiling was 53 — a flawless match barely
  // cleared the discard line. Discovery already worked for all of them; only
  // scoring did not.
  //
  // `scoring.categories` replaces them with an iterated array, so a second user
  // expresses their own field in config instead of editing this file. A
  // category draws its terms from one of three places:
  //
  //   from: 'targetTitles'    -> candidate.targetTitles    (follows the profile)
  //   from: 'technicalStack'  -> candidate.technicalStack  (follows the profile)
  //   from: 'industries'      -> candidate.domainExperience (follows the profile)
  //   keywords / keywordSet   -> an explicit list in scoring.json
  //
  // The first two matter as much as the array does: titleFit used to read
  // `scoring.keywords.titles`, so adding a target title changed what was
  // SEARCHED for but not what was SCORED, and the two silently disagreed.
  const categories = resolveCategories(scoring, candidate);
  // The required part of the posting (title + every clause not marked
  // preferred). A skill found only outside it earns PREFERRED_SKILL_CREDIT: a
  // NICU post listing the candidate's adult-ICU skills only under "Preferred"
  // scored 87 for an adult-ICU nurse, the same as a post requiring them.
  const required = normalizeText([job.title, requiredText(job.jdText)].join(' \n '));
  for (const category of categories) {
    // Title categories fold morphology and word order ("Engineer, Data",
    // "Data Engineering") — see src/scoring/titleMatch.js. Description
    // categories keep strict phrase matching.
    breakdown[category.id] = category.match === 'title'
      ? keywordCategory(job.title, category.terms, category.weight, category.fullAt, matchedAll, matchedTitlePhrases)
      : keywordCategory(text, category.terms, category.weight, category.fullAt, matchedAll, matchedPhrases, required);
  }

  // Seniority fit.
  breakdown.seniorityFit = scoreSeniority(job, text, candidate.seniority, weights.seniorityFit);

  // Sponsorship feasibility.
  //
  // Both categories measure "can this employer sponsor me?", which is only a
  // question for a candidate who needs sponsoring. For one who has stated they
  // do not, an employer's sponsorship posture is not a fact about their fit,
  // and scoring it cost them 15 of 100 points on every posting that had not
  // volunteered an answer — pushing genuinely strong roles below the tier
  // thresholds. Stated `false` scores these as fully satisfied; unstated keeps
  // the cautious behaviour.
  const needsSponsorship = candidateNeedsSponsorship(candidate);
  breakdown.sponsorshipFeasibility = needsSponsorship === false
    ? { points: weights.sponsorshipFeasibility, weight: weights.sponsorshipFeasibility, matched: ['no sponsorship needed'] }
    : scoreSponsorship(sponsorship?.status, weights.sponsorshipFeasibility);
  breakdown.companySponsorshipLikelihood = needsSponsorship === false
    ? { points: weights.companySponsorshipLikelihood, weight: weights.companySponsorshipLikelihood, matched: ['no sponsorship needed'] }
    : scoreCompanyLikelihood(sponsorship?.status, weights.companySponsorshipLikelihood);

  // Geography fit.
  breakdown.geographyFit = scoreGeography(job, candidate, weights.geographyFit);

  // Freshness.
  breakdown.freshness = scoreFreshness(job, scoring.freshness ?? {}, weights.freshness, now, freshnessModel);

  // Direct ATS availability.
  breakdown.directAtsAvailability = {
    points: DIRECT_ATS_SOURCES.has(job.source) ? weights.directAtsAvailability : 0,
    weight: weights.directAtsAvailability,
    matched: DIRECT_ATS_SOURCES.has(job.source) ? [job.source] : [],
  };

  // Resume keyword alignment.
  breakdown.resumeKeywordAlignment = scoreResumeAlignment(
    text, candidate, resumeKeywords, weights.resumeKeywordAlignment,
  );

  // Pay fit: a PENALTY ONLY, and only when both sides are stated. It carries no
  // weight in the denominator, so every posting that states no pay — most of
  // them — scores exactly as it did before this existed.
  const payFit = scorePay(job, candidate, weights.payFit);
  if (payFit) breakdown.payFit = payFit;

  // Track: people manager vs individual contributor. PENALTY ONLY and outside
  // the denominator, like pay. Level and track are different questions:
  // "Principal Data Engineering Manager" is a principal-level rung AND a job
  // managing people, and it scored 89 for a hands-on senior IC engineer.
  const trackFit = scoreTrack(job, candidate, weights.trackFit);
  if (trackFit) breakdown.trackFit = trackFit;

  // Eligibility: the posting's stated floor (years, degree, clearance) against
  // the candidate. Also PENALTY ONLY and outside the denominator — an unknown
  // candidate or an unstated floor changes nothing.
  const eligibility = assessEligibility(job, candidate ?? {}, { now, exclusions });
  const eligibilityFit = eligibilityPenalty(eligibility, weights.eligibility);
  if (eligibilityFit) breakdown.eligibility = eligibilityFit;

  const raw = Math.max(0, Object.values(breakdown).reduce((s, b) => s + b.points, 0));
  // The denominator is the STRUCTURAL weights plus whatever categories were
  // declared. It cannot be `Object.values(weights)`: on a legacy config the
  // categories derive their weights from that same object, so summing both
  // counted every keyword category twice and deflated every score (a strong
  // match fell from 78 to 52 against an unchanged 75 threshold).
  const max = STRUCTURAL_WEIGHTS.reduce((s, k) => s + (Number(weights[k]) || 0), 0)
    + categories.reduce((s, c) => s + c.weight, 0);
  const total = max > 0 ? Math.round((raw / max) * 100) : 0;

  const matchedKeywords = [...matchedAll];
  const missingKeywords = computeMissing(
    text, candidate, kw, scoring.evidenceAliases, categories, scoring.marketSkills,
  );

  return {
    total,
    raw: round2(raw),
    max,
    breakdown,
    matchedKeywords,
    missingKeywords,
    sponsorship: sponsorship?.status ?? 'Unconfirmed',
    eligibility: {
      verdict: eligibility.verdict, reasons: eligibility.reasons,
      blocking: eligibility.blocking === true, advancedUnknown: eligibility.advancedUnknown === true,
    },
  };
}

/** Fixed, non-keyword categories. Their weights stay in `scoring.weights`. */
export const STRUCTURAL_WEIGHTS = Object.freeze([
  'seniorityFit', 'sponsorshipFeasibility', 'companySponsorshipLikelihood',
  'geographyFit', 'freshness', 'directAtsAvailability', 'resumeKeywordAlignment',
]);

/**
 * Terms for the `coreSkills` category.
 *
 * Evidenced buckets only — a category labelled "Core skills" and worth 30 of
 * 100 points must reward what the candidate can actually do. See
 * `candidateStackTerms` for the measurement that made this necessary.
 */
function stackTerms(candidate) {
  return candidateStackTerms(candidate ?? {});
}

/**
 * Resolve a category's match terms.
 *
 * `from` binds a category to the PROFILE so editing the profile changes
 * scoring; `keywords` / `keywordSet` keep it an explicit vocabulary in
 * scoring.json. Both are supported because some categories are genuinely about
 * the candidate (their titles, their stack) and some are about the market
 * (domains, compliance words) which no profile field carries.
 */
function categoryTerms(category, scoring, candidate) {
  if (category.from === 'targetTitles') {
    return (candidate?.targetTitles ?? []).filter(Boolean);
  }
  if (category.from === 'technicalStack') {
    return stackTerms(candidate);
  }
  if (category.from === 'industries') {
    // The industries the profile actually names, rather than a fixed list of
    // six that happened to suit one person ("finance, healthcare, insurance,
    // retail, banking, bank"). A candidate in education or manufacturing could
    // not score this category at all.
    return (candidate?.domainExperience ?? []).filter(Boolean);
  }
  if (Array.isArray(category.keywords)) return category.keywords;
  // `keywordSet` may name one set or several, which is how the legacy
  // dataEngineeringStack folded four lists into one category.
  const sets = [].concat(category.keywordSet ?? []);
  return sets.flatMap((name) => scoring?.keywords?.[name] ?? []);
}

/**
 * The keyword categories to score, declarative if configured and otherwise
 * synthesized from the legacy shape.
 *
 * The fallback is not politeness: `scoring.json` files predating
 * `categories` must keep scoring IDENTICALLY, or every stored score in a
 * 100k-row database silently changes meaning on upgrade.
 *
 * @param {object} scoring parsed config/scoring.json
 * @param {object} candidate parsed config/candidate.json
 * @returns {Array<{id, label, weight, fullAt, match, terms}>}
 */
export function resolveCategories(scoring = {}, candidate = {}) {
  const sat = scoring.saturation ?? {};
  const fullAt = (key, fallback) => {
    const v = Number(sat[key]);
    return Number.isFinite(v) && v >= 1 ? v : fallback;
  };

  if (Array.isArray(scoring.categories) && scoring.categories.length) {
    return scoring.categories
      .filter((c) => c && c.id && Number(c.weight) > 0)
      .map((c) => ({
        id: String(c.id),
        label: c.label ?? c.id,
        weight: Number(c.weight),
        fullAt: Math.max(1, Number(c.fullAt) || 1),
        match: c.match === 'title' ? 'title' : 'text',
        terms: categoryTerms(c, scoring, candidate),
      }));
  }

  // ── legacy shape ──────────────────────────────────────────────────────
  const w = scoring.weights ?? {};
  const kw = scoring.keywords ?? {};
  return [
    { id: 'titleFit', label: 'Title fit', weight: w.titleFit ?? 0, fullAt: fullAt('titleFit', 1), match: 'title', terms: kw.titles ?? [] },
    { id: 'azureFabricStack', label: 'Azure / Fabric stack', weight: w.azureFabricStack ?? 0, fullAt: fullAt('azureFabricStack', 3), match: 'text', terms: kw.azureFabric ?? [] },
    {
      id: 'dataEngineeringStack',
      label: 'Data engineering stack',
      weight: w.dataEngineeringStack ?? 0,
      fullAt: fullAt('dataEngineeringStack', 3),
      match: 'text',
      terms: [...(kw.dataEngineering ?? []), ...(kw.devopsInfra ?? []), ...(kw.dataQuality ?? []), ...(kw.genAI ?? [])],
    },
    { id: 'biSemanticDepth', label: 'BI / semantic depth', weight: w.biSemanticDepth ?? 0, fullAt: fullAt('biSemanticDepth', 2), match: 'text', terms: kw.biSemantic ?? [] },
    { id: 'pythonSqlPyspark', label: 'Languages', weight: w.pythonSqlPyspark ?? 0, fullAt: fullAt('pythonSqlPyspark', 2), match: 'text', terms: kw.languages ?? [] },
    { id: 'domainFit', label: 'Domain fit', weight: w.domainFit ?? 0, fullAt: fullAt('domainFit', 1), match: 'text', terms: kw.domains ?? [] },
  ].filter((c) => c.weight > 0);
}

/**
 * Points = weight * min(1, credit/fullAt), where each matched term is worth 1,
 * or PREFERRED_SKILL_CREDIT when `requiredOnly` is given and the term appears
 * only outside it (preferred / nice-to-have material).
 */
function keywordCategory(text, keywords = [], weight = 0, fullAt = 1, sink, match = matchedPhrases, requiredOnly = null) {
  const matched = match(text, keywords);
  for (const m of matched) sink?.add(m);
  let credit = matched.length;
  let preferredOnly = [];
  if (requiredOnly !== null && matched.length) {
    const inRequired = new Set(match(requiredOnly, keywords).map((m) => normalizeText(m)));
    preferredOnly = matched.filter((m) => !inRequired.has(normalizeText(m)));
    credit = matched.length - preferredOnly.length + PREFERRED_SKILL_CREDIT * preferredOnly.length;
  }
  const coverage = Math.min(1, credit / Math.max(1, fullAt));
  return {
    points: round2(weight * coverage), weight, matched,
    ...(preferredOnly.length ? { preferredOnly } : {}),
  };
}

/**
 * Seniority AND scope fit.
 *
 * Two corrections live here, both of which used to push the profile's best
 * matches DOWN the ranking:
 *
 * 1. LEVEL IS READ FROM THE TITLE, not the whole document. `detectSeniority`
 *    ran over title+JD, where `/\b(lead|manager)\b/` matches the ordinary verb:
 *    a posting saying "you will LEAD the design of our lakehouse" was scored as
 *    a Lead-level role, one rung above a senior candidate, and docked to 0.6 of
 *    the weight. Rich leadership language in a description — exactly what a
 *    senior engineer wants to see — cost 3.2 of 8 points. The body is still
 *    consulted, but only when the title states no level at all.
 *
 * 2. THE PENALTY IS ASYMMETRIC. Being one rung ABOVE the candidate's stated
 *    level is the normal next step and is treated as a full fit; being BELOW is
 *    the real mismatch. Symmetric distance punished "Lead Data Engineer" for a
 *    senior candidate exactly as hard as "Junior Data Engineer", which is
 *    backwards for someone moving toward technical leadership.
 *
 * Scope evidence (owning a platform, setting technical direction, mentoring)
 * tops the category up, so responsibility counts even when the title is
 * unremarkable. It can only ADD, never subtract.
 */
function scoreSeniority(job, text, candidateSeniority, weight) {
  if (!candidateSeniority) return { points: 0, weight, matched: [] };
  // Unrecognized candidate levels fall back to 'senior', matching the previous
  // behaviour — but every key the profile model can produce now resolves.
  const want = rankOf(candidateSeniority) ?? seniorityRank('senior');
  const matched = [];

  // Title first — that is where a level is actually declared. Lowercased,
  // because `detectSeniority` matches lowercase patterns with no `i` flag and a
  // raw "Junior Data Engineer" would otherwise detect nothing, fall through to
  // the body, and pick up the VERB "lead" — scoring a junior role as a step up.
  let detected = detectSeniority(String(job?.title ?? '').toLowerCase());
  if (detected === null) {
    const numeral = numeralLevel(job?.title);
    if (numeral) detected = seniorityRank(numeral);
  }
  // The body is consulted ONLY for an explicit, structured level statement.
  // Running the title patterns over the whole JD read "reports to our CTO" as
  // executive, "partner with the VP" as executive, "the hiring manager" and
  // "you will lead" as lead — so an unleveled title took whatever rank its
  // boilerplate happened to mention. Anything else is "unstated" (0.6).
  if (detected === null) detected = detectStatedSeniority(text);

  let factor;
  if (detected === null) {
    factor = 0.6;
    matched.push('seniority unstated');
  } else if (detected >= want) {
    // At or above level. One rung up is a lateral/step-up move, not a misfit;
    // far above (a VP role for a senior IC) still tapers.
    const up = detected - want;
    factor = up <= 1 ? 1 : up === 2 ? 0.75 : 0.4;
    matched.push(up === 0 ? 'seniority match' : `seniority +${up} (step up)`);
  } else {
    const down = want - detected;
    factor = down === 1 ? 0.5 : 0.15;
    matched.push(`seniority -${down} (below level)`);
  }

  // Scope top-up: platform ownership and technical leadership are part of what
  // this profile is looking for and were previously worth nothing at all.
  const scope = scopeBonus(text);
  if (scope.bonus > 0) matched.push(...scope.matched);
  const points = Math.min(weight, weight * factor + weight * scope.bonus);
  return { points: round2(points), weight, matched };
}

/** Ownership/leadership evidence, worth up to 25% of the seniority weight. */
function scopeBonus(text) {
  const matched = [];
  let bonus = 0;
  if (/\b(own|owns|ownership of|accountable for|responsible for)\b[\w\s,]{0,40}\b(platform|architecture|pipeline|warehouse|lakehouse|roadmap|strategy|data estate)\b/.test(text)) {
    matched.push('platform ownership'); bonus += 0.15;
  }
  if (/\b(mentor|mentoring|coach|technical direction|lead a team|lead the team|guide engineers|set standards|define best practices)\b/.test(text)) {
    matched.push('technical leadership'); bonus += 0.10;
  }
  return { bonus: Math.min(0.25, bonus), matched };
}

/**
 * The level a job title (or description) declares, as a rank on the shared
 * ladder. Null when it declares none. See SENIORITY_PATTERNS.
 */
function detectSeniority(text) {
  for (const [pattern, key] of SENIORITY_PATTERNS) {
    if (pattern.test(text)) return seniorityRank(key);
  }
  return null;
}

/**
 * Structured level statements a DESCRIPTION may make: "this is a senior-level
 * role", "Level: Senior", "Seniority: Mid-Senior", "Career level: Entry".
 * Prose ("lead the design", "reports to the CTO") never counts.
 */
const STATED_SENIORITY_PATTERNS = [
  /\bthis\s+is\s+an?\s+([a-z]+(?:[\s-][a-z]+)?)[\s-]level\s+(?:role|position|opportunity|job)\b/,
  /\b(?:job|career|experience|position|role)?\s*(?:level|seniority)\s*[:\-–]\s*([a-z]+(?:[\s-][a-z]+)?)/,
];

/**
 * The level a description STATES, or null. See STATED_SENIORITY_PATTERNS.
 * @param {string} text normalized title + description
 * @returns {number|null}
 */
function detectStatedSeniority(text) {
  for (const re of STATED_SENIORITY_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const rank = detectSeniority(m[1]);
    if (rank !== null) return rank;
  }
  return null;
}

/**
 * Sponsorship feasibility points. `Denied` scores ZERO — below Unconfirmed,
 * which still earns partial credit for being merely unknown. An explicit refusal
 * is worse than silence, so it must never out-score it.
 */
function scoreSponsorship(status, weight) {
  const factor = { Confirmed: 1, Approved: 1, Likely: 0.7, Unconfirmed: 0.35, Denied: 0 }[status] ?? 0;
  return { points: round2(weight * factor), weight, matched: [status ?? 'Unconfirmed'] };
}

function scoreCompanyLikelihood(status, weight) {
  const factor = { Confirmed: 1, Approved: 1, Likely: 1, Unconfirmed: 0.2, Denied: 0 }[status] ?? 0;
  return { points: round2(weight * factor), weight, matched: [status ?? 'Unconfirmed'] };
}

function scoreGeography(job, candidate, weight) {
  const prefs = candidate.locationPreferences ?? {};
  const loc = normalizeText(job.location);
  const matched = [];
  let factor = 0.5; // unknown location: neutral

  // THE EXCLUSION IS CHECKED FIRST, NOT INSIDE THE NON-REMOTE BRANCH.
  //
  // It used to sit after `if (/remote/.test(loc))`, so any location string
  // containing the substring "remote" skipped it entirely — "Remote - Dallas,
  // TX" scored a full six points for a candidate who had ruled out Dallas.
  // `excludedLocationMatch` decides remoteness by reading the location as
  // remote rather than by a substring, and a genuinely remote posting is still
  // exempt, because ruling out a city is a statement about going there.
  const excluded = excludedLocationMatch(job.location, prefs.excludedLocations);
  if (excluded) return { points: 0, weight, matched: [`excluded location: ${excluded}`] };

  if (/remote/.test(loc)) {
    if (prefs.remote) { factor = 1; matched.push('remote'); }
  } else if (loc) {
    if (prefs.onsite || prefs.hybrid) { factor = 0.8; matched.push('onsite/hybrid ok'); }
    else { factor = 0.4; matched.push('onsite, candidate prefers remote'); }
  }
  return { points: round2(weight * factor), weight, matched };
}

/** Raw points a posting that pays well under target can lose, by default. */
const DEFAULT_PAY_PENALTY = 6;

/** Points taken from a people-manager posting for an IC-only search (and a smaller amount the other way). */
export const DEFAULT_TRACK_PENALTY = 20;
const REVERSE_TRACK_SHARE = 0.6;

/** "Manager" titles that are individual-contributor roles in their own right. */
const IC_MANAGER = /\b(?:account|case|project|product|program|programme|property|community|social\s+media|office|territory|relationship|client\s+success|customer\s+success|care|campaign|content|category|release|delivery|scrum|event|events|marketing|brand|partner|vendor|data\s+product|technical\s+product|technical\s+program)\s+manager\b/;
const PEOPLE_MANAGER = /\b(?:manager|director|head\s+of|vice\s+president|vp|chief|supervisor)\b|\bmanager,/;

/**
 * Is this title a job managing people? Product, project, account and similar
 * "manager" titles are IC roles; "lead" is a player-coach and counts as IC.
 * @param {string} title
 * @returns {boolean}
 */
export function isPeopleManagerTitle(title) {
  const t = String(title ?? '').toLowerCase();
  if (!PEOPLE_MANAGER.test(t)) return false;
  // Remove IC "manager" phrases; a people-manager word may still remain
  // ("Director, Product Management" keeps "director").
  const rest = t.replace(new RegExp(IC_MANAGER.source, 'g'), ' ');
  return PEOPLE_MANAGER.test(rest.replace(/\bproduct\s+management\b/g, 'product'))
    || /\b(?:director|head\s+of|vice\s+president|vp|chief)\b/.test(rest);
}

/**
 * Which tracks the candidate's target titles ask for. Null when there are no
 * target titles (nothing to compare, so no penalty).
 * @returns {{ic: boolean, manager: boolean}|null}
 */
export function candidateTracks(candidate) {
  const titles = (candidate?.targetTitles ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!titles.length) return null;
  const manager = titles.filter(isPeopleManagerTitle).length;
  return { ic: manager < titles.length, manager: manager > 0 };
}

function scoreTrack(job, candidate, weight) {
  const wants = candidateTracks(candidate);
  if (!wants) return null;
  const max = Number.isFinite(Number(weight)) && Number(weight) >= 0 ? Number(weight) : DEFAULT_TRACK_PENALTY;
  const managesPeople = isPeopleManagerTitle(job?.title);
  if (managesPeople && !wants.manager) {
    return { points: -round2(max), weight: 0, matched: ['people-manager role; your search targets individual-contributor roles'] };
  }
  if (!managesPeople && !wants.ic) {
    return { points: -round2(max * REVERSE_TRACK_SHARE), weight: 0, matched: ['individual-contributor role; your search targets people-manager roles'] };
  }
  return null;
}

/**
 * Pay versus the candidate's stated preference.
 *
 * Reads the posting's compensation field, or a strict pay-transparency
 * sentence in its description (`postedPay`). Compared against
 * `salaryPreference.targetAnnualUSD`, falling back to `minAnnualUSD`. A top of
 * range at or above the target costs nothing; below it the penalty grows
 * linearly and is complete at 25% under. (A top of range below the FLOOR is a
 * hard exclusion in searchConstraints.js, not a penalty.)
 *
 * @returns {{points: number, weight: 0, matched: string[]}|null} null when either side is unstated
 */
function scorePay(job, candidate, weight) {
  // Only a USD preference is comparable with posted "$" pay; see usdPayPreference.
  const pref = usdPayPreference(candidate);
  const target = pref.target || pref.floor;
  if (!(target > 0)) return null;
  const pay = postedPay(job);
  if (!pay) return null;
  const max = Number.isFinite(Number(weight)) && Number(weight) >= 0 ? Number(weight) : DEFAULT_PAY_PENALTY;
  const label = `posted pay up to ${Math.round(pay.max).toLocaleString('en-US')} (${pay.source})`;
  if (pay.max >= target) return { points: 0, weight: 0, matched: [`${label} meets target`] };
  const shortfall = Math.min(1, (target - pay.max) / (0.25 * target));
  return { points: -round2(max * shortfall), weight: 0, matched: [`${label} below target ${target.toLocaleString('en-US')}`] };
}

/**
 * The freshness model every scoring path must use (F8): the discovery window
 * from `runtime.jobFreshnessMode` and the retention limit from
 * `exclusions.staleness.skipOlderThanDays`.
 *
 * ONE source, so the same posting scores the same however it arrived. The
 * pipeline built this inline, while `rescore` and add-by-URL passed nothing
 * and fell back to the legacy `scoring.freshness` 7/14-day curve — a manually
 * added 15-day-old job lost every freshness point that the identical
 * discovered job kept.
 *
 * @param {object} config loadConfig() bundle
 * @returns {{discoveryDays: number, retentionDays: number}}
 */
export function freshnessModelFor(config = {}) {
  const retentionDays = Number(config?.exclusions?.staleness?.skipOlderThanDays) || 45;
  const discoveryDays = FRESHNESS_WINDOW_DAYS[config?.runtime?.jobFreshnessMode ?? 'LAST_7_DAYS'] ?? 7;
  return { discoveryDays: Number.isFinite(discoveryDays) ? discoveryDays : retentionDays, retentionDays };
}

/**
 * Freshness factor relative to the DISCOVERY window (F8).
 *
 * The legacy curve (full points up to scoring.freshness.flagOlderThanDays = 7,
 * half to 14) was dead weight once discovery itself only admits postings
 * inside a 7-day window: every new row scored full marks. Graded against the
 * window instead, points fall from 1.0 at day 0 to 0.5 at the window's edge,
 * and a row RETAINED past the window (already on the board) keeps falling to
 * 0 at the retention limit (exclusions.staleness.skipOlderThanDays), where the
 * exclusion stage retires it anyway.
 *
 * @param {number} age days
 * @param {{discoveryDays: number, retentionDays: number}} model
 * @returns {number} 0..1
 */
export function freshnessFactor(age, { discoveryDays, retentionDays }) {
  const d = Number.isFinite(discoveryDays) && discoveryDays > 0 ? discoveryDays : 7;
  const r = Number.isFinite(retentionDays) && retentionDays > d ? retentionDays : d * 2;
  if (age <= 0) return 1;
  if (age <= d) return 1 - 0.5 * (age / d);
  if (age >= r) return 0;
  return 0.5 * (1 - (age - d) / (r - d));
}

function scoreFreshness(job, freshness, weight, now, model = null) {
  const age = ageInDays(job.postedAt, now);
  if (age === null) return { points: round2(weight * 0.5), weight, matched: ['posted date unknown'] };
  if (model && Number.isFinite(model.discoveryDays)) {
    return { points: round2(weight * freshnessFactor(age, model)), weight, matched: [`${age} days old`] };
  }
  const flagDays = freshness.flagOlderThanDays ?? 7;
  const skipDays = freshness.skipOlderThanDays ?? 14;
  let factor;
  if (age <= flagDays) factor = 1;
  else if (age <= skipDays) factor = 0.5;
  else factor = 0;
  return { points: round2(weight * factor), weight, matched: [`${age} days old`] };
}

function scoreResumeAlignment(text, candidate, resumeKeywords, weight) {
  const profileTerms = resumeKeywords && resumeKeywords.length
    ? resumeKeywords
    : candidateStackTerms(candidate);
  if (profileTerms.length === 0) return { points: 0, weight, matched: [] };
  const matched = matchedPhrases(text, profileTerms);
  const coverage = Math.min(1, matched.length / Math.max(1, Math.min(8, profileTerms.length)));
  return { points: round2(weight * coverage), weight, matched };
}

/**
 * The stack bucket holding skills the candidate wants to LEARN, not ones they
 * have. Written by `toCandidateConfig` from `searchIntent.skillsToGrow`.
 */
const GROWTH_BUCKET = 'growth';

/**
 * Flatten the candidate technical stack into a term list.
 *
 * EVIDENCE BY DEFAULT. `technicalStack.growth` is the one bucket that is not a
 * statement of ability — it is what the person is moving toward — and
 * flattening it in alongside the rest made every consumer treat an aspiration
 * as a demonstrated skill. Measured on a profile whose only skills were six
 * growth entries: 30/30 core-skill points, no reported gaps, and the terms
 * printed in a cover letter under "My core strengths align with your
 * requirements". The background/intent split the profile model exists to
 * maintain was being discarded at exactly the point it mattered.
 *
 * Callers that genuinely want the union — discovery, which should still FIND a
 * job that uses a skill you are learning — pass `includeGrowth: true`.
 *
 * @param {object} [candidate]
 * @param {object} [options]
 * @param {boolean} [options.includeGrowth=false]
 * @returns {string[]}
 */
/** Paperwork words around a credential ("license", "certified"), dropped when checking evidence. */
const CREDENTIAL_WORDS = /\b(license|licence|licensure|licensed|certification|certificate|certified|credential|registration|active|current|valid)\b/g;

export function candidateStackTerms(candidate = {}, { includeGrowth = false } = {}) {
  const stack = candidate.technicalStack ?? {};
  return Object.entries(stack)
    .filter(([bucket]) => includeGrowth || bucket !== GROWTH_BUCKET)
    .flatMap(([, terms]) => (Array.isArray(terms) ? terms : [terms]))
    .filter((t) => typeof t === 'string' && t.trim());
}

/**
 * Important JD keywords NOT evidenced by the candidate profile (tailoring gaps).
 *
 * A term counts as evidenced when the profile contains the term itself OR any
 * of its configured aliases (scoring.evidenceAliases) — so "ADF" in a JD is
 * never reported as a gap when the profile lists "Azure Data Factory", and
 * "lakehouse" is evidenced by "Delta Lake"/"Databricks" experience. Without
 * this, the same skill could appear in BOTH matchedKeywords (found in the JD)
 * and missingKeywords (alias not substring-matched in the profile), which
 * reads as a contradiction on the dashboard.
 */
export function computeMissing(text, candidate, kw, evidenceAliases = {}, categories = null, marketSkills = null) {
  // A GAP NEEDS A VOCABULARY THE CANDIDATE DOES NOT OWN.
  //
  // "Missing" means: this JD asks for something you cannot evidence. Finding
  // those requires a candidate-INDEPENDENT list of skill terms to look for. The
  // candidate's own stack cannot supply it — every term found that way is by
  // definition one they already have, so the answer is always "no gaps". (That
  // circularity was briefly introduced here while making scoring profile-driven,
  // and is the reason this comment exists.)
  //
  // So the vocabulary is the market one: every list under `scoring.keywords`,
  // plus any category that declares an explicit vocabulary rather than binding
  // to the profile. A category bound to `targetTitles` or `technicalStack` is
  // deliberately excluded.
  //
  // THAT CONSEQUENCE IS NOW FIXED. Gap analysis used to be only as good as
  // `scoring.keywords`, which shipped as a data-engineering word list — so a
  // nurse or an accountant was told they had no gaps, not because they had
  // none but because nothing was looking for theirs. `scoring.marketSkills` is
  // written by activating a search profile and holds every skill the
  // candidate's own role families know about (config/role_families.json), so
  // the question "what is this JD asking for that I cannot evidence?" is now
  // answerable in any field. It is still candidate-INDEPENDENT — a vocabulary
  // of the market, not of the person — which is what makes a gap a gap.
  // `titles` and `domains` are excluded on principle: a job title is not a skill
  // you can be missing, and neither is an industry. Including them reported
  // "data engineer" as a gap on a data-engineering role.
  const NOT_SKILLS = new Set(['titles', 'domains']);
  const fromProfile = Array.isArray(marketSkills) ? marketSkills : [];
  const marketVocabulary = [
    ...fromProfile,
    ...Object.entries(kw ?? {})
      .filter(([name]) => !NOT_SKILLS.has(name))
      .flatMap(([, list]) => list ?? []),
  ];
  const declaredVocabulary = (categories ?? [])
    .filter((c) => c.match !== 'title' && !c.from)
    .flatMap((c) => c.terms ?? []);
  const important = [...marketVocabulary, ...declaredVocabulary]
    .filter((t) => typeof t === 'string' && t.trim());
  const inJd = new Set(matchedPhrases(text, important).map((p) => normalizeText(p)));
  const profileText = normalizeText([
    ...candidateStackTerms(candidate),
    ...(candidate.certifications ?? []),
    ...(candidate.domainExperience ?? []),
    // A degree is evidence too: "BSN preferred" against a nurse who holds a
    // BSN was reported as a gap, because only skills and certifications were
    // consulted.
    ...(Array.isArray(candidate.education) ? candidate.education.flatMap((e) => [e?.degree, e?.field]) : []),
  ].filter((t) => typeof t === 'string').join(' '));
  const words = ` ${profileText} `;
  const aliases = new Map(
    Object.entries(evidenceAliases ?? {}).map(([term, list]) => [
      normalizeText(term),
      (Array.isArray(list) ? list : []).map((a) => normalizeText(a)),
    ]),
  );
  const evidenced = (term) => {
    if (profileText.includes(term) || (aliases.get(term) ?? []).some((a) => a && profileText.includes(a))) return true;
    // "RN license", "CPA certification", "active teaching license": the
    // credential is the evidence, not the paperwork word around it. Matched
    // on whole words, because a two-letter core like "rn" is inside "learning".
    const core = term.replace(CREDENTIAL_WORDS, ' ').replace(/\s+/g, ' ').trim();
    return Boolean(core) && core !== term && words.includes(` ${core} `);
  };
  const missing = [];
  for (const term of inJd) {
    if (!evidenced(term)) missing.push(term);
  }
  return missing;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
