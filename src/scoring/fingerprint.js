/**
 * "Was this score produced by the configuration that is loaded right now?"
 *
 * WHY THIS EXISTS. Discovery is incremental: a job whose record has not
 * materially changed and already carries a score is skipped rather than scored
 * again. `materiallyUnchanged` compares the POSTING — company, title, location,
 * URL, description, date, employment type — and nothing else, so it answered
 * "nothing changed" even when everything about the person doing the searching
 * had. Measured: switching a test candidate from engineering to nursing left a
 * previously scored engineering job showing 94/100, with zero jobs rescored.
 * The board presented one candidate's verdicts as the current candidate's.
 *
 * A score is a function of the job AND the configuration that judged it, so
 * "unchanged" has to mean both. This module reduces the judging half to one
 * short string that is stored beside the score, and the incremental skip
 * requires it to match.
 *
 * WHAT GOES IN. Only inputs that can change a score or a tier. Including more
 * would rescore the corpus over edits that cannot alter a verdict — expensive
 * and, in a 100k-row database, noticeable. Including less would leave a stale
 * verdict on the board, which is the bug.
 */

import { createHash } from 'node:crypto';

import { loadRoleFamilies } from '../profile/roleFamilies.js';
import { TITLE_MATCH_VERSION } from './titleMatch.js';
import { SCORER_VERSION } from './scorer.js';
import { ELIGIBILITY_VERSION, candidateYearsOfExperience, candidateDegreeLevel } from './eligibility.js';

/** taxonomy object -> digest, so the taxonomy is hashed once per load. */
const TAXONOMY_DIGESTS = new WeakMap();

/**
 * Short digest of the role-family taxonomy in effect for this config: an
 * injected `config.roleFamilies`, else config/role_families.json under
 * `config.root`. Null when none can be read (never throws).
 */
function taxonomyDigest(config) {
  let taxonomy;
  try {
    taxonomy = config.roleFamilies ?? loadRoleFamilies(config.root);
  } catch {
    return null;
  }
  if (!taxonomy || typeof taxonomy !== 'object') return null;
  let digest = TAXONOMY_DIGESTS.get(taxonomy);
  if (!digest) {
    digest = createHash('sha1').update(JSON.stringify(stable(taxonomy))).digest('hex').slice(0, 12);
    TAXONOMY_DIGESTS.set(taxonomy, digest);
  }
  return digest;
}

/** Whole years, as eligibility compares them (see assessEligibility). */
function wholeYears(years) {
  return years === null ? null : Math.floor(years);
}

/** Sort object keys recursively so key ORDER can never change a fingerprint. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value ?? null;
}

/**
 * A short, stable fingerprint of everything that decides a job's score + tier.
 *
 * @param {object} config loadConfig() bundle
 * @returns {string} 16 hex characters
 */
export function scoringFingerprint(config = {}) {
  return createHash('sha1')
    .update(JSON.stringify(stable(scoringFingerprintMaterial(config))))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The inputs `scoringFingerprint` hashes, exposed so a test can assert WHAT is
 * fingerprinted (e.g. a matcher version) rather than only that a hash moved.
 *
 * @param {object} config loadConfig() bundle
 * @returns {object}
 */
export function scoringFingerprintMaterial(config = {}) {
  const candidate = config.candidate ?? {};
  const scoring = config.scoring ?? {};
  const exclusions = config.exclusions ?? {};

  const material = {
    // WHO is being scored. The active profile id alone would not do it: a
    // profile can be edited in place, and candidate.json can also be written
    // directly, so the inputs themselves are fingerprinted.
    profileId: config.profile?.id ?? null,
    targetTitles: candidate.targetTitles ?? [],
    technicalStack: candidate.technicalStack ?? {},
    seniority: candidate.seniority ?? null,
    domainExperience: candidate.domainExperience ?? [],
    locationPreferences: candidate.locationPreferences ?? {},
    certifications: candidate.certifications ?? [],
    // Tri-state, and it now changes both the sponsorship categories and the
    // tier gate — so it must change the fingerprint.
    requiresSponsorship: candidate.workAuthorization?.requiresSponsorship
      ?? candidate.sponsorshipRequired ?? null,
    salaryPreference: candidate.salaryPreference ?? {},
    employmentPreferences: candidate.employmentPreferences ?? {},
    prohibited: candidate.prohibited ?? {},

    // HOW it is judged.
    weights: scoring.weights ?? {},
    categories: scoring.categories ?? null,
    keywords: scoring.keywords ?? {},
    marketSkills: scoring.marketSkills ?? [],
    tiers: scoring.tiers ?? {},
    sponsorshipGate: scoring.sponsorshipGate ?? {},
    freshness: scoring.freshness ?? {},
    evidenceAliases: scoring.evidenceAliases ?? {},
    // Sponsorship vocabulary decides Confirmed/Likely, which carries weighted
    // points AND the Apply gate — editing likelySponsors used to leave every
    // stored verdict looking current.
    sponsorship: {
      affirmativePhrases: scoring.sponsorship?.affirmativePhrases ?? [],
      likelySponsors: scoring.sponsorship?.likelySponsors ?? [],
    },
    payFitWeight: scoring.weights?.payFit ?? null,
    trackFitWeight: scoring.weights?.trackFit ?? null,
    // The role-family taxonomy decides title accept/defer/reject, which gates
    // the near-miss tier; it is data in config/role_families.json, so it is
    // hashed rather than inlined.
    roleFamilies: taxonomyDigest(config),
    // Freshness points are graded against the discovery window (F8).
    discoveryWindow: config.runtime?.jobFreshnessMode ?? null,
    // MATCHING SEMANTICS, not only matching inputs. Folding "Data Engineering"
    // into "Data Engineer" moved 7 of 6,185 live scored rows from 0 to full
    // title points with no config edit at all, so without this the incremental
    // skip would have kept every one of those stale verdicts.
    titleMatcher: TITLE_MATCH_VERSION,
    // How a posting is read (seniority words, preferred-only skills).
    scorer: SCORER_VERSION,
    // Eligibility compares the posting's floor with the candidate's years and
    // degree. The DERIVED values are hashed, not the raw work history: a
    // reworded bullet cannot change a verdict, but a new role, a corrected
    // start date — or another year of tenure passing — can. The weight is
    // already covered by `weights`.
    eligibility: {
      version: ELIGIBILITY_VERSION,
      years: wholeYears(candidateYearsOfExperience(candidate)),
      degree: candidateDegreeLevel(candidate),
    },

    // WHAT IS THROWN AWAY BEFORE JUDGING. An exclusion change does not alter a
    // score, but it does alter whether the row should be on the board at all.
    exclusions: {
      sponsorshipDenial: exclusions.sponsorshipDenial ?? [],
      securityClearance: exclusions.securityClearance ?? [],
      clearanceAllowance: exclusions.clearanceAllowance ?? [],
      roleMismatch: exclusions.roleMismatch ?? [],
      roleMismatchDerived: exclusions.roleMismatchDerived ?? [],
      roleMismatchBody: exclusions.roleMismatchBody ?? [],
      employmentMismatch: exclusions.employmentMismatch ?? [],
      geographyMismatch: exclusions.geographyMismatch ?? [],
      geography: exclusions.geography ?? {},
      staleness: exclusions.staleness ?? {},
      // Employment classification feeds the employment-type constraint.
      employmentTypes: exclusions.employmentTypes ?? {},
    },
  };
  return material;
}
