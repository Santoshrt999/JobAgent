/**
 * Rewrite suggestions in a job's detail (P1-2): the original bullet and the
 * suggested one as a word-level diff, the resume text that backs it, and
 * Accept / Reject. Suggestions the claim checker refused show why and cannot
 * be accepted. Nothing reaches the resume until it is accepted, and the
 * resume changes only when the application is prepared again.
 */
import { $, el, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { railSection } from './detail.js';

const inflight = new Set();

/**
 * Word-level diff of two texts (longest common subsequence). Pure.
 * @returns {Array<{ type: 'same'|'del'|'ins', text: string }>}
 */
export function wordDiff(before, after) {
  const a = String(before ?? '').split(/(\s+)/).filter((x) => x !== '');
  const b = String(after ?? '').split(/(\s+)/).filter((x) => x !== '');
  const n = a.length; const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', a[i]); i += 1; }
    else { push('ins', b[j]); j += 1; }
  }
  while (i < n) { push('del', a[i]); i += 1; }
  while (j < m) { push('ins', b[j]); j += 1; }
  return out;
}

function diffNode(before, after) {
  const node = el('p', { class: 'rw-diff' });
  for (const part of wordDiff(before, after)) {
    if (part.type === 'same') node.append(part.text);
    else if (part.type === 'del') node.append(el('del', { text: part.text }));
    else node.append(el('ins', { text: part.text }));
  }
  return node;
}

const DECISION_TEXT = {
  accept: 'Accepted. Used the next time this application is prepared.',
  reject: 'Rejected. The original bullet stays.',
};

function itemNode(jobId, item) {
  const node = el('li', { class: `rw-item ${item.status}`, 'data-unit': item.unitId });
  if (item.role) node.append(el('div', { class: 'faint rw-role', text: item.role }));
  node.append(diffNode(item.original, item.rewrite));
  if (item.status === 'verified') {
    const backing = el('div', { class: 'rw-evidence' }, el('span', { class: 'faint', text: 'Backed by your resume: ' }));
    for (const ev of item.evidenceText ?? []) {
      backing.append(el('span', { class: 'chip', title: ev.text, text: ev.text.length > 48 ? `${ev.text.slice(0, 47)}…` : ev.text }));
    }
    node.append(backing);
    const row = el('div', { class: 'row-gap rw-actions' });
    row.append(
      el('button', {
        type: 'button', class: 'small', 'data-action': 'rewrite-accept', 'data-id': jobId, 'data-unit': item.unitId,
        'aria-pressed': String(item.decision === 'accept'), text: 'Accept',
      }),
      el('button', {
        type: 'button', class: 'small ghost', 'data-action': 'rewrite-reject', 'data-id': jobId, 'data-unit': item.unitId,
        'aria-pressed': String(item.decision === 'reject'), text: 'Reject',
      }),
    );
    node.append(row);
    if (item.decision) node.append(el('p', { class: `rw-decision ${item.decision}`, text: DECISION_TEXT[item.decision] }));
  } else {
    node.append(el('p', { class: 'rw-refused', text: `Not used: ${item.reasons.join('; ')}.` }));
  }
  return node;
}

/** Fill the section body from GET /api/jobs/:id/rewrites. */
export function fillRewrites(body, jobId, info) {
  body.textContent = '';
  const record = info?.record;
  if (!record) {
    body.append(el('p', { class: 'muted', text: 'Suggest rewordings of your bullets that bring out what this job asks for. '
      + 'Every suggestion is checked against your own resume; anything it cannot back is not offered.' }));
    body.append(el('button', { type: 'button', class: 'small', 'data-action': 'propose-rewrites', 'data-id': jobId, text: 'Suggest rewrites' }));
    body.append(refineForm(jobId, info?.declined ?? null));
    return;
  }
  const verified = record.items.filter((i) => i.status === 'verified');
  const accepted = record.items.filter((i) => i.decision === 'accept').length;
  body.append(el('p', { id: 'rwSummary', role: 'status', text: record.items.length
    ? `${record.items.length} suggestion(s), ${verified.length} backed by your resume, ${accepted} accepted.`
    : 'No safe rewordings were found for this job. Your bullets stay as they are.' }));
  const row = el('div', { class: 'row-gap' });
  if (verified.length) {
    row.append(el('button', { type: 'button', class: 'small', 'data-action': 'rewrite-accept-all', 'data-id': jobId, text: 'Accept all backed suggestions' }));
  }
  row.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'propose-rewrites', 'data-id': jobId, text: 'Suggest again' }));
  body.append(row);
  body.append(refineForm(jobId, info?.declined ?? null));
  const list = el('ul', { class: 'rw-list' });
  for (const item of record.items) list.append(itemNode(jobId, item));
  body.append(list);
}

/** "Ask for a change" (P2-2): a plain-language request, checked the same way. */
function refineForm(jobId, declined) {
  const wrap = el('div', { class: 'rw-refine' });
  const id = `rwAsk-${jobId}`;
  wrap.append(el('label', { for: id, class: 'faint', text: 'Ask for a specific change' }));
  const row = el('div', { class: 'row-gap' });
  row.append(
    el('input', { id, type: 'text', class: 'rw-ask', maxlength: '600', placeholder: 'For example: lead the Power BI bullet with its outcome' }),
    el('button', { type: 'button', class: 'small', 'data-action': 'refine-rewrites', 'data-id': jobId, text: 'Ask' }),
  );
  wrap.append(row);
  if (declined) wrap.append(el('p', { class: 'rw-declined', role: 'status', text: `Not changed: ${declined}` }));
  return wrap;
}

async function loadRewrites(jobId) {
  if (inflight.has(jobId)) return;
  inflight.add(jobId);
  try {
    const info = await api(`/api/jobs/${encodeURIComponent(jobId)}/rewrites`);
    state.rewrites.set(jobId, info);
    if (info.enabled === false && !info.record) state.rewritesEnabled = false;
    const body = $('rwBody');
    if (body?.dataset.id === jobId) {
      if (state.rewritesEnabled === false && !info.record) body.closest('.rail-sec')?.remove();
      else fillRewrites(body, jobId, info);
    }
  } catch {
    $('rwBody')?.closest('.rail-sec')?.remove();
  } finally {
    inflight.delete(jobId);
  }
}

/** The detail section; null when rewriting is off and nothing was ever suggested. */
export function rewritesSection(job) {
  const cached = state.rewrites.get(job.id);
  if (state.rewritesEnabled === false && !cached?.record) return null;
  const body = el('div', { class: 'rw', id: 'rwBody', 'data-id': job.id, 'aria-live': 'polite' });
  if (cached) fillRewrites(body, job.id, cached);
  else {
    body.append(el('p', { class: 'muted', text: 'Checking for rewrite suggestions…' }));
    queueMicrotask(() => loadRewrites(job.id));
  }
  return railSection('rewrites', el('h3', { text: 'Rewrite suggestions' }), body);
}

function refresh(jobId, info) {
  state.rewrites.set(jobId, info);
  const body = $('rwBody');
  if (body?.dataset.id === jobId) fillRewrites(body, jobId, info);
}

export async function proposeRewrites(target) {
  const jobId = target.dataset.id;
  const body = $('rwBody');
  if (body) body.querySelector('#rwSummary, p')?.replaceWith(el('p', { class: 'muted', text: 'Asking for suggestions and checking each against your resume…' }));
  try {
    const { record } = await postJson(`/api/jobs/${encodeURIComponent(jobId)}/rewrites`);
    refresh(jobId, { enabled: true, record });
  } catch (err) {
    toast(err.message, 'bad');
    const info = state.rewrites.get(jobId) ?? { enabled: true, record: null };
    refresh(jobId, info);
  }
}

async function decide(target, payload) {
  const jobId = target.dataset.id;
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(jobId)}/rewrite-decision`, payload);
    refresh(jobId, { enabled: true, record: result.record });
    if (result.needsReapproval) {
      toast('The resume for this job changed, so its packet is back in review. Prepare it again to rebuild the resume.');
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export async function refineRewrites(target) {
  const jobId = target.dataset.id;
  const input = target.closest('.rw-refine')?.querySelector('.rw-ask');
  const instruction = input?.value.trim();
  if (!instruction) { toast('Say what you would like changed first.', 'bad'); return; }
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(jobId)}/refine`, { instruction });
    refresh(jobId, { enabled: true, record: result.record, declined: result.declined });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export const rewriteActions = {
  'refine-rewrites': (target) => refineRewrites(target),
  'propose-rewrites': (target) => proposeRewrites(target),
  'rewrite-accept': (target) => decide(target, {
    unitId: target.dataset.unit, decision: target.getAttribute('aria-pressed') === 'true' ? null : 'accept',
  }),
  'rewrite-reject': (target) => decide(target, {
    unitId: target.dataset.unit, decision: target.getAttribute('aria-pressed') === 'true' ? null : 'reject',
  }),
  'rewrite-accept-all': (target) => decide(target, { acceptAllVerified: true }),
};
