/**
 * Application profile store — the dashboard's editor for the two personal
 * config files the form filler reads.
 *
 *   config/candidate.json         who you are (name, contact, address, links)
 *   config/screening_answers.json how to answer the questions forms ask
 *
 * Both were hand-edited JSON until now, which meant a typo in either one broke
 * every future application silently. Everything written here is validated
 * before it reaches disk (candidate.json against its shipped JSON schema), the
 * previous version is kept, and the write is atomic — a crash mid-save can
 * never leave a half-written profile that fails to load at startup.
 *
 * Two safety properties are deliberately preserved:
 *
 *   1. The editor can only set the fields the FILLER can actually use. Every
 *      other part of candidate.json (work history, education, target titles,
 *      scoring preferences) is merged through untouched, so a form submit can
 *      never blank out the data tailoring and scoring depend on.
 *   2. No answer that misrepresents work authorization can be saved. The same
 *      truthfulness rules the runner enforces at fill time are enforced here at
 *      save time, including the inverted-sponsorship-question case that a
 *      phrase blocklist alone cannot catch.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { readJson, CONFIG_FILES } from './loadConfig.js';
import { SCHEMA_FILES, createValidator, validateConfig } from './validateConfig.js';
import {
  validateAnswerEntry, MAX_ANSWER_CHARS, MAX_ANSWER_ENTRIES,
} from './screeningAnswerRules.js';
import { valueForField } from '../apply/formPrefill.js';
import { readActiveProfile, saveProfile, mergeIntoActiveProfile, activateProfile } from '../profile/store.js';

/**
 * The fields the form filler can actually put on an application, each mapped to
 * where it lives in candidate.json. This list IS the editor: anything not here
 * is untouched by a save.
 *
 * firstName / lastName / location are deliberately absent — formPrefill derives
 * them (the name is split on the first space, a single "Location" typeahead is
 * seeded from the city), so offering them as separate boxes would let the two
 * disagree.
 */
export const PROFILE_FIELDS = Object.freeze([
  {
    field: 'fullName', path: 'identity.fullName', label: 'Full legal name', required: true,
    hint: 'Split into First / Last automatically; combined "First and Last Name" boxes get all of it.',
  },
  { field: 'preferredName', path: 'identity.preferredName', label: 'Preferred name', hint: 'Falls back to your first name.' },
  { field: 'email', path: 'contact.email', label: 'Email', type: 'email', required: true },
  { field: 'phone', path: 'contact.phone', label: 'Phone', type: 'tel', required: true },
  { field: 'addressLine1', path: 'location.street', label: 'Street address' },
  { field: 'addressLine2', path: 'location.street2', label: 'Apt / suite / unit' },
  { field: 'city', path: 'location.city', label: 'City', required: true, hint: 'Also seeds single-box "Location" typeaheads.' },
  { field: 'state', path: 'location.state', label: 'State / province', required: true },
  { field: 'zip', path: 'location.zip', label: 'ZIP / postal code' },
  { field: 'country', path: 'location.country', label: 'Country', required: true },
  { field: 'linkedin', path: 'identity.links.linkedin', label: 'LinkedIn URL', type: 'url' },
  { field: 'github', path: 'identity.links.github', label: 'GitHub URL', type: 'url', hint: 'Optional. Mostly asked by software and data roles; leave blank if it does not apply.' },
  { field: 'portfolio', path: 'identity.links.portfolio', label: 'Portfolio / website', type: 'url' },
]);

const PROFILE_PATHS = new Set(PROFILE_FIELDS.map((f) => f.path));

/** Longest value accepted in a profile box — these are form fields, not essays. */
const MAX_PROFILE_VALUE_CHARS = 300;

const candidatePath = (root) => join(root, 'config', CONFIG_FILES.candidate);
const screeningPath = (root) => join(root, 'config', CONFIG_FILES.screeningAnswers);
const candidateSchemaPath = (root) => join(root, 'config', 'schemas', SCHEMA_FILES.candidate);

/**
 * The candidate's real sponsorship requirement, read from candidate.json.
 *
 * Returns `undefined` when it cannot be determined, which the truthfulness
 * checks treat as UNKNOWN rather than as "does not require" — guessing the
 * permissive answer is the one mistake that could let a false claim through.
 *
 * @param {string} root
 * @returns {boolean|undefined}
 */
export function sponsorshipRequirement(root) {
  try {
    const candidate = readJson(candidatePath(root));
    const value = candidate?.workAuthorization?.requiresSponsorship ?? candidate?.sponsorshipRequired;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The active search profile's id, or null. Never throws. */
function activeProfileId(root) {
  try { return readActiveProfile(root)?.id ?? null; } catch { return null; }
}

/** Read a dotted path out of an object. */
function getPath(object, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

/** Write a dotted path into an object, creating intermediate objects. */
function setPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = object;
  for (const key of keys) {
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[last] = value;
}

/**
 * Current profile, annotated with what the filler can and cannot fill.
 *
 * `missing` is the honest answer to "what will be left blank on the next form",
 * which is exactly the question the dashboard needs to ask before an auto-apply
 * batch — a blank REQUIRED field is what turns a run into `assist_blocked`.
 *
 * @param {string} root project root
 * @returns {{path: string, exists: boolean, fields: object[], missing: string[], error?: string}}
 */
export function readProfile(root) {
  const path = candidatePath(root);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      fields: PROFILE_FIELDS.map((spec) => ({ ...spec, value: '', filled: false })),
      missing: PROFILE_FIELDS.filter((f) => f.required).map((f) => f.field),
      error: 'config/candidate.json does not exist yet, copy config/candidate.example.json and fill it in, or save this form.',
    };
  }
  let candidate;
  try {
    candidate = readJson(path);
  } catch (err) {
    return { path, exists: true, fields: [], missing: [], error: err.message };
  }
  const fields = PROFILE_FIELDS.map((spec) => {
    // Read through the SAME resolver the filler uses, so what this page shows
    // as "filled" is what a form would actually receive — never a value that
    // exists in the file but the filler cannot reach.
    const value = valueForField(spec.field, candidate) ?? '';
    return { ...spec, value: String(value), filled: String(value).trim().length > 0 };
  });
  return {
    path,
    exists: true,
    fields,
    missing: fields.filter((f) => f.required && !f.filled).map((f) => f.field),
  };
}

/**
 * Save the profile fields, merging them into the existing candidate.json.
 *
 * @param {string} root project root
 * @param {Record<string, string>} values dotted path -> value (see PROFILE_FIELDS)
 * @returns {{path: string, backup: string|null, changed: string[]}}
 * @throws {Error} on an unknown path, an over-long value, or a schema violation
 */
export function writeProfile(root, values = {}) {
  const path = candidatePath(root);
  const candidate = existsSync(path) ? readJson(path) : templateCandidate(root);

  const changed = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!PROFILE_PATHS.has(key)) {
      throw new Error(`"${key}" is not an editable profile field`);
    }
    const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (value.length > MAX_PROFILE_VALUE_CHARS) {
      throw new Error(`${key} is too long (${value.length} characters, limit ${MAX_PROFILE_VALUE_CHARS})`);
    }
    if (getPath(candidate, key) !== value) changed.push(key);
    setPath(candidate, key, value);
  }

  // The template carries an explanatory _note; once the user has edited the
  // profile through the UI it is theirs, not a template.
  if (changed.length) delete candidate._note;

  assertCandidateValid(root, candidate);
  const backup = keepPreviousVersion(path);
  writeFileAtomic(path, `${JSON.stringify(candidate, null, 2)}\n`);
  // candidate.json is a GENERATED VIEW when a search profile is active, so
  // writing only here is a save that quietly expires. See `writeThroughToProfile`.
  const profile = changed.length ? writeThroughToProfile(root, values) : null;
  return { path, backup, changed, profile };
}

/**
 * Mirror an edit back into the active SEARCH PROFILE.
 *
 * WHY A SECOND WRITE. Activating a profile REGENERATES candidate.json from
 * `config/profiles/<id>.json` — that is the seam that makes profiles work. This
 * editor wrote only candidate.json, so a save looked successful, survived until
 * the next activation, and was then silently replaced by the profile's older
 * value. Reproduced: saving a changed email and reactivating the same profile
 * brought the old email back. A save the user is told succeeded has to be a
 * save that lasts.
 *
 * Only the identity / contact / location fields this editor owns are written,
 * and they live at the same paths in both shapes, so the mirror is a direct
 * copy rather than a mapping that could drift. A failure here must NOT fail the
 * save: candidate.json is already correct on disk and is what the filler reads;
 * the profile is reported back so the caller can surface the discrepancy.
 *
 * @param {string} root
 * @param {Record<string, string>} values the same dotted paths writeProfile took
 * @returns {{id: string, written: boolean, error?: string}|null} null when no
 *   profile is active (candidate.json is then the source of truth already)
 */
function writeThroughToProfile(root, values) {
  let active;
  try {
    active = readActiveProfile(root);
  } catch {
    return null;
  }
  if (!active) return null;
  try {
    const next = JSON.parse(JSON.stringify(active));
    for (const [key, raw] of Object.entries(values)) {
      if (!PROFILE_PATHS.has(key)) continue;
      setPath(next, key, String(raw ?? '').replace(/\s+/g, ' ').trim());
    }
    const saved = saveProfile(root, next);
    return { id: saved.id, written: true };
  } catch (err) {
    return { id: active.id, written: false, error: err.message };
  }
}



/** Most target titles worth searching. Each one costs requests on every run. */
const MAX_TARGET_TITLES = 40;
/** Most skill terms in technicalStack.other. */
const MAX_STACK_TERMS = 200;

/**
 * Adopt role titles and/or skill terms proposed from the master resume.
 *
 * This is the write half of the resume-to-search loop. It is deliberately
 * separate from `writeProfile` (which edits the contact boxes on a form) because
 * it edits what the pipeline SEARCHES FOR — `targetTitles` drives Workday's
 * derived search phrases, atsSearch, Adzuna, Amazon and `classifyTitleFit`, so
 * one careless write changes every source at once.
 *
 * Additive only. Nothing the user already targets is removed, because the
 * resume is evidence of what they have done and is not a statement of what they
 * want next — see src/resume/resumeProfile.js for why that distinction is load
 * bearing here.
 *
 * @param {string} root
 * @param {object} [selection]
 * @param {string[]} [selection.titles] titles to add to candidate.targetTitles
 * @param {string[]} [selection.skills] terms to add to technicalStack.other
 * @returns {{path: string, backup: string|null, addedTitles: string[], addedSkills: string[]}}
 */
export function adoptResumeEvidence(root, { titles = [], skills = [] } = {}) {
  const path = candidatePath(root);
  const candidate = existsSync(path) ? readJson(path) : templateCandidate(root);

  const activeId = activeProfileId(root);
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const keyOf = (v) => clean(v).toLowerCase();

  const currentTitles = Array.isArray(candidate.targetTitles) ? [...candidate.targetTitles] : [];
  const haveTitles = new Set(currentTitles.map(keyOf));
  const addedTitles = [];
  for (const raw of titles) {
    const title = clean(raw);
    if (!title || title.length > MAX_PROFILE_VALUE_CHARS) continue;
    if (haveTitles.has(keyOf(title))) continue;
    haveTitles.add(keyOf(title));
    currentTitles.push(title);
    addedTitles.push(title);
  }
  // With a profile active, candidate.json holds the EXPANDED titles (often at
  // the cap already); the profile's own roles are what grow, and activation
  // re-applies the cap when it regenerates the view.
  if (!activeId && currentTitles.length > MAX_TARGET_TITLES) {
    throw new Error(
      `That would leave ${currentTitles.length} target titles (limit ${MAX_TARGET_TITLES}). `
      + 'Every title is searched against every configured board on every run — remove some first.',
    );
  }

  const stack = { ...(candidate.technicalStack ?? {}) };
  const other = Array.isArray(stack.other) ? [...stack.other] : [];
  const haveSkills = new Set(Object.values(stack).flat().filter(Boolean).map(keyOf));
  const addedSkills = [];
  for (const raw of skills) {
    const skill = clean(raw);
    if (!skill || skill.length > MAX_PROFILE_VALUE_CHARS) continue;
    if (haveSkills.has(keyOf(skill))) continue;
    haveSkills.add(keyOf(skill));
    other.push(skill);
    addedSkills.push(skill);
  }
  if (!activeId && other.length > MAX_STACK_TERMS) {
    throw new Error(`That would leave ${other.length} terms in technicalStack.other (limit ${MAX_STACK_TERMS}).`);
  }

  if (!addedTitles.length && !addedSkills.length) {
    return { path, backup: null, addedTitles: [], addedSkills: [] };
  }

  /*
   * WRITE THROUGH THE PROFILE, NOT AROUND IT (F9).
   *
   * With a search profile active, candidate.json is a GENERATED view of that
   * profile: the next activation rewrites it from the profile and silently
   * discarded every title and skill adopted here. The adoption now lands in the
   * profile itself (mergeIntoActiveProfile) and the view is regenerated
   * (activateProfile), so it survives every later switch. Without an active
   * profile candidate.json IS the source of truth and is edited directly below.
   */
  if (activeId) {
    mergeIntoActiveProfile(root, { roles: addedTitles, skills: addedSkills });
    activateProfile(root, activeId);
    return { path, backup: null, addedTitles, addedSkills, profileId: activeId };
  }

  candidate.targetTitles = currentTitles;
  /*
   * AN ADOPTED TITLE IS A STATED TITLE.
   *
   * `targetTitles` is the union of two tiers, and only `anchorTitles` is
   * DECISIVE in the title gate (src/scoring/profileFit.js). Writing the union
   * alone left a title the user had just explicitly chosen sitting outside the
   * decisive tier: "Lakehouse Developer" adopted from their own resume scored a
   * title priority of 1 — the same as any unrecognized in-family title — rather
   * than the 4 a stated role gets, and would have been DEFERRED entirely had it
   * fallen outside the family vocabulary.
   *
   * Only maintained when the tiers already exist. A candidate.json written by
   * hand has neither key, and there everything is an anchor already.
   */
  if (Array.isArray(candidate.anchorTitles)) {
    const anchors = [...candidate.anchorTitles];
    const haveAnchors = new Set(anchors.map(keyOf));
    for (const title of addedTitles) {
      if (haveAnchors.has(keyOf(title))) continue;
      haveAnchors.add(keyOf(title));
      anchors.push(title);
    }
    candidate.anchorTitles = anchors;
    // An adopted title outranks a guess: if the expansion had previously
    // offered the same role as merely adjacent, promote it rather than letting
    // it sit in both tiers saying two different things.
    if (Array.isArray(candidate.adjacentTitles)) {
      candidate.adjacentTitles = candidate.adjacentTitles
        .filter((t) => !haveAnchors.has(keyOf(t)));
    }
  }
  candidate.technicalStack = { ...stack, other };
  // Once the user has adopted anything, the profile is theirs, not a template.
  delete candidate._note;

  assertCandidateValid(root, candidate);
  const backup = keepPreviousVersion(path);
  writeFileAtomic(path, `${JSON.stringify(candidate, null, 2)}\n`);
  return { path, backup, addedTitles, addedSkills };
}

/** JSON pointer ("/contact/email") -> the label shown on the form ("Email"). */
const LABEL_BY_POINTER = new Map(
  PROFILE_FIELDS.map((f) => [`/${f.path.split('.').join('/')}`, f.label]),
);

/** Validate a candidate object against the shipped schema; throws on failure. */
function assertCandidateValid(root, candidate) {
  const schemaFile = candidateSchemaPath(root);
  if (!existsSync(schemaFile)) return; // exotic test roots — the writer is still bounded
  const result = validateConfig('candidate', candidate, readJson(schemaFile), { ajv: createValidator() });
  if (!result.valid) {
    // ajv names JSON pointers ("/contact/email"), which is the file's shape,
    // not the form's. Say which BOX is wrong, in the words next to it.
    const lines = (result.errors ?? []).map((e) => {
      const where = LABEL_BY_POINTER.get(e.instancePath) ?? e.instancePath ?? '(root)';
      return `${where} ${e.message}`;
    });
    throw new Error(`That profile would not load, ${lines.join('; ')}`);
  }
}

/**
 * Seed a brand-new candidate.json from the shipped template so a first save
 * still produces a schema-valid file (every required section present).
 */
function templateCandidate(root) {
  const example = join(root, 'config', 'candidate.example.json');
  if (existsSync(example)) return readJson(example);
  throw new Error('config/candidate.example.json is missing, cannot create a new profile from scratch');
}

/** Copy the current file aside as .bak before replacing it. Best effort. */
function keepPreviousVersion(path) {
  if (!existsSync(path)) return null;
  const backup = `${path}.bak`;
  try {
    copyFileSync(path, backup);
    return backup;
  } catch {
    return null;
  }
}

/* ───────────────────────── screening answers ───────────────────────── */

/**
 * Read config/screening_answers.json.
 * @param {string} root
 * @returns {{path: string, exists: boolean, defaults: object, answers: object[], error?: string}}
 */
export function readScreeningAnswers(root) {
  const path = screeningPath(root);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      defaults: { unknownAction: 'ask_user' },
      answers: [],
      derivedAnswers: [],
      error: 'config/screening_answers.json does not exist yet — copy config/screening_answers.example.json, or save an answer here to create it.',
    };
  }
  try {
    const doc = readJson(path);
    return {
      path,
      exists: true,
      defaults: doc.defaults ?? { unknownAction: 'ask_user' },
      answers: Array.isArray(doc.answers) ? doc.answers : [],
      // Surfaced separately, never merged into `answers`: the editor must show
      // the user their own file, and show what the profile is overriding.
      derivedAnswers: Array.isArray(doc.derivedAnswers) ? doc.derivedAnswers : [],
      // The profile-ownership guard written by activation. Read back so every
      // writer can carry it through; dropping it re-exposes the previous
      // candidate's salary, experience and authorization (see effectiveAnswers).
      ...(Array.isArray(doc.profileOwnedAnswerIds) ? { profileOwnedAnswerIds: doc.profileOwnedAnswerIds } : {}),
      ...(doc.profileId ? { profileId: String(doc.profileId) } : {}),
    };
  } catch (err) {
    return { path, exists: true, defaults: {}, answers: [], derivedAnswers: [], error: err.message };
  }
}

/**
 * Re-exported from `./screeningAnswerRules.js`, where it now lives so that
 * `src/profile/store.js` can validate derived answers without importing this
 * module (which must import IT, to write an edit back into the active search
 * profile). Callers and tests keep importing it from here.
 */
export { validateAnswerEntry, MAX_ANSWER_CHARS, MAX_ANSWER_ENTRIES };

/**
 * Validate a whole screening-answers document.
 * @param {object} doc
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateScreeningAnswers(doc, { requiresSponsorship } = {}) {
  if (!doc || typeof doc !== 'object') return { valid: false, error: 'the screening answers must be an object' };
  const unknownAction = doc.defaults?.unknownAction ?? 'ask_user';
  if (!['ask_user', 'skip'].includes(unknownAction)) {
    return { valid: false, error: 'defaults.unknownAction must be "ask_user" or "skip"' };
  }
  const answers = doc.answers;
  if (!Array.isArray(answers)) return { valid: false, error: 'answers must be a list' };
  if (answers.length > MAX_ANSWER_ENTRIES) {
    return { valid: false, error: `that is ${answers.length} answers, the limit is ${MAX_ANSWER_ENTRIES}` };
  }
  const seen = new Set();
  for (const entry of answers) {
    const check = validateAnswerEntry(entry, { requiresSponsorship });
    if (!check.valid) return { valid: false, error: `answer "${entry?.id ?? '(no id)'}": ${check.error}` };
    const id = String(entry.id).trim().toLowerCase();
    if (seen.has(id)) return { valid: false, error: `two answers share the id "${entry.id}" - ids must be unique` };
    seen.add(id);
  }
  return { valid: true, error: null };
}

/**
 * Replace the whole screening-answers document (validated, atomic, backed up).
 * @param {string} root
 * @param {object} doc
 * @returns {{path: string, backup: string|null, count: number}}
 */
export function writeScreeningAnswers(root, doc, { requiresSponsorship = sponsorshipRequirement(root) } = {}) {
  const check = validateScreeningAnswers(doc, { requiresSponsorship });
  if (!check.valid) throw new Error(check.error);
  const path = screeningPath(root);
  const onDisk = readScreeningAnswers(root);
  const next = {
    defaults: { unknownAction: 'ask_user', ...(doc.defaults ?? {}) },
    answers: stampOwnership(doc.answers, onDisk.answers, activeProfileId(root)),
  };
  // Generated by activating a search profile, and NOT the user's to edit here.
  // This writer rebuilds the document from scratch, so without carrying them
  // through, saving one hand-written answer would silently delete every derived
  // one and put the previous candidate's stored facts back in play.
  const derived = doc.derivedAnswers ?? onDisk.derivedAnswers;
  if (Array.isArray(derived) && derived.length) next.derivedAnswers = derived;
  // The ownership guard is generated by activation, like derivedAnswers, and is
  // never the editor's to drop: the file on disk is authoritative. Losing it
  // let a saved answer put the previous candidate's facts back in play.
  const owned = onDisk.profileOwnedAnswerIds ?? doc.profileOwnedAnswerIds;
  if (Array.isArray(owned) && owned.length) next.profileOwnedAnswerIds = owned;
  const ownerId = onDisk.profileId ?? doc.profileId;
  if (ownerId) next.profileId = String(ownerId);
  if (doc._derivedNote) next._derivedNote = doc._derivedNote;
  if (doc._note) next._note = doc._note;
  const backup = keepPreviousVersion(path);
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { path, backup, count: next.answers.length };
}

/**
 * Keep each answer's `profileId` (whose answer it is) across a whole-list save.
 *
 * The editor sends every row back without the stamp. Stripping it would turn a
 * fact one candidate stated about themselves into an unowned answer that every
 * other candidate's applications then use. So: an answer saved unchanged keeps
 * the stamp it had; one whose text changed (or a new one) belongs to the
 * profile that is active now.
 *
 * @param {object[]} incoming answers being written
 * @param {object[]} stored answers currently on disk
 * @param {string|null} activeId the active search profile's id
 * @returns {object[]}
 */
export function stampOwnership(incoming, stored = [], activeId = null) {
  const byId = new Map(stored.map((a) => [String(a?.id ?? '').toLowerCase(), a]));
  return incoming.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const before = byId.get(String(entry.id ?? '').toLowerCase());
    const unchanged = before && String(before.answer ?? '') === String(entry.answer ?? '');
    const owner = entry.profileId ?? (unchanged ? before.profileId : activeId);
    const { profileId: _drop, ...rest } = entry;
    return owner ? { ...rest, profileId: String(owner) } : rest;
  });
}

/**
 * Add (or replace) one screening answer — the write behind "answer it once".
 *
 * @param {string} root project root
 * @param {{id: string, patterns: string[], answer: string, type?: string}} entry
 * @param {{question?: string, replace?: boolean}} [options]
 *   `question` is the original form label, used for the truthfulness check.
 *   `replace` allows overwriting an entry with the same id.
 * @returns {{path: string, backup: string|null, id: string, replaced: boolean, count: number}}
 */
export function upsertScreeningAnswer(root, entry, { question, replace = false } = {}) {
  const requiresSponsorship = sponsorshipRequirement(root);
  const check = validateAnswerEntry(entry, { question, requiresSponsorship });
  if (!check.valid) throw new Error(check.error);

  const current = readScreeningAnswers(root);
  if (current.error && current.exists) throw new Error(current.error);

  const clean = {
    id: String(entry.id).trim(),
    patterns: entry.patterns.map((p) => String(p).trim()).filter(Boolean),
    answer: String(entry.answer),
    type: String(entry.type ?? 'text').trim() || 'text',
    // WHOSE ANSWER THIS IS.
    //
    // The screening-answers file is shared by every profile, and six of its
    // question ids are personal facts the active profile owns (years of
    // experience, salary, start date, work authorization, sponsorship,
    // relocation). `effectiveAnswers` withholds a stored answer for one of
    // those unless it was written under the profile that is active now —
    // otherwise switching candidate leaves the previous person's number on the
    // new person's application whenever the new profile cannot state its own.
    //
    // Stamping it here is what lets that rule distinguish "this user typed this
    // about themselves, under this profile" from "this is left over from
    // somebody else". An answer with no stamp predates profiles, so it is
    // treated as the second kind.
    ...(activeProfileId(root) ? { profileId: activeProfileId(root) } : {}),
  };
  const answers = [...current.answers];
  const index = answers.findIndex((a) => String(a?.id ?? '').toLowerCase() === clean.id.toLowerCase());
  if (index >= 0 && !replace) {
    throw new Error(`an answer with the id "${clean.id}" already exists, choose a different id, or edit that one.`);
  }
  if (index >= 0) answers[index] = clean; else answers.push(clean);

  const saved = writeScreeningAnswers(root, { defaults: current.defaults, answers }, { requiresSponsorship });
  return { ...saved, id: clean.id, replaced: index >= 0 };
}
