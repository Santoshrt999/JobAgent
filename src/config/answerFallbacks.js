/**
 * Fill personal facts the dashboard cannot edit from the answers it can.
 *
 * WHY. The same facts lived in two places. A person answers "work_authorization",
 * "years_experience" and "require_sponsorship" under Application profile → Saved
 * answers, which the dashboard edits. Prepare's placeholder guard checked a
 * SECOND copy — the profile's work authorization and cover_letter.json — which
 * no screen edits at all. Measured 2026-11-12: all three answers were real, the
 * second copy was still the shipped template, and Prepare refused every job;
 * the only way through was hand-editing JSON.
 *
 * WHAT. In memory, at load time, a value that is still template text (or
 * blank) takes the person's own answer for the same fact. Nothing is written to
 * disk, a real value is never replaced, and nothing is invented: every value
 * comes from text the person typed, their resume, or a sentence the cover letter
 * already builds from their own status. A fact with no answer stays template
 * text, so the guard still refuses — and names the answer to give.
 */
import { isPlaceholderValue } from './placeholders.js';

/** Blank, template text, or the profile's stand-in for an unstated status. */
function unstated(value) {
  if (value == null) return true;
  const text = String(value).trim();
  return !text || text === 'Unspecified' || isPlaceholderValue(text);
}

/** The person's own answer for `id`, or null when missing, blank or template text. */
export function answerFor(screeningAnswers, id) {
  // An answer stamped as ANOTHER person's is theirs, never this person's fact
  // (audit 2026-11-13, BUG-01). Unstamped answers predate profiles and stay usable.
  const active = String(screeningAnswers?.profileId ?? '');
  const entry = (screeningAnswers?.answers ?? []).find((a) => a?.id === id
    && !(active && a?.profileId && String(a.profileId) !== active));
  const text = String(entry?.answer ?? '').trim();
  return text && !isPlaceholderValue(text) ? text : null;
}

/**
 * The cover letter's sponsorship sentence, written from the person's own status.
 *
 * The answer is free text, and this sentence goes to an employer, so it has to
 * read right either way. "I am currently {status}", the letter's own fallback,
 * read "I am currently H-1B visa" for a short answer. A full sentence ("Authorized
 * to work in the United States on an H-1B visa.") is the person's own words and
 * is kept whole; a short label is introduced as one.
 */
export function sponsorshipSentenceFor(status) {
  const text = String(status ?? '').trim();
  const tail = 'I am seeking an employer able to support continued sponsorship.';
  if (/[.!]$/.test(text) && text.split(/\s+/).length >= 4) return `${text} ${tail}`;
  return `My current work authorization is ${text.replace(/[\s.;,]+$/, '')}, and ${tail}`;
}

/**
 * @param {{candidate?: object, coverLetter?: object, screeningAnswers?: object, profile?: object}} bundle
 * @returns {{candidate?: object, coverLetter?: object, filled: Array<{path: string, from: string}>}}
 *   copies of `candidate` and `coverLetter` with fallbacks applied, and what was filled from where
 */
export function applyAnswerFallbacks(bundle = {}) {
  const filled = [];
  const answers = bundle.screeningAnswers;
  let candidate = bundle.candidate;
  let coverLetter = bundle.coverLetter;

  // Work authorization: the "work_authorization" answer IS the status ("your
  // truthful authorization status" is what the shipped answer asks for).
  const status = answerFor(answers, 'work_authorization');
  if (candidate && status) {
    const auth = { ...(candidate.workAuthorization ?? {}) };
    for (const key of ['status', 'details']) {
      if (unstated(auth[key])) {
        auth[key] = status;
        filled.push({ path: `candidate.workAuthorization.${key}`, from: 'answer "work_authorization"' });
      }
    }
    candidate = { ...candidate, workAuthorization: auth };
  }

  if (coverLetter && !coverLetter._missing) {
    // Years: the cover letter itself reads years from the profile, so this
    // value only has to stop being template text. The person's answer first,
    // then what their resume states.
    if (unstated(coverLetter.yearsOfExperience)) {
      const answered = answerFor(answers, 'years_experience');
      const fromResume = Number(bundle.profile?.background?.yearsExperience);
      const years = answered ?? (Number.isFinite(fromResume) && fromResume > 0 ? `${fromResume} years` : null);
      if (years) {
        coverLetter = { ...coverLetter, yearsOfExperience: years };
        filled.push({
          path: 'coverLetter.yearsOfExperience',
          from: answered ? 'answer "years_experience"' : 'the years your resume states',
        });
      }
    }

    // Sponsorship sentence. The letter only ever includes it when the person
    // REQUIRES sponsorship (`=== true`, as in coverLetter.js); otherwise it is
    // never sent, so template text in it reaches no one and must not block.
    const note = coverLetter.template?.sponsorshipNote;
    if (coverLetter.includeSponsorshipNote !== false && unstated(note)) {
      const requires = (candidate?.workAuthorization?.requiresSponsorship ?? candidate?.sponsorshipRequired) === true;
      const knownStatus = unstated(candidate?.workAuthorization?.status) ? null : String(candidate.workAuthorization.status).trim();
      if (!requires) {
        coverLetter = { ...coverLetter, includeSponsorshipNote: false };
        filled.push({ path: 'coverLetter.includeSponsorshipNote', from: 'your profile does not require sponsorship' });
      } else if (knownStatus) {
        coverLetter = {
          ...coverLetter,
          template: { ...coverLetter.template, sponsorshipNote: sponsorshipSentenceFor(knownStatus) },
        };
        filled.push({ path: 'coverLetter.template.sponsorshipNote', from: 'your work authorization status' });
      }
    }
  }

  return { candidate, coverLetter, filled };
}
