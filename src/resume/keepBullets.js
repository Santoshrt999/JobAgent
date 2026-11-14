// @ts-check
/**
 * Bullets a person chose to keep in one job's tailored resume.
 *
 * When the tailor has to shorten a resume to its page budget it omits whole
 * bullets. The comparison view lists every omission, and "Keep it" pins that
 * bullet for this job: the next tailoring run never omits it. Like the
 * cover-letter choice (letterMode.js), the choice is an append-only event, the
 * newest wins, and no schema change is needed.
 */
import { randomUUID } from 'node:crypto';

export const KEEP_BULLETS_EVENT = 'resume_keep_bullets';
const MAX_BULLETS = 60;
const MAX_CHARS = 1200;

/**
 * The bullets pinned for this job, newest choice wins.
 * @param {any} db
 * @param {string} jobId
 * @returns {string[]}
 */
export function keptBulletsFor(db, jobId) {
  const rows = (db?.listEvents?.(jobId) ?? []).filter((/** @type {any} */ e) => e.event_type === KEEP_BULLETS_EVENT);
  const last = rows[rows.length - 1];
  if (!last) return [];
  try {
    const bullets = JSON.parse(last.metadata).bullets;
    return Array.isArray(bullets) ? bullets.filter((b) => typeof b === 'string' && b.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * Replace the pinned set for this job.
 * @param {any} db
 * @param {string} jobId
 * @param {unknown} bullets
 * @returns {{ jobId: string, bullets: string[] }}
 */
export function setKeptBullets(db, jobId, bullets) {
  if (!Array.isArray(bullets)) {
    throw Object.assign(new Error('bullets must be a list of resume lines'), { statusCode: 400 });
  }
  if (!db.getJob(jobId)) throw Object.assign(new Error(`unknown job id: ${jobId}`), { statusCode: 404 });
  const clean = [...new Set(bullets
    .filter((b) => typeof b === 'string')
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b && b.length <= MAX_CHARS))].slice(0, MAX_BULLETS);
  db.insertEvent({
    id: randomUUID(), job_id: jobId, event_type: KEEP_BULLETS_EVENT,
    message: clean.length ? `resume: keep ${clean.length} bullet(s) when fitting the page` : 'resume: no pinned bullets',
    metadata: JSON.stringify({ bullets: clean }),
  });
  return { jobId, bullets: clean };
}
