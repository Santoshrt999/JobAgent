// @ts-check
/**
 * Per-job cover-letter choice (P2, "Use template instead"). When grounded
 * letters are on (COVER_LETTER_MODE=grounded), a person can choose their own
 * template for one job. The choice is an append-only `cover_letter_mode`
 * event (the newest wins; no schema change) and takes effect the next time
 * the application is prepared.
 */
import { randomUUID } from 'node:crypto';

export const LETTER_MODE_EVENT = 'cover_letter_mode';
export const LETTER_MODES = Object.freeze(['template', 'default']);

/**
 * The job's choice: 'template' or 'default' (follow COVER_LETTER_MODE).
 * @param {any} db
 * @param {string} jobId
 * @returns {'template'|'default'}
 */
export function letterModeFor(db, jobId) {
  const rows = (db?.listEvents?.(jobId) ?? []).filter((/** @type {any} */ e) => e.event_type === LETTER_MODE_EVENT);
  const last = rows[rows.length - 1];
  if (!last) return 'default';
  try {
    return JSON.parse(last.metadata).mode === 'template' ? 'template' : 'default';
  } catch {
    return 'default';
  }
}

/**
 * Record the job's choice.
 * @param {any} db
 * @param {string} jobId
 * @param {string} mode
 */
export function setLetterMode(db, jobId, mode) {
  if (!LETTER_MODES.includes(mode)) {
    throw Object.assign(new Error(`mode must be ${LETTER_MODES.join(' or ')}`), { statusCode: 400 });
  }
  if (!db.getJob(jobId)) throw Object.assign(new Error(`unknown job id: ${jobId}`), { statusCode: 404 });
  db.insertEvent({
    id: randomUUID(), job_id: jobId, event_type: LETTER_MODE_EVENT,
    message: mode === 'template' ? 'cover letter: use my template for this job' : 'cover letter: back to the default',
    metadata: JSON.stringify({ mode }),
  });
  return { jobId, mode };
}
