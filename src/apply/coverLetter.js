/**
 * Cover letter generator (deterministic, template-based).
 *
 * Assembles a cover letter from config/cover_letter.json + the candidate profile
 * + the job, then runs the humanizer to strip banned phrases and em dashes.
 * No AI is called here; an optional `compose` function can be injected later for
 * an AI-backed variant, but the default is fully deterministic and testable.
 *
 * A letter is only produced when generation is warranted:
 *   - coverLetter.enabled is true, AND
 *   - the job is flagged `required`, OR the score meets minScoreToGenerate.
 *
 * Output never fabricates: every claim is drawn from candidate.json. Word count
 * is bounded by config (optional paragraphs are dropped to fit max).
 */

import { humanize, hasBannedContent } from './humanizer.js';
import { assertNoTemplateTokens } from '../config/placeholders.js';
import { composeFromMaster } from './letterTailor.js';
import { assessLetter } from './letterQuality.js';
import { displayCompany } from '../utils/companyName.js';

/**
 * @param {object} job normalized job (title, company, ...)
 * @param {object} scoreResult output of scoreJob (total, matchedKeywords)
 * @param {object} args
 * @param {object} args.coverLetter parsed config/cover_letter.json
 * @param {object} args.candidate parsed config/candidate.json
 * @param {object} args.humanizerPatterns parsed config/humanizer_patterns.json
 * @param {boolean} [args.required=false] employer requires a cover letter
 * @param {(ctx: object) => string} [args.compose] optional custom composer
 * @param {string} [args.masterLetter] the person's master cover letter text.
 *   When it has finished paragraphs it is the source of the letter (tailored
 *   by letterTailor.js); the template below is the fallback.
 * @returns {{ generated: boolean, reason: string, text: string|null, wordCount: number }}
 */
export function generateCoverLetter(job, scoreResult, {
  coverLetter, candidate, humanizerPatterns, required = false, compose, masterLetter,
} = {}) {
  if (!coverLetter?.enabled) {
    return skip('cover letters disabled in config');
  }
  const score = scoreResult?.total ?? 0;
  if (!required && score < coverLetter.minScoreToGenerate) {
    return skip(`score ${score} below minScoreToGenerate ${coverLetter.minScoreToGenerate} and not required`);
  }

  const ctx = buildContext(job, scoreResult, candidate, coverLetter);
  // The person's own master letter comes first; an injected composer (the
  // grounded LLM path) still wins over it, and the template is the fallback.
  const fromMaster = typeof compose !== 'function' && String(masterLetter ?? '').trim()
    ? composeFromMaster({ master: masterLetter, job, score: scoreResult, candidate, required })
    : null;
  let body = typeof compose === 'function' ? compose(ctx)
    : fromMaster?.ok ? fromMaster.body : composeDefault(ctx, coverLetter);

  // The employer's name and the role title are quoted, not written by us.
  body = humanize(body, humanizerPatterns, { protect: [ctx.company, ctx.title] });
  body = enforceWordCount(body, fromMaster?.ok ? fromMaster.limits : coverLetter.wordCount);

  // The greeting and sign-off are template text too ("Dear {company} team,"),
  // so they go through the same fill as the body instead of being pasted raw.
  // A master letter's own greeting and sign-off are the person's choice.
  const greeting = fromMaster?.ok && fromMaster.greeting ? fromMaster.greeting
    : coverLetter.greeting === undefined ? undefined : fill(coverLetter.greeting, ctx);
  const ownSignoff = fromMaster?.ok && countWords(fromMaster.signoff[0] ?? '') <= 4 ? fromMaster.signoff[0] : null;
  const closing = ownSignoff ?? (coverLetter.closing === undefined ? undefined : fill(coverLetter.closing, ctx));
  const text = [greeting, '', body, '', closing, candidate?.identity?.fullName]
    .filter((l) => l !== undefined)
    .join('\n');

  // LAST LINE OF DEFENCE. Whatever composed the body (the default template, an
  // injected composer, or a profile value that itself contains braces), a
  // letter that still reads "{title}" must never be written to disk as a
  // document addressed to an employer. Refusing is loud on purpose: a silent
  // skip would look like "cover letters disabled".
  assertNoTemplateTokens(text, 'cover letter');

  const wordCount = countWords(body);
  return {
    generated: true,
    reason: required ? 'required by employer' : `score ${score} >= ${coverLetter.minScoreToGenerate}`,
    text,
    wordCount,
    cleaned: !hasBannedContent(text, humanizerPatterns),
    // Where the words came from, for the review screen.
    source: typeof compose === 'function' ? 'composed' : fromMaster?.ok ? 'master' : 'template',
    ...(fromMaster ? {
      master: {
        used: fromMaster.ok, reason: fromMaster.reason ?? null, depth: fromMaster.depth,
        paragraphs: fromMaster.paragraphs.map((p) => p.source), skipped: fromMaster.skipped.length,
        warnings: fromMaster.warnings,
      },
    } : {}),
    quality: assessLetter(text, { company: ctx.company, title: ctx.title }),
  };
}

/** Acronyms that must never read as ordinary words in a letter. */
const ACRONYMS = new Set(['etl', 'elt', 'sql', 'bi', 'aws', 'gcp', 'api', 'apis', 'ci/cd', 'ml', 'ai', 'llm', 'kpi', 'sox', 'hipaa', 'gdpr', 'saas', 'erp', 'crm', 'ui', 'ux', 'qa', 'sre', 'olap', 'oltp', 'ssis', 'ssrs', 'dax', 'adf', 'rbac']);
/** Product names whose own casing is not "Title Case" (dbt is lower-case by design). */
const BRANDS = { dbt: 'dbt', pyspark: 'PySpark', 'power bi': 'Power BI', github: 'GitHub', devops: 'DevOps', mongodb: 'MongoDB', postgresql: 'PostgreSQL', mysql: 'MySQL', bigquery: 'BigQuery', javascript: 'JavaScript', typescript: 'TypeScript', dataops: 'DataOps', mlops: 'MLOps', onelake: 'OneLake' };
/** Words that name a JOB, not a skill ("data engineer" is not a strength). */
const ROLE_NOUN_RE = /\b(engineer|engineering|developer|analyst|architect|manager|specialist|consultant|scientist|administrator|lead|director)s?\b/i;

/**
 * Present JD-matched keywords the way the candidate writes them.
 *
 * The matcher works on lower-cased text, and the letter used to print its
 * tokens verbatim: "My core strengths align with your requirements: data
 * engineer, azure, azure data factory, databricks, etl" (2026-09-23, the first
 * real packet). A role title is not a strength, "azure" next to "azure data
 * factory" says the same thing twice, and a hiring manager reads lower-case
 * product names as carelessness. Each term now takes the spelling from the
 * candidate's own stack or resume skills, role nouns are dropped, a term
 * contained in a longer one already listed is dropped, and known acronyms are
 * upper-cased. Nothing is added that the matcher did not already match.
 */
export function presentableSkills(matched = [], candidate = {}) {
  const canonical = new Map();
  const stack = candidate?.technicalStack ?? {};
  const known = [
    ...Object.entries(stack).filter(([b]) => b !== 'growth').flatMap(([, t]) => (Array.isArray(t) ? t : [t])),
    ...(candidate?.skills ?? []),
  ];
  for (const t of known) if (typeof t === 'string' && t.trim()) canonical.set(t.trim().toLowerCase(), t.trim());
  const pretty = (raw) => {
    const key = String(raw).trim().toLowerCase();
    // Exact entry first; else the spelling inside the longer entry that
    // evidences it ("azure" -> "Azure" from "Azure Data Factory").
    if (canonical.has(key)) return canonical.get(key);
    if (BRANDS[key]) return BRANDS[key];
    if (ACRONYMS.has(key)) return key.toUpperCase();
    for (const [k, v] of canonical) {
      const at = k.search(new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`));
      if (at >= 0) { const start = k.indexOf(key, at); return v.slice(start, start + key.length); }
    }
    return key; // a generic concept ("streaming") stays lower-case mid-sentence
  };
  // EVIDENCED ONLY. `matchedKeywords` are scoring-category terms found in the
  // JOB AD — and categories can carry market terms the candidate never used.
  // On 2026-09-23 the letter said "My recent work also spans Airflow, dbt"
  // for a resume that mentions neither. A term survives only if the
  // candidate's own stack or resume skills contain it (exactly, or as a whole
  // word of a longer entry: "azure" is evidenced by "Azure Data Factory").
  const knownLower = [...canonical.keys()];
  const evidenced = (t) => canonical.has(t)
    || knownLower.some((k) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(k));
  const terms = [...new Set(matched.map((m) => String(m ?? '').trim().toLowerCase()).filter(Boolean))]
    .filter((t) => !ROLE_NOUN_RE.test(t) && evidenced(t));
  const kept = terms.filter((t) => !terms.some((o) => o !== t && o.length > t.length && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(o)));
  return kept.map(pretty);
}

/** "A", "A and B", "A, B and C". */
function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function buildContext(job, scoreResult, candidate, coverLetter) {
  const matched = presentableSkills(scoreResult?.matchedKeywords ?? [], candidate);
  const bulletCount = coverLetter.maxSkillBullets ?? 5;
  const skills = matched.slice(0, bulletCount);
  // NO UNGROUNDED CLAIMS, AND NO BORROWED PROFESSION.
  //
  // `topHighlight` used to fall back to the literal string 'delivered production
  // data pipelines'. With an empty workHistory[0].highlights the letter asserted
  // a specific accomplishment the candidate had never described — in a document
  // sent to an employer — and for anyone outside data engineering it asserted a
  // job they had never done. `headline` and `focusAreas` defaulted to
  // 'data engineer' the same way.
  //
  // A missing highlight is now null, and `composeDefault` omits that paragraph
  // rather than inventing one. This mirrors the rule the resume tailor enforces
  // with invariants: emit only what the profile evidences.
  const highlights = (candidate?.workHistory?.[0]?.highlights ?? [])
    .filter((h) => typeof h === 'string' && h.trim());
  const topHighlight = highlights.length
    ? lowerFirst(stripTrailingPeriod(highlights[0]))
    : null;
  const domains = (candidate?.domainExperience ?? []).slice(0, 3).join(', ') || null;
  // EVIDENCED SKILLS ONLY. `technicalStack.growth` is what the candidate wants
  // to LEARN, and flattening the whole stack put those terms into a sentence
  // introduced by "My core strengths align with your requirements" — a letter
  // sent to an employer claiming skills the person had explicitly marked as
  // ones they do not yet have.
  // Every bucket EXCEPT growth, rather than a fixed list of bucket names: a
  // legacy flat stack names its buckets freely (`cloud`, `languages`, …) and
  // an allow-list would silently drop all of them.
  const stack = candidate?.technicalStack ?? {};
  const evidencedTerms = Object.entries(stack)
    .filter(([bucket]) => bucket !== 'growth')
    .flatMap(([, terms]) => (Array.isArray(terms) ? terms : [terms]))
    .filter((t) => typeof t === 'string' && t.trim());
  // The bullets already list the strongest matches; repeating the same three
  // in the next paragraph read as filler. The focus line names what the
  // bullets did NOT, or is omitted.
  const beyond = matched.slice(bulletCount, bulletCount + 3);
  const focusAreas = skills.length
    ? (beyond.length ? joinList(beyond) : null)
    : (joinList(presentableSkills(evidencedTerms.slice(0, 3), candidate)) || null);
  // PERSONAL FACTS COME FROM THE PROFILE, NOT FROM THE TEMPLATE FILE.
  //
  // `cover_letter.json` is one shared file, and two of its values are facts
  // about a specific human: `yearsOfExperience` ("10+ years") and a
  // `sponsorshipNote` naming a specific visa ("...on an H-1B visa"). Switching
  // profiles left both in place, so a second candidate's letter — a document
  // sent to an employer — stated another person's experience and immigration
  // status. The template stays configurable; the facts it interpolates now
  // follow whoever is actually applying.
  // `=== true`, not truthiness: the requirement is tri-state and an UNSTATED
  // one must not produce a sentence about sponsorship in either direction.
  const requiresSponsorship = (candidate?.workAuthorization?.requiresSponsorship
    ?? candidate?.sponsorshipRequired) === true;
  const authStatus = String(candidate?.workAuthorization?.status ?? '').trim();
  return {
    title: job?.title ?? 'this role',
    // A board token ("shieldai") is never written into a letter as a name.
    company: job?.company ? displayCompany(job.company) : 'your company',
    headline: candidate?.identity?.headline
      ?? candidate?.targetTitles?.[0]
      ?? 'candidate',
    // NO BORROWED TENURE. The fallbacks here were `cover_letter.json`'s
    // `yearsOfExperience` — one person's number in a file everyone shares, so
    // a second candidate's letter opened by claiming the first one's career —
    // and failing that the literal string "several years", which is a claim
    // about a stranger's career made by a template. When the profile cannot
    // evidence a number, the sentence that needs one is dropped instead (see
    // `composeDefault`).
    years: candidateYears(candidate),
    skills,
    topHighlight,
    domains,
    focusAreas,
    authStatus: authStatus || 'authorized to work',
    includeSponsorshipNote: coverLetter.includeSponsorshipNote && requiresSponsorship,
    // A sentence generated from THIS candidate's stated status, used in place of
    // the configured one whenever the two would disagree about the visa.
    sponsorshipSentence: authStatus
      ? `I am currently ${authStatus} and am seeking an employer able to support continued sponsorship.`
      : null,
  };
}

function composeDefault(ctx, coverLetter) {
  const t = coverLetter.template;
  const paragraphs = [];

  // `fill` can return nothing at all when every sentence needed an unstated
  // fact, so each paragraph is pushed only when it still says something.
  const add = (text) => { if (text && text.trim()) paragraphs.push(text); };

  add(fill(t.opening, ctx));

  if (ctx.skills.length) {
    const bullets = ctx.skills.map((s) => `- ${s}`).join('\n');
    paragraphs.push(`${t.skillsLead}\n${bullets}`);
  }

  // Both of these are omitted rather than filled with a placeholder when the
  // profile does not evidence them. A shorter, true letter beats a complete,
  // invented one.
  if (ctx.topHighlight) add(fill(t.experience, ctx));
  if (ctx.focusAreas) add(fill(t.fitNote, ctx));

  if (ctx.includeSponsorshipNote) {
    // The configured sentence is used only when it does not name a DIFFERENT
    // status than this candidate's. A template saying "on an H-1B visa" is
    // correct for the person who wrote it and false for the next one.
    add(
      ctx.sponsorshipSentence && namesAnotherStatus(t.sponsorshipNote, ctx.authStatus)
        ? ctx.sponsorshipSentence
        : fill(t.sponsorshipNote, ctx),
    );
  }

  add(fill(t.closingParagraph, ctx));
  return paragraphs.join('\n\n');
}

/**
 * Years of professional experience this candidate can actually evidence.
 *
 * Read from the profile's background (via the generated candidate config) so it
 * follows whoever is applying. Returns null when unknown, and the caller falls
 * back to the configured value rather than inventing a number.
 */
function candidateYears(candidate) {
  const years = candidate?.background?.yearsExperience ?? candidate?.yearsExperience;
  return Number.isFinite(Number(years)) && Number(years) > 0 ? `${Number(years)}+ years` : null;
}

/** Visa and status words a template might name explicitly. */
const STATUS_WORDS = /\b(h-?1-?b|h-?4|l-?1|o-?1|tn|e-?3|f-?1|opt|cpt|j-?1|green\s+card|permanent\s+resident|us\s+citizen|citizen)\b/i;

/**
 * Does the configured sentence name a work-authorization status OTHER than this
 * candidate's? If so it cannot be used for them.
 */
function namesAnotherStatus(template, authStatus) {
  const named = String(template ?? '').match(STATUS_WORDS);
  if (!named) return false;
  return !new RegExp(named[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(String(authStatus ?? ''));
}

/** Drop optional trailing paragraphs (then sentences) to satisfy max words. */
function enforceWordCount(body, wordCount = {}) {
  const max = wordCount.max ?? Infinity;
  if (countWords(body) <= max) return body;

  // Remove middle paragraphs first, always preserving the opening (intro) and
  // the final two (sponsorship note + closing) so required statements survive.
  const paras = body.split('\n\n');
  while (paras.length > 3 && countWords(paras.join('\n\n')) > max) {
    paras.splice(2, 1);
  }
  let trimmed = paras.join('\n\n');

  // If still over, trim sentences from the body (excluding closing).
  if (countWords(trimmed) > max) {
    const sentences = trimmed.split(/(?<=[.])\s+/);
    while (sentences.length > 1 && countWords(sentences.join(' ')) > max) {
      sentences.splice(sentences.length - 2, 1);
    }
    trimmed = sentences.join(' ');
  }
  return trimmed;
}

/**
 * Fill a template, DROPPING any sentence whose facts the profile cannot supply.
 *
 * A missing value used to interpolate as an empty string, which is how the
 * opening read "As a Data Engineer with  of experience" — and, worse, why the
 * generator reached for a shared template number and then the phrase "several
 * years" to avoid that gap. Both were claims about a career nobody had
 * described.
 *
 * Removing the sentence keeps the letter grammatical and keeps every remaining
 * claim grounded, which is the same rule the resume tailor enforces with
 * invariants: emit only what the profile evidences. A `null` context value
 * means "not stated"; an empty string is still a deliberate value and fills.
 *
 * @param {string} template
 * @param {object} ctx
 * @returns {string} the filled text, possibly shorter, possibly empty
 */
function fill(template, ctx) {
  const TOKEN = /\{(\w+)\}/g;
  const unresolved = (text) => {
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(text)) !== null) {
      const value = ctx[m[1]];
      if (value === undefined || value === null) return true;
    }
    return false;
  };
  const substitute = (text) => text.replace(TOKEN, (_, key) => String(ctx[key] ?? ''));

  const source = String(template ?? '');
  if (!unresolved(source)) return substitute(source);

  // Split on sentence ends, keeping the terminator with its sentence.
  const sentences = source.match(/[^.!?]+[.!?]*\s*/g) ?? [source];
  const kept = sentences.filter((s) => s.trim() && !unresolved(s));
  // The KEPT sentences still carry their tokens and must be substituted too.
  // They used to be returned raw, so a profile with no stated tenure dropped
  // the "{years} of experience" sentence and shipped its neighbour verbatim:
  // "I am applying for the {title} role at {company}." — measured, in a letter
  // written to disk for a real employer.
  return substitute(kept.join('')).replace(/\s+/g, ' ').trim();
}

function countWords(s) {
  return (s.match(/\b[\w'-]+\b/g) ?? []).length;
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function stripTrailingPeriod(s) {
  return s.replace(/\.\s*$/, '');
}

function skip(reason) {
  return { generated: false, reason, text: null, wordCount: 0, cleaned: true };
}
