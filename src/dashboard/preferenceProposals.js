/**
 * Patterns in what the person turns down, as proposals (audit Backlog #8).
 *
 * The reason given when rejecting or archiving a job was recorded and then
 * never used. Counted, it says things worth acting on: "four jobs from this
 * staffing agency rejected", "six rejected over pay". Each proposal names the
 * evidence and offers an EXISTING, undoable action or the setting that fixes
 * the cause. Nothing is ever changed automatically, and no weight drifts in
 * the background: scoring stays deterministic and visible.
 */

/** Rejections from one employer before proposing to clear out the rest. */
export const COMPANY_MIN = 3;
/** Rejections for one reason before pointing at its setting. */
export const REASON_MIN = 4;
/** Only recent decisions describe current preferences. */
export const WINDOW_DAYS = 60;

const REASON_FIX = {
  salary: { message: 'over pay', action: 'open-edit-profile', label: 'Set your pay floor', why: 'Postings that state pay below your floor then score lower.' },
  location: { message: 'over location', action: 'open-edit-profile', label: 'Review where you will work', why: 'Your locations and remote preference decide the geography score.' },
  seniority: { message: 'over seniority', action: 'open-edit-profile', label: 'Review your level', why: 'Your stated level decides which titles count as a step up or down.' },
  stack: { message: 'over the tech stack', action: 'open-master', label: 'Check your skills', why: 'Skills scored as core come from your profile and master resume.' },
  sponsorship: { message: 'over sponsorship', action: 'open-edit-profile', label: 'Check your work authorization', why: 'It decides whether sponsorship questions count against a posting.' },
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @param {Array<{id: string, company?: string, user_decision?: string, decision_reason?: string,
 *   decided_at?: string, status?: string}>} rows jobs-table rows
 * @param {{now?: Date}} [opts]
 * @returns {Array<{kind: 'company'|'reason', key: string, count: number, message: string,
 *   action: string, label: string, why?: string, ids?: string[]}>}
 */
export function preferenceProposals(rows = [], { now = new Date() } = {}) {
  const since = now.getTime() - WINDOW_DAYS * 86_400_000;
  const rejectedByCompany = new Map();
  const byReason = new Map();
  const openByCompany = new Map();
  for (const r of rows) {
    const company = norm(r.company);
    const decision = r.user_decision;
    if (!decision && company && !['discarded', 'submitted', 'submit_unverified'].includes(r.status)) {
      if (!openByCompany.has(company)) openByCompany.set(company, []);
      openByCompany.get(company).push(r.id);
    }
    if (decision !== 'rejected' && decision !== 'archived') continue;
    const at = Date.parse(r.decided_at ?? '');
    if (Number.isFinite(at) && at < since) continue;
    if (decision === 'rejected' && company) {
      const c = rejectedByCompany.get(company) ?? { name: String(r.company).trim(), count: 0 };
      c.count += 1;
      rejectedByCompany.set(company, c);
    }
    const reason = norm(r.decision_reason);
    if (REASON_FIX[reason]) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const out = [];
  for (const [company, c] of rejectedByCompany) {
    const open = openByCompany.get(company) ?? [];
    if (c.count < COMPANY_MIN || !open.length) continue;
    out.push({
      kind: 'company', key: company, count: c.count, ids: open,
      message: `You rejected ${c.count} jobs from ${c.name}. ${open.length} more of its jobs are still open.`,
      action: 'proposal-archive', label: `Archive ${c.name}'s ${open.length} open job${open.length === 1 ? '' : 's'}`,
    });
  }
  for (const [reason, count] of byReason) {
    if (count < REASON_MIN) continue;
    const fix = REASON_FIX[reason];
    out.push({ kind: 'reason', key: reason, count, message: `You turned down ${count} jobs ${fix.message} recently.`, action: fix.action, label: fix.label, why: fix.why });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 3);
}
