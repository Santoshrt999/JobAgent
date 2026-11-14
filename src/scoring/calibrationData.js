/**
 * Samples for outcome calibration (P2-10): every submitted application with an
 * answer, re-scored with today's scoring config so the categories line up.
 *
 *   interviewed    a recorded outcome reached interviewing, offer or hired
 *   not            a recorded rejection or withdrawal without an interview, or
 *                  no reply at all GHOSTED_DAYS after applying
 *   (skipped)      submitted recently with no outcome yet: unknown
 */
import { OUTCOME_EVENT, replayOutcomes } from '../domain/applicationOutcome.js';
import { freshnessModelFor, scoreJob } from './scorer.js';
import { classifySponsorship } from './sponsorshipClassifier.js';

export const GHOSTED_DAYS = 30;
const POSITIVE = new Set(['interviewing', 'offer', 'hired']);

export function buildSamples(db, config, { now = new Date() } = {}) {
  const samples = [];
  for (const sub of db.listSubmittedJobs()) {
    const row = db.getJob(sub.id);
    if (!row) continue;
    const events = (db.listEvents(row.id) ?? []).filter((e) => e.event_type === OUTCOME_EVENT);
    const { reached, current } = replayOutcomes(events);
    let positive;
    if (POSITIVE.has(reached)) positive = true;
    else if (current) positive = false;
    else {
      const applied = Date.parse(row.applied_at ?? '');
      if (!Number.isFinite(applied) || (now - applied) / 86_400_000 < GHOSTED_DAYS) continue;
      positive = false;
    }
    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title, location: row.location, url: row.url,
      jdText: row.jd_text ?? '', postedAt: row.posted_at, applicantCount: row.applicant_count, employmentType: row.employment_type,
    };
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const score = scoreJob(job, { scoring: config.scoring, sponsorship, candidate: config.candidate, now, freshnessModel: freshnessModelFor(config) });
    samples.push({ jobId: row.id, positive, breakdown: score.breakdown });
  }
  return samples;
}
