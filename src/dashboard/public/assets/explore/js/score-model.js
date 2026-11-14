/**
 * The Score Lab's model: the scoring arithmetic of src/scoring/scorer.js and
 * the tiering of src/scoring/explainScore.js, restated over a handful of
 * switches so a reader can move one input and watch the verdict change.
 *
 * It is a restatement, not a second scorer. The real scorer reads a posting's
 * text; this takes the facts that reading would produce ("5 of your 8 skills
 * were found") as inputs. `tests/node/exploreContent.test.js` builds real
 * postings with those properties, runs them through the real scorer, and fails
 * if the two ever disagree on a total or a tier.
 *
 * Pure: no DOM, no I/O.
 */

/**
 * Weights and thresholds of a generated profile: the three profile-derived
 * categories (title, core skills, industry) plus the structural weights in
 * config/scoring.json. They sum to 100, so points read directly as a score.
 */
export const SCORE_MODEL = Object.freeze({
  categories: Object.freeze([
    { id: 'titleFit', label: 'Title fit', weight: 18, fullAt: 1 },
    { id: 'coreSkills', label: 'Core skills', weight: 30, fullAt: 6 },
    { id: 'domainFit', label: 'Industry', weight: 6, fullAt: 1 },
  ]),
  weights: Object.freeze({
    seniorityFit: 8,
    sponsorshipFeasibility: 10,
    companySponsorshipLikelihood: 5,
    geographyFit: 6,
    freshness: 4,
    directAtsAvailability: 3,
    resumeKeywordAlignment: 10,
  }),
  /** Penalty-only factors: they subtract and add nothing to the denominator. */
  penalties: Object.freeze({ eligibility: 8, payFit: 6, trackFit: 20 }),
  tiers: Object.freeze({ priority: 85, apply: 75, queue: 60, nearMiss: 50 }),
  /** Credit for a skill named only under "nice to have" (PREFERRED_SKILL_CREDIT). */
  preferredCredit: 0.3,
  /** Skills in the example profile. */
  profileSkills: 8,
  /** Discovery window and retention limit, in days, for the freshness curve. */
  freshness: Object.freeze({ discoveryDays: 7, retentionDays: 45 }),
  /** Sponsorship statuses that let a job stay in Apply or Priority. */
  gateAllows: Object.freeze(['Confirmed', 'Likely']),
});

export const TIER_NAMES = Object.freeze({
  PRIORITY: 'Priority', APPLY: 'Apply', QUEUE: 'Queue', NEAR_MISS: 'Near miss', DISCARD: 'Discard',
});

/** Labels for the structural rows, in display order. */
const STRUCTURAL_LABELS = Object.freeze({
  seniorityFit: 'Seniority',
  sponsorshipFeasibility: 'Sponsorship stated',
  companySponsorshipLikelihood: 'Employer sponsors',
  geographyFit: 'Location',
  freshness: 'Freshness',
  directAtsAvailability: 'Direct employer link',
  resumeKeywordAlignment: 'Profile overlap',
});

const SENIORITY = Object.freeze({
  match: { factor: 1, reason: 'Same level as yours' },
  up1: { factor: 1, reason: 'One step up' },
  up2: { factor: 0.75, reason: 'Two steps up' },
  // Three steps above a senior IC is a director: a job managing people.
  up3: { factor: 0.4, reason: 'Three or more steps up', managesPeople: true },
  down1: { factor: 0.5, reason: 'One step below' },
  down2: { factor: 0.15, reason: 'Two or more steps below' },
  unstated: { factor: 0.6, reason: 'Level not stated' },
});

const SPONSORSHIP_STATED = Object.freeze({ Confirmed: 1, Likely: 0.7, Unconfirmed: 0.35 });
const SPONSORSHIP_EMPLOYER = Object.freeze({ Confirmed: 1, Likely: 1, Unconfirmed: 0.2 });

const LOCATION = Object.freeze({
  remote: { factor: 1, reason: 'Remote, and you accept remote' },
  onsite_ok: { factor: 0.8, reason: 'On site or hybrid, which you accept' },
  onsite_unwanted: { factor: 0.4, reason: 'On site, and you want remote' },
  unknown: { factor: 0.5, reason: 'Location not stated' },
});

/** Years short of a stated floor -> share of the eligibility penalty. Three or more is ineligible. */
const ELIGIBILITY = Object.freeze({
  none: { share: 0, verdict: 'eligible', reason: '' },
  stretch1: { share: 1 / 3, verdict: 'stretch', reason: 'One year short of the stated experience' },
  stretch2: { share: 2 / 3, verdict: 'stretch', reason: 'Two years short of the stated experience' },
  ineligible: { share: 1, verdict: 'ineligible', reason: 'A stated requirement is not met' },
});

/** The inputs a fresh lab starts with: a good match with one gap. */
export const DEFAULT_INPUTS = Object.freeze({
  titleMatch: true,
  skillsFound: 5,
  skillsPreferredOnly: 1,
  domainMatch: false,
  seniority: 'match',
  needsSponsorship: true,
  sponsorship: 'Likely',
  location: 'remote',
  ageDays: 2,
  directAts: true,
  eligibility: 'none',
  payShortfall: 0,
});

/** Named starting points that each show one rule at work. */
export const PRESETS = Object.freeze([
  { id: 'good', name: 'A good match', inputs: {} },
  { id: 'gated', name: 'Strong fit, sponsorship unknown', inputs: { skillsFound: 7, skillsPreferredOnly: 0, domainMatch: true, sponsorship: 'Unconfirmed' } },
  { id: 'floor', name: 'Strong fit, requirement not met', inputs: { skillsFound: 7, skillsPreferredOnly: 0, domainMatch: true, sponsorship: 'Confirmed', eligibility: 'ineligible' } },
  { id: 'stale', name: 'Right title, thin overlap', inputs: { skillsFound: 2, skillsPreferredOnly: 1, seniority: 'unstated', location: 'unknown', ageDays: 20, directAts: false } },
]);

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** freshnessFactor() in scorer.js: full on day 0, half at the discovery window, zero at retention. */
export function freshnessFactor(age, { discoveryDays, retentionDays }) {
  if (age <= 0) return 1;
  if (age <= discoveryDays) return 1 - 0.5 * (age / discoveryDays);
  if (age >= retentionDays) return 0;
  return 0.5 * (1 - (age - discoveryDays) / (retentionDays - discoveryDays));
}

/** rawTier() in explainScore.js. */
export function tierFor(total, tiers = SCORE_MODEL.tiers) {
  if (total >= tiers.priority) return TIER_NAMES.PRIORITY;
  if (total >= tiers.apply) return TIER_NAMES.APPLY;
  if (total >= tiers.queue) return TIER_NAMES.QUEUE;
  if (total >= tiers.nearMiss) return TIER_NAMES.NEAR_MISS;
  return TIER_NAMES.DISCARD;
}

/** Fill in defaults and keep every input inside its legal range. */
export function normalizeInputs(inputs = {}) {
  const merged = { ...DEFAULT_INPUTS, ...inputs };
  const skillsFound = clamp(Math.round(Number(merged.skillsFound) || 0), 0, SCORE_MODEL.profileSkills);
  return {
    ...merged,
    skillsFound,
    skillsPreferredOnly: clamp(Math.round(Number(merged.skillsPreferredOnly) || 0), 0, skillsFound),
    seniority: SENIORITY[merged.seniority] ? merged.seniority : 'match',
    sponsorship: SPONSORSHIP_STATED[merged.sponsorship] !== undefined ? merged.sponsorship : 'Unconfirmed',
    location: LOCATION[merged.location] ? merged.location : 'unknown',
    eligibility: ELIGIBILITY[merged.eligibility] ? merged.eligibility : 'none',
    ageDays: merged.ageDays === null ? null : clamp(Math.round(Number(merged.ageDays) || 0), 0, 60),
    payShortfall: clamp(Number(merged.payShortfall) || 0, 0, 1),
  };
}

/**
 * Score one set of inputs.
 * @param {Partial<typeof DEFAULT_INPUTS>} [inputs]
 * @returns {{ rows: Array<{id: string, label: string, points: number, weight: number, reason: string}>,
 *   penalties: Array<{id: string, label: string, points: number, reason: string}>,
 *   raw: number, max: number, total: number, rawTier: string, tier: string,
 *   held: null|'sponsorship'|'eligibility', heldReason: string }}
 */
export function scoreInputs(inputs = {}) {
  const x = normalizeInputs(inputs);
  const m = SCORE_MODEL;
  const w = m.weights;
  const [title, skills, domain] = m.categories;
  const rows = [];

  rows.push({
    id: title.id, label: title.label, weight: title.weight,
    points: x.titleMatch ? title.weight : 0,
    reason: x.titleMatch ? 'The posting’s title contains one of your target titles' : 'The title matches none of your target titles',
  });

  const required = x.skillsFound - x.skillsPreferredOnly;
  const credit = required + m.preferredCredit * x.skillsPreferredOnly;
  rows.push({
    id: skills.id, label: skills.label, weight: skills.weight,
    points: round2(skills.weight * Math.min(1, credit / skills.fullAt)),
    reason: `${x.skillsFound} of your ${m.profileSkills} skills found`
      + (x.skillsPreferredOnly ? `, ${x.skillsPreferredOnly} only under “nice to have”` : '')
      + `. Full marks at ${skills.fullAt}.`,
  });

  rows.push({
    id: domain.id, label: domain.label, weight: domain.weight,
    points: x.domainMatch ? domain.weight : 0,
    reason: x.domainMatch ? 'The posting names an industry you have worked in' : 'No industry from your profile is named',
  });

  const seniority = SENIORITY[x.seniority];
  rows.push({
    id: 'seniorityFit', label: STRUCTURAL_LABELS.seniorityFit, weight: w.seniorityFit,
    points: round2(w.seniorityFit * seniority.factor), reason: seniority.reason,
  });

  const noNeed = x.needsSponsorship === false;
  rows.push({
    id: 'sponsorshipFeasibility', label: STRUCTURAL_LABELS.sponsorshipFeasibility, weight: w.sponsorshipFeasibility,
    points: noNeed ? w.sponsorshipFeasibility : round2(w.sponsorshipFeasibility * SPONSORSHIP_STATED[x.sponsorship]),
    reason: noNeed ? 'You need no sponsorship, so this is full' : `The posting reads as ${x.sponsorship}`,
  });
  rows.push({
    id: 'companySponsorshipLikelihood', label: STRUCTURAL_LABELS.companySponsorshipLikelihood, weight: w.companySponsorshipLikelihood,
    points: noNeed ? w.companySponsorshipLikelihood : round2(w.companySponsorshipLikelihood * SPONSORSHIP_EMPLOYER[x.sponsorship]),
    reason: noNeed ? 'You need no sponsorship, so this is full' : `Sponsorship is ${x.sponsorship}`,
  });

  const location = LOCATION[x.location];
  rows.push({
    id: 'geographyFit', label: STRUCTURAL_LABELS.geographyFit, weight: w.geographyFit,
    points: round2(w.geographyFit * location.factor), reason: location.reason,
  });

  rows.push({
    id: 'freshness', label: STRUCTURAL_LABELS.freshness, weight: w.freshness,
    points: round2(w.freshness * (x.ageDays === null ? 0.5 : freshnessFactor(x.ageDays, m.freshness))),
    reason: x.ageDays === null ? 'Posting date unknown' : `Posted ${x.ageDays} day${x.ageDays === 1 ? '' : 's'} ago`,
  });

  rows.push({
    id: 'directAtsAvailability', label: STRUCTURAL_LABELS.directAtsAvailability, weight: w.directAtsAvailability,
    points: x.directAts ? w.directAtsAvailability : 0,
    reason: x.directAts ? 'The link goes to the employer’s own application' : 'Found through an aggregator',
  });

  rows.push({
    id: 'resumeKeywordAlignment', label: STRUCTURAL_LABELS.resumeKeywordAlignment, weight: w.resumeKeywordAlignment,
    points: round2(w.resumeKeywordAlignment * Math.min(1, x.skillsFound / Math.min(8, m.profileSkills))),
    reason: `${x.skillsFound} of your ${m.profileSkills} profile skills appear anywhere in the posting`,
  });

  const penalties = [];
  const eligibility = ELIGIBILITY[x.eligibility];
  if (eligibility.share > 0) {
    penalties.push({
      id: 'eligibility', label: 'Stated requirement',
      points: -round2(m.penalties.eligibility * eligibility.share), reason: eligibility.reason,
    });
  }
  // Track: a people-manager posting for a search that targets IC roles (the
  // lab's search does). Level and track are separate questions.
  if (SENIORITY[x.seniority].managesPeople) {
    penalties.push({
      id: 'trackFit', label: 'Track',
      points: -round2(m.penalties.trackFit), reason: 'A people-manager role; your search targets individual-contributor roles',
    });
  }
  if (x.payShortfall > 0) {
    penalties.push({
      id: 'payFit', label: 'Posted pay',
      points: -round2(m.penalties.payFit * Math.min(1, x.payShortfall / 0.25)),
      reason: `Posted pay tops out ${Math.round(x.payShortfall * 100)}% below your target`,
    });
  }

  const sum = [...rows, ...penalties].reduce((s, r) => s + r.points, 0);
  const raw = Math.max(0, sum);
  const max = rows.reduce((s, r) => s + r.weight, 0);
  const total = max > 0 ? Math.round((raw / max) * 100) : 0;

  const rawTier = tierFor(total, m.tiers);
  let tier = rawTier;
  let held = null;
  let heldReason = '';
  const strong = tier === TIER_NAMES.PRIORITY || tier === TIER_NAMES.APPLY;
  if (strong && !noNeed && !m.gateAllows.includes(x.sponsorship)) {
    tier = TIER_NAMES.QUEUE;
    held = 'sponsorship';
    heldReason = 'The score qualifies, and sponsorship is not confirmed. It waits in Queue for you to verify.';
  }
  if ((tier === TIER_NAMES.PRIORITY || tier === TIER_NAMES.APPLY) && eligibility.verdict === 'ineligible') {
    tier = TIER_NAMES.QUEUE;
    held = 'eligibility';
    heldReason = 'The score qualifies, and a stated requirement is not met. It stays in Queue with the reason shown.';
  }

  return { rows, penalties, raw: round2(raw), max, total, rawTier, tier, held, heldReason };
}
