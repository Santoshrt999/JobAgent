/**
 * Desktop alerts for follow-ups that are due (P3-3). Opt-in:
 * FOLLOWUP_NOTIFY=on. The dashboard checks hourly and alerts once per
 * follow-up per day, remembered in data/followup-alerts.json so a restart does
 * not repeat it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';

/** Which reminders to alert today: due today or earlier, not yet alerted today. Pure. */
export function dueAlerts(reminders, alerted = {}, today) {
  return reminders.filter((r) => r.dueOn <= today && alerted[r.jobId] !== today);
}

const stateFile = (root) => join(root, 'data', 'followup-alerts.json');

export function readAlerted(root) {
  try { return JSON.parse(readFileSync(stateFile(root), 'utf8')); } catch { return {}; }
}

export async function alertDueFollowUps({ root, reminders, today, notifier }) {
  const alerted = readAlerted(root);
  const due = dueAlerts(reminders, alerted, today);
  for (const r of due) {
    await notifier.actionRequired('Follow-up due', `${r.company || 'An application'}${r.title ? ` — ${r.title}` : ''}${r.note ? `: ${r.note}` : ''}`);
    alerted[r.jobId] = today;
  }
  if (due.length) writeFileAtomic(stateFile(root), `${JSON.stringify(alerted, null, 2)}\n`, 'utf8');
  return due.length;
}
