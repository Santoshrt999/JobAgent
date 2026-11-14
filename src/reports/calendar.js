// @ts-check
/**
 * Follow-up reminders as an iCalendar file (P2-5), for any calendar app:
 * one all-day event per application with an open follow-up. Interviews are
 * not exported: JobAgent records the day an outcome was entered, not when an
 * interview is, and a wrong time on a calendar is worse than none.
 *
 * RFC 5545: CRLF line ends, text escaped, lines folded at 75 octets, and a
 * UID that is the same on every export, so re-importing updates instead of
 * duplicating.
 */
import { FOLLOWUP_EVENT, replayFollowUps } from '../domain/applicationOutcome.js';

const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold one content line at 75 octets (continuation lines start with a space). */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return out.join('\r\n ');
}

const dayStamp = (iso) => iso.replace(/-/g, '');
const nextDay = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};
const utcStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * @param {Array<{ jobId: string, company: string, title: string, url?: string, dueOn: string, note?: string|null }>} reminders
 */
export function buildIcs(reminders, { now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JobAgent//Follow-ups//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:JobAgent follow-ups',
  ];
  for (const r of reminders) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.jobId.replace(/[^A-Za-z0-9._-]/g, '_')}-followup@jobagent.local`,
      `DTSTAMP:${utcStamp(now)}`,
      `DTSTART;VALUE=DATE:${dayStamp(r.dueOn)}`,
      `DTEND;VALUE=DATE:${nextDay(r.dueOn)}`,
      `SUMMARY:${escapeText(`Follow up: ${r.company || 'application'}${r.title ? ` — ${r.title}` : ''}`)}`,
      ...(r.note || r.url ? [`DESCRIPTION:${escapeText([r.note, r.url].filter(Boolean).join('\n'))}`] : []),
      ...(r.url ? [`URL:${r.url}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Every open follow-up in a job store. */
export function openFollowUps(db) {
  const events = (db.listEvents?.() ?? []).filter((e) => e.event_type === FOLLOWUP_EVENT);
  const byJob = new Map();
  for (const e of events) {
    if (!byJob.has(e.job_id)) byJob.set(e.job_id, []);
    byJob.get(e.job_id).push(e);
  }
  const out = [];
  for (const [jobId, list] of byJob) {
    const { open } = replayFollowUps(list);
    if (!open) continue;
    const job = db.getJob?.(jobId) ?? {};
    out.push({ jobId, company: job.company ?? '', title: job.title ?? '', url: job.url ?? null, dueOn: open.dueOn, note: open.note });
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}
