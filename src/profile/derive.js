/**
 * Derive the runtime config from the active search profile.
 *
 * THE SEAM. Every consumer in this repo reads `config/candidate.json`,
 * `config/scoring.json` and `config/exclusions.json`. Rewriting all of them to
 * read a profile would have been a rewrite; making those three files a
 * GENERATED VIEW of the profile is a seam. Activating a profile regenerates
 * them, and nothing downstream needs to know a profile exists.
 *
 * WHAT WAS CANDIDATE-SPECIFIC AND IS NOW DERIVED
 * ----------------------------------------------
 *  - scoring categories. The shipped `scoring.json` spent 46 of its 110 points
 *    on `azureFabricStack`, `biSemanticDepth` and `pythonSqlPyspark`, plus a
 *    `titleFit` reading a fixed list of 15 data-engineering titles. Measured on
 *    perfectly-matching postings against a discard floor of 50: a marketing
 *    manager scored 30 on a marketing job and 62 on a DATA ENGINEERING job. The
 *    tool actively preferred the previous candidate's field to the current
 *    user's own.
 *
 *  - the gap vocabulary. `computeMissing` looked for missing skills in
 *    `scoring.keywords`, a data-engineering word list, so a nurse or an
 *    accountant was told they had no gaps — not because they had none, but
 *    because nothing was looking for theirs.
 *
 *  - seniority exclusions. `exclusions.roleMismatch` hardcoded "junior",
 *    "entry level", "intern" and "co-op". Those are correct for a senior
 *    candidate and catastrophic for a new graduate, who would have every
 *    relevant posting hard-discarded before scoring.
 *
 *  - the US-only geography gate, hardcoded `true`.
 *
 * Everything here is a pure function of the profile plus the user's own
 * hand-written rules, which are always preserved: derivation ADDS a derived
 * list beside them rather than editing them, so switching profiles can never
 * silently delete something a person typed.
 */

import { toCandidateConfig, normalizeProfile } from './model.js';
import { isPlaceholderValue } from '../config/placeholders.js';
import {
  loadRoleFamilies, profileFamilies, expandRoleTitles, buildSearchPhrases,
  SENIORITY_LEVELS, seniorityRank, presentRole,
} from './roleFamilies.js';

/**
 * Weights for the profile-driven scoring categories.
 *
 * They sum with the structural weights (seniority 8, sponsorship 10, employer
 * sponsorship 5, geography 6, freshness 4, direct ATS 3, resume alignment 10 =
 * 46) to 100, so a score reads as a percentage without rescaling.
 *
 * `fullAt: 6` on coreSkills is deliberate: with the profile supplying the
 * vocabulary there is no reason to saturate after three hits, and rewarding
 * depth is what separates a real match from a posting that name-drops one tool.
 */
export const PROFILE_CATEGORY_SPEC = Object.freeze([
  {
    id: 'titleFit',
    label: 'Title fit',
    weight: 18,
    fullAt: 1,
    match: 'title',
    from: 'targetTitles',
    note: 'Reads candidate.targetTitles, which the active profile generates from its target roles plus role-family title variations. Editing your profile changes what is SCORED as well as what is searched — those used to be two lists that silently disagreed.',
  },
  {
    id: 'coreSkills',
    label: 'Core skills',
    weight: 30,
    fullAt: 6,
    from: 'technicalStack',
    note: 'Reads every value in candidate.technicalStack — the skills you want to keep using, what your resume evidences, and what you want to grow into. They do not have to be software.',
  },
  {
    id: 'domainFit',
    label: 'Industry / domain',
    weight: 6,
    fullAt: 1,
    from: 'industries',
    note: 'Reads candidate.domainExperience: the industries from your background plus any your search intent names.',
  },
]);

/**
 * Seniority levels excluded because they are too far BELOW what the profile
 * wants. Three rungs down is the boundary that keeps the shipped behaviour for
 * a senior candidate (intern and junior excluded, associate kept) while giving
 * an entry-level candidate an EMPTY list — which is the whole point.
 */
const SENIORITY_EXCLUSION_GAP = 3;

/**
 * Exclusion phrases for a level, beyond its own labels. These name the same
 * rung in the words postings actually use.
 */
const LEVEL_PHRASES = {
  intern: ['intern', 'internship', 'intern position', 'co-op', 'co op'],
  entry: ['junior', 'entry level', 'entry-level', 'new grad', 'new graduate', 'recent graduate'],
  associate: ['associate level'],
};

/**
 * Titles to exclude because they sit too far below the desired level.
 *
 * @param {string} seniority desired seniority key
 * @returns {string[]}
 */
export function deriveSeniorityExclusions(seniority) {
  const rank = seniorityRank(seniority);
  if (rank === null) return [];
  const out = [];
  for (const level of SENIORITY_LEVELS) {
    if (level.rank > rank - SENIORITY_EXCLUSION_GAP) continue;
    for (const phrase of LEVEL_PHRASES[level.key] ?? level.labels.map((l) => l.toLowerCase())) {
      if (phrase) out.push(phrase);
    }
  }
  return [...new Set(out)];
}

/**
 * Everything the active profile implies, computed once.
 *
 * @param {object} rawProfile
 * @param {object} [options]
 * @param {object} [options.taxonomy]
 * @param {string} [options.root]
 * @param {number} [options.maxVariations] role-family title variations to add
 * @returns {{profile, families, expanded, searchPhrases, candidate, categories, marketSkills}}
 */
export function deriveFromProfile(rawProfile, { taxonomy, root, maxVariations = 25 } = {}) {
  const profile = normalizeProfile(rawProfile);
  const tax = taxonomy ?? loadRoleFamilies(root);
  const families = profileFamilies(profile, tax);

  const expanded = expandRoleTitles({
    targetRoles: profile.searchIntent.targetRoles,
    families,
    taxonomy: tax,
    seniority: profile.searchIntent.seniority,
    maxVariations,
    // The profile itself decides which family siblings are really variations of
    // THIS person's role, rather than everything the family contains.
    profile,
  });

  // SEARCH PHRASES COME FROM THE ANCHORS ONLY.
  //
  // What is sent to a board must be what the candidate asked for. Deriving
  // phrases from the full expansion would let an adjacent title — a way some
  // employer might name the work — become a question this agent asks the whole
  // market, which is how a personalized search turns into a generic one.
  const searchPhrases = buildSearchPhrases({
    targetRoles: profile.searchIntent.targetRoles,
    families,
    taxonomy: tax,
    maxTerms: 4,
  });

  // The expansion is what turns "search the titles on my resume" into "search
  // the ways employers actually name this job". Presented in title case, since
  // these become literal query strings and appear in the dashboard.
  const expandedRoles = [...expanded.bySource.familySiblings, ...expanded.bySource.seniorityVariants]
    .map((r) => presentRole(r));
  const anchorRoles = expanded.anchors.map((r) => presentRole(r));
  const adjacentRoles = expanded.adjacent.map((r) => presentRole(r));

  // TWO LISTS, TWO JOBS. `targetTitles` is what discovery RECOGNIZES and what
  // scoring rewards, so expanding it is free and strictly improves recall.
  // `searchPhrases` is what discovery SENDS to a board, and every entry costs a
  // real request against a real server on every run — so it stays a small set
  // cover. Conflating them would have turned a 3-title profile into 15 queries
  // per source per run.
  const candidate = {
    ...toCandidateConfig(profile, { expandedRoles, anchorRoles, adjacentRoles }),
    searchPhrases,
    _generatedFrom: `config/profiles/${profile.id}.json`,
  };

  // Gap vocabulary: every skill the candidate's own families know about. A JD
  // asking for one the profile cannot evidence is a real, reportable gap — in
  // any field, which `scoring.keywords` could never be.
  const marketSkills = [...new Set(
    families.flatMap((f) => tax.families?.[f.id]?.skills ?? []),
  )];

  return {
    profile,
    families,
    expanded,
    searchPhrases,
    candidate,
    categories: PROFILE_CATEGORY_SPEC.map((c) => ({ ...c })),
    marketSkills,
    screeningAnswers: deriveScreeningAnswers(profile),
  };
}

/**
 * Merge derived scoring into the user's scoring.json, preserving everything
 * they tuned (tiers, weights, sponsorship lists, freshness, aliases).
 *
 * @param {object} baseScoring current config/scoring.json
 * @param {object} derived from `deriveFromProfile`
 * @returns {object}
 */
export function applyScoring(baseScoring = {}, derived) {
  // WHAT THE USER TUNED SURVIVES ACTIVATION.
  //
  // This replaced the whole `categories` array with the generated three, while
  // the file's own note promised that user tuning was preserved — so a custom
  // category, or an edited weight on a generated one, vanished the next time
  // any profile was activated, silently and without a diff the user would see.
  //
  // The generated categories carry `derived: true`, which makes the two
  // separable: anything WITHOUT that marker is the user's and is kept exactly
  // as written, and a derived category the user has edited keeps their weight
  // and saturation while following the profile for its terms. Deriving adds
  // beside what a person typed rather than over it — the same rule
  // `applyExclusions` already follows for roleMismatch.
  const base = Array.isArray(baseScoring.categories) ? baseScoring.categories : [];
  const derivedById = new Map(derived.categories.map((c) => [c.id, { ...c, derived: true }]));

  const merged = [];
  for (const category of base) {
    const generated = derivedById.get(category?.id);
    if (!generated) {
      merged.push(category); // the user's own category — untouched
      continue;
    }
    derivedById.delete(category.id);
    if (category.derived !== true) {
      // A generated id the user has taken ownership of. Their tuning wins; the
      // profile still supplies the terms through `from`.
      merged.push({ ...generated, ...category });
      continue;
    }
    // Previously generated and unedited: regenerate, but honour a weight or
    // saturation the user changed in place.
    merged.push({
      ...generated,
      ...(Number.isFinite(category.weight) && category.weight !== generated.weight
        ? { weight: category.weight } : {}),
      ...(Number.isFinite(category.fullAt) && category.fullAt !== generated.fullAt
        ? { fullAt: category.fullAt } : {}),
    });
  }
  // Generated categories this config has never seen.
  for (const generated of derivedById.values()) merged.push(generated);

  return {
    ...baseScoring,
    categories: merged,
    marketSkills: derived.marketSkills,
    _categoriesNote: 'Categories marked "derived": true are regenerated from the active profile on every '
      + 'activation — titleFit follows candidate.targetTitles and coreSkills follows '
      + 'candidate.technicalStack. Categories you add yourself, and weights you change on a derived one, '
      + 'are preserved across activations. Delete the "categories" array to fall back to the legacy '
      + 'hardcoded data-engineering categories (weights/keywords shape).',
  };
}

/**
 * Merge derived exclusions into the user's exclusions.json.
 *
 * The user's own `roleMismatch` is left EXACTLY as they wrote it. Derived
 * seniority phrases go in `roleMismatchDerived`, which `applyExclusions` reads
 * alongside it. That separation is what makes profile switching safe: a senior
 * profile's "junior" exclusion disappears when a graduate's profile is
 * activated, and nothing the user typed is touched either way.
 *
 * @param {object} baseExclusions
 * @param {object} derived
 * @returns {object}
 */
export function applyExclusions(baseExclusions = {}, derived) {
  const intent = derived.profile.searchIntent;
  return {
    ...baseExclusions,
    roleMismatchDerived: deriveSeniorityExclusions(intent.seniority),
    geography: {
      ...(baseExclusions.geography ?? {}),
      usOnly: intent.usOnly === true,
    },
    // NO PROFILE ID HERE. `config/exclusions.json` is TRACKED, while a profile
    // id is slugified from the person's own name and config/profiles/ is
    // gitignored precisely because it is personal. Stamping the id onto a
    // tracked file put "config/profiles/jane-doe.json" into git history — the
    // one place the profile model is supposed to keep it out of. The marker
    // only has to say the section is generated, not by whom.
    _generatedFrom: 'the active search profile (config/profiles/)',
  };
}

/* ───────────────────── screening answers from the profile ───────────────── */

/**
 * Screening questions whose answer is a FACT THE PROFILE ALREADY HOLDS.
 *
 * WHY THESE ARE DERIVED. `config/screening_answers.json` is one file shared by
 * whoever is using the tool, and six of its seven shipped entries are personal
 * facts: work authorization, sponsorship need, pay expectation, start date,
 * relocation and years of experience. Activating a different profile changed
 * the SEARCH and left those answers untouched, so the form filler would have
 * typed the previous person's facts onto the new person's application —
 * measured, the shipped file answers "Yes, I will require sponsorship (H-1B
 * transfer)" and "Authorized to work in the United States on an H-1B visa".
 *
 * Deriving them removes the possibility rather than guarding against it: the
 * answer is generated from the profile every time it is activated, so it cannot
 * disagree with the profile it came from. Anything a profile does not state is
 * NOT emitted — a missing fact stays a question for the human.
 *
 * `patterns` are the canonical ones from config/screening_answers.example.json,
 * so a derived entry matches exactly the questions the hand-written one did.
 */
/**
 * Is this value a real statement, rather than absent or still template text?
 *
 * Derived answers are typed verbatim onto employers' forms, so "present" is not
 * good enough. The shipped template fills several of these fields with
 * INSTRUCTIONS ("Describe your authorization truthfully…", "US Citizen | Green
 * Card | H-1B | OPT | …"), and a profile migrated from an unedited config
 * carries them. Treating those as facts produced a screening answer that was
 * an instruction to the user, addressed to a recruiter.
 */
function stated(value) {
  const text = String(value ?? '').trim();
  return text.length > 0 && !isPlaceholderValue(text);
}

const DERIVED_ANSWER_SPECS = [
  {
    id: 'work_authorization',
    patterns: ['work authorization', 'authorized to work', 'legally authorized', 'right to work'],
    answer: (p) => {
      const auth = p.searchIntent.workAuthorization;
      if (!stated(auth.status)) return null;
      // `details` is the candidate's own wording and is preferred — but only
      // when it IS wording. In the shipped template it reads "Describe your
      // authorization truthfully — this is used verbatim in screening
      // answers", and deriving from it would have typed that instruction onto
      // an employer's form.
      if (stated(auth.details)) return auth.details;
      // The sponsorship CLAUSE is only added when the profile stated the
      // requirement. Without it the sentence still states the candidate's own
      // status — which is what was asked — and claims nothing about
      // sponsorship in either direction.
      if (typeof auth.requiresSponsorship !== 'boolean') return auth.status;
      return auth.requiresSponsorship
        ? `${auth.status} — authorized to work in the United States, and will need continued visa sponsorship.`
        : `${auth.status} — authorized to work in the United States without visa sponsorship.`;
    },
  },
  {
    id: 'require_sponsorship',
    patterns: [
      'require sponsorship', 'need sponsorship', 'visa sponsorship',
      'now or in the future require sponsorship', 'sponsor you for a visa',
      'need an employer to sponsor', 'employer to sponsor you',
      'require an employer to sponsor', 'sponsorship to work',
      'sponsor you for an immigration', 'need visa sponsorship',
    ],
    answer: (p) => {
      const auth = p.searchIntent.workAuthorization;
      // BOTH facts have to be stated, because this answer is a sentence about
      // someone's immigration status typed onto an employer's form.
      //
      // The status guard alone was not enough. `requiresSponsorship` is a
      // boolean, and a profile that supplied a status but omitted the boolean
      // read as `false` — so "US Citizen" with nothing said about sponsorship
      // produced "No, I do not require visa sponsorship." That happens to be
      // right for a citizen and wrong for the H-1B holder whose profile is
      // equally silent, and nothing here can tell those two apart. The model
      // now keeps the boolean tri-state (null = not stated) and an unstated
      // requirement emits NOTHING, leaving the question for the human.
      if (!stated(auth.status)) return null;
      if (typeof auth.requiresSponsorship !== 'boolean') return null;
      return auth.requiresSponsorship
        ? 'Yes, I will require visa sponsorship.'
        : 'No, I do not require visa sponsorship.';
    },
  },
  {
    id: 'salary_expectation',
    patterns: [
      'salary expectation', 'salary expectations', 'desired salary',
      'compensation expectation', 'compensation expectations', 'expected compensation',
      'desired compensation', 'expected pay', 'expected salary', 'salary requirement',
      'salary requirements', 'pay expectation', 'pay expectations',
      'base salary expectation', 'what salary',
    ],
    answer: (p) => {
      const c = p.searchIntent.compensation;
      if (stated(c.display)) return c.display;
      // `||` rather than `??`: a stated salary of 0 is not a salary.
      const amount = c.targetAnnual || c.minAnnual;
      if (!amount) return null;
      return `Around ${amount.toLocaleString('en-US')} ${c.currency} per year (negotiable).`;
    },
  },
  {
    id: 'start_date',
    patterns: ['start date', 'when can you start', 'availability to start', 'notice period'],
    answer: (p) => (stated(p.searchIntent.startDate) ? p.searchIntent.startDate : null),
  },
  {
    id: 'relocation',
    patterns: ['willing to relocate', 'open to relocation', 'relocate for this role'],
    answer: (p) => {
      const r = p.searchIntent.relocation;
      const notes = stated(r.notes) ? r.notes : '';
      if (r.willing) return notes ? `Yes. ${notes}` : 'Yes, I am open to relocation.';
      // Only stated when the profile has something to say about it at all.
      return notes ? `No. ${notes}` : null;
    },
  },
  {
    id: 'years_experience',
    patterns: ['years of experience', 'total experience'],
    answer: (p) => {
      const years = p.background.yearsExperience;
      return Number.isFinite(years) && years > 0 ? `${years}+ years` : null;
    },
  },
];

/**
 * The screening answers a profile can state on its own behalf.
 *
 * @param {object} profile normalized profile
 * @returns {Array<{id, patterns, answer, type, derivedFrom}>}
 */
export function deriveScreeningAnswers(profile) {
  const p = normalizeProfile(profile);
  const out = [];
  for (const spec of DERIVED_ANSWER_SPECS) {
    const answer = spec.answer(p);
    if (!answer || !String(answer).trim()) continue;
    out.push({
      id: spec.id,
      patterns: spec.patterns,
      answer: String(answer).trim(),
      type: 'text',
      derivedFrom: `config/profiles/${p.id}.json`,
    });
  }
  return out;
}

/**
 * Every question whose answer is a PERSONAL FACT the active profile owns.
 *
 * This is the whole list, not the subset a given profile happens to be able to
 * answer — and that difference is the point.
 *
 * WHY. `effectiveAnswers` let a derived entry shadow the stored entry with the
 * same id, which correctly replaced the previous person's facts whenever the
 * new profile could state its own. When it could NOT, nothing was derived,
 * nothing was shadowed, and the stored entry — written by and about somebody
 * else — was still the best match for the question. Measured on a profile
 * stating no experience and no salary: it answered "12+ years" and
 * "180,000 USD", both inherited from the previous candidate.
 *
 * Silence has to shadow too. A profile that cannot state its own years of
 * experience must produce no answer at all, not the last person's.
 */
export const PROFILE_OWNED_ANSWER_IDS = Object.freeze(DERIVED_ANSWER_SPECS.map((s) => s.id));

/**
 * Merge derived answers into the user's screening-answers document.
 *
 * The user's own `answers` array is left EXACTLY as written. Derived entries go
 * in their own key and take precedence at match time (see `effectiveAnswers` in
 * src/apply/screeningQA.js), so switching profiles can never edit — or silently
 * keep — a sentence the previous person wrote about themselves.
 *
 * @param {object} baseAnswers current config/screening_answers.json
 * @param {object} derived from `deriveFromProfile`
 * @returns {object}
 */
export function applyScreeningAnswers(baseAnswers = {}, derived) {
  return {
    ...baseAnswers,
    derivedAnswers: derived.screeningAnswers,
    // The questions this profile OWNS, whether or not it could answer them.
    // `effectiveAnswers` withholds a stored answer for any id on this list, so
    // a fact the active profile does not state can never be supplied by the
    // previous profile's saved answer. See PROFILE_OWNED_ANSWER_IDS.
    profileOwnedAnswerIds: [...PROFILE_OWNED_ANSWER_IDS],
    // Which profile these were generated for. `effectiveAnswers` uses it to
    // tell a stored answer the user wrote under THIS profile (still theirs,
    // still used) from one left over from another (withheld).
    profileId: derived.profile.id,
    _derivedNote: 'derivedAnswers are generated from the active search profile and take precedence '
      + 'over the matching id in "answers". They exist so that switching profiles cannot leave one '
      + "person's work authorization, pay expectation or start date on another person's application. "
      + 'Edit the profile to change them; your own entries in "answers" are never rewritten.',
  };
}
