/**
 * Field rules for the profile dialogs.
 *
 * Pure functions: text in, a message out ('' when the value is fine). Each
 * message says what to DO, not only that something is wrong. The limits are the
 * ones the server enforces (src/profile/store.js, src/config/screeningAnswerRules.js),
 * so a person hears about a problem before a save is refused rather than after.
 * The server stays the authority; this is the earlier, friendlier copy.
 */

export const MAX_ROLES = 15;
export const MAX_ROLE_CHARS = 80;
export const MAX_ANSWER_CHARS = 2000;

const text = (value) => String(value ?? '');

export function validateRequired(label, value) {
  return text(value).trim() ? '' : `${label} is required.`;
}

export function validateFullName(value) {
  return text(value).trim().split(/\s+/).filter(Boolean).length >= 2 ? '' : 'Enter a first and last name.';
}

export function validateEmail(value) {
  const email = text(value).trim();
  if (!email) return 'Enter your email address.';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Enter a valid email address, like name@example.com.';
}

export function validatePhone(value) {
  const raw = text(value).trim();
  if (!raw) return 'Enter your phone number.';
  return raw.replace(/\D/g, '').length >= 7 ? '' : 'Enter a phone number with at least 7 digits.';
}

/** @param {string[]} roles */
export function validateRoles(roles) {
  if (!roles.length) return 'Add at least one job title to search for.';
  if (roles.length > MAX_ROLES) return `Keep it to ${MAX_ROLES} job titles or fewer.`;
  if (roles.some((r) => r.length > MAX_ROLE_CHARS)) return `Keep each job title under ${MAX_ROLE_CHARS} characters.`;
  return '';
}

/**
 * "8", "8+", "10+ years", "7.5", "12 yrs": a number from 0 to 50, optionally
 * followed by "+" and "years". Forms that ask for years take a number, so a
 * sentence here would be typed into a numeric box and rejected there.
 */
export function validateYears(value) {
  const message = 'Years of experience must be a number between 0 and 50, like 8 or 8+.';
  const match = /^(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)?\.?$/i.exec(text(value).trim());
  if (!match) return message;
  const years = Number(match[1]);
  return years >= 0 && years <= 50 ? '' : message;
}

export function validateAnswerText(value) {
  const answer = text(value);
  if (!answer.trim()) return 'Type an answer, or delete this one.';
  if (answer.length > MAX_ANSWER_CHARS) return `That answer is ${answer.length} characters; the limit is ${MAX_ANSWER_CHARS}.`;
  return '';
}

/** @param {string[]} patterns the phrases that identify a question on a form */
export function validatePatterns(patterns) {
  const list = patterns.map((p) => text(p).trim()).filter(Boolean);
  if (!list.length) return 'Add at least one phrase that identifies the question.';
  // The matcher wraps a phrase in word boundaries, so one ending in "?" or ":" can never match.
  const bad = list.find((p) => !/[a-z0-9]$/i.test(p));
  return bad ? `"${bad}" ends in punctuation, so it would never match. Remove the last character.` : '';
}

/**
 * The server reports a refused answer as `answer "<id>": <why>`. Pulling the id
 * out lets the message appear on that answer instead of only in the footer.
 *
 * @returns {{ id: string, text: string }|null}
 */
export function parseAnswerError(message) {
  const match = /^answer "([^"]+)":\s*([\s\S]+)$/.exec(text(message));
  return match ? { id: match[1], text: match[2].trim() } : null;
}
