/**
 * Document versions in a job's detail (P2-2): every prepared version of the
 * application's resume and letter, a word-level comparison of any two, and
 * Restore. Submitted applications are frozen and say so.
 */
import { $, el, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { railSection } from './detail.js';
import { wordDiff } from './rewrites.js';

const CAUSE = { generated: 'Prepared', restored: 'Restored', edited: 'Edited by you' };

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fillVersions(body, jobId, info) {
  body.textContent = '';
  const versions = info?.versions ?? [];
  if (!versions.length) { body.closest('.rail-sec')?.remove(); return; }
  if (info.frozenAt) body.append(el('p', { class: 'muted', text: `Frozen as sent on ${when(info.frozenAt)}: these documents can no longer be replaced.` }));
  const list = el('ol', { class: 'ver-list', reversed: true });
  for (const v of [...versions].reverse()) {
    const item = el('li', { 'data-n': String(v.n) });
    item.append(el('span', { text: `v${v.n} · ${CAUSE[v.cause] ?? v.cause} · ${when(v.at)}` }));
    if (!info.frozenAt && v.n !== versions[versions.length - 1].n) {
      item.append(' ', el('button', { type: 'button', class: 'small ghost', 'data-action': 'restore-version', 'data-id': jobId, 'data-n': String(v.n), text: `Restore v${v.n}` }));
    }
    list.append(item);
  }
  body.append(list);
  if (versions.length > 1) {
    const pick = (id, selected) => {
      const sel = el('select', { id, class: 'small' });
      for (const v of versions) sel.append(el('option', { value: String(v.n), text: `v${v.n}`, selected: v.n === selected }));
      return sel;
    };
    const row = el('div', { class: 'row-gap' });
    row.append(
      el('label', { for: `verA-${jobId}`, class: 'faint', text: 'Compare' }), pick(`verA-${jobId}`, versions[versions.length - 2].n),
      el('label', { for: `verB-${jobId}`, class: 'faint', text: 'with' }), pick(`verB-${jobId}`, versions[versions.length - 1].n),
      el('button', { type: 'button', class: 'small', 'data-action': 'compare-versions', 'data-id': jobId, text: 'Compare' }),
    );
    body.append(row, el('div', { class: 'ver-diff', id: 'verDiff', 'aria-live': 'polite' }));
  }
}

async function loadVersions(jobId) {
  try {
    const info = await api(`/api/jobs/${encodeURIComponent(jobId)}/versions`);
    state.versions.set(jobId, info);
    const body = $('verBody');
    if (body?.dataset.id === jobId) fillVersions(body, jobId, info);
  } catch {
    $('verBody')?.closest('.rail-sec')?.remove();
  }
}

/** The detail section, shown once a job has prepared documents. */
export function versionsSection(job) {
  if (!job.packet) return null;
  const body = el('div', { class: 'ver', id: 'verBody', 'data-id': job.id });
  const cached = state.versions.get(job.id);
  if (cached) fillVersions(body, job.id, cached);
  else { body.append(el('p', { class: 'muted', text: 'Loading versions…' })); queueMicrotask(() => loadVersions(job.id)); }
  return railSection('versions', el('h3', { text: 'Document versions' }), body);
}

export async function compareVersions(target) {
  const jobId = target.dataset.id;
  const a = $(`verA-${jobId}`)?.value; const b = $(`verB-${jobId}`)?.value;
  const out = $('verDiff');
  if (!out) return;
  try {
    const [left, right] = await Promise.all([
      api(`/api/jobs/${encodeURIComponent(jobId)}/version-text?n=${encodeURIComponent(a)}`),
      api(`/api/jobs/${encodeURIComponent(jobId)}/version-text?n=${encodeURIComponent(b)}`),
    ]);
    out.textContent = '';
    const changed = el('div', { class: 'rw-diff' });
    let differences = 0;
    for (const part of wordDiff(left.paragraphs.join('\n'), right.paragraphs.join('\n'))) {
      if (part.type === 'same') continue;
      differences += 1;
      changed.append(el(part.type === 'del' ? 'del' : 'ins', { text: part.text }), ' ');
    }
    out.append(el('p', { class: 'faint', text: differences ? `Changes from v${a} to v${b}:` : `v${a} and v${b} have the same resume text.` }), changed);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export async function restoreVersion(target) {
  const jobId = target.dataset.id;
  try {
    await postJson(`/api/jobs/${encodeURIComponent(jobId)}/restore-version`, { n: Number(target.dataset.n) });
    state.versions.delete(jobId);
    toast(`Restored version ${target.dataset.n} as the current documents.`);
    await loadVersions(jobId);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export const versionActions = {
  'compare-versions': (target) => compareVersions(target),
  'restore-version': (target) => restoreVersion(target),
};
