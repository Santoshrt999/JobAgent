/**
 * Top matches by meaning (P2-1): the fit score and the meaning score side by
 * side, sortable by either, with the resume bullets each posting is closest
 * to. The fit score is never replaced.
 */
import { $, el, toast } from './dom.js';
import { api, postJson } from './api.js';
import { openDialog } from './dialogs.js';

let current = null;
let order = 'semantic';

/** Rows in the chosen order. Pure. */
export function orderRows(items, by) {
  const key = by === 'fit' ? 'fitScore' : 'semantic';
  return [...items].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
}

function render(info) {
  const body = $('rerankBody');
  body.textContent = '';
  if (!info.enabled && !info.result) { body.append(el('p', { text: info.reason })); return; }
  const row = el('div', { class: 'row-gap' });
  if (info.enabled) row.append(el('button', { type: 'button', class: 'small', 'data-action': 'run-rerank', text: info.result ? 'Rank again' : 'Rank top 50' }));
  if (info.result) {
    for (const [by, label] of [['semantic', 'Order by meaning'], ['fit', 'Order by fit score']]) {
      row.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'rerank-order', 'data-by': by, 'aria-pressed': String(order === by), text: label }));
    }
  }
  body.append(row);
  if (!info.result) return;
  body.append(el('p', { class: 'faint', text: `Ranked with ${info.result.model} on ${new Date(info.result.at).toLocaleString()}.` }));
  const table = el('table', { class: 'mini rerank-table' });
  table.append(el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Job' }), el('th', { scope: 'col', text: 'Fit score' }),
    el('th', { scope: 'col', text: 'Meaning' }), el('th', { scope: 'col', text: 'Closest in your resume' }))));
  const tbody = el('tbody');
  for (const item of orderRows(info.result.items, order)) {
    tbody.append(el('tr', { 'data-job': item.jobId },
      el('td', { text: `${item.company} — ${item.title}` }),
      el('td', { text: item.fitScore == null ? '—' : `${item.fitScore}${item.tier ? ` (${item.tier})` : ''}` }),
      el('td', { text: String(item.semantic) }),
      el('td', { class: 'faint', text: item.closest?.[0]?.text ?? '' })));
  }
  table.append(tbody);
  body.append(table);
}

export async function openRerank() {
  openDialog($('dlgRerank'));
  $('rerankBody').replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  try { current = await api('/api/rerank'); render(current); } catch (err) { $('rerankBody').replaceChildren(el('p', { class: 'st-blocked', text: err.message })); }
}

export const rerankActions = {
  'open-rerank': openRerank,
  'run-rerank': async () => {
    $('rerankBody').querySelector('.faint')?.replaceWith(el('p', { class: 'muted', text: 'Ranking…' }));
    try { const r = await postJson('/api/rerank'); current = { ...current, enabled: true, result: r.result }; render(current); }
    catch (err) { toast(err.message, 'bad'); }
  },
  'rerank-order': (target) => { order = target.dataset.by; if (current) render(current); },
};
