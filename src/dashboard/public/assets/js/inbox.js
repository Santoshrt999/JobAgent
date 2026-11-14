/**
 * The Email replies window (P1-7): what the read-only inbox sync found, with
 * the sentence that shows it, and Record / Dismiss. Recording writes the same
 * outcome as recording it by hand; nothing happens without a click.
 */
import { $, el, toast } from './dom.js';
import { api, postJson } from './api.js';
import { openDialog } from './dialogs.js';
import { emlFile, mailtoHref } from './emailDraft.js';

let draftsEnabled = false;

const KIND_LABEL = {
  rejection: 'Rejection', interview: 'Interview request', assessment: 'Assessment', offer: 'Offer', acknowledgement: 'Application received',
};
const OUTCOME_LABEL = { rejected: 'Rejected', interviewing: 'Interviewing', offer: 'Offer received' };

export function renderInbox(info) {
  if (typeof info.draftsEnabled === 'boolean') draftsEnabled = info.draftsEnabled;
  const body = $('inboxBody');
  body.textContent = '';
  if (!info.enabled) {
    body.append(el('p', { text: info.reason }));
    body.append(el('p', { class: 'muted', text: 'Use an app password (Gmail: Google Account, Security, App passwords), not your account password.' }));
  } else {
    body.append(el('button', { type: 'button', class: 'small', 'data-action': 'inbox-sync', text: 'Check for replies' }));
  }
  body.append(el('p', { id: 'inboxStatus', role: 'status', class: 'muted', text: info.stats
    ? `Read ${info.stats.read} message(s); ${info.stats.matched} matched an application; ${info.stats.suggested} new suggestion(s).` : '' }));
  const list = el('ul', { class: 'inbox-list' });
  for (const s of info.suggestions ?? []) {
    const item = el('li', { class: 'inbox-item', 'data-id': s.id });
    item.append(el('div', {}, el('b', { text: KIND_LABEL[s.kind] ?? s.kind }), ` · ${s.company ?? 'An application'}${s.title ? ` — ${s.title}` : ''}`));
    item.append(el('div', { class: 'faint', text: `${s.subject} (from ${s.from?.domain ?? 'unknown'})` }));
    if (s.evidence) item.append(el('blockquote', { class: 'inbox-evidence', text: s.evidence }));
    const row = el('div', { class: 'row-gap' });
    if (s.outcome) {
      row.append(el('button', { type: 'button', class: 'small', 'data-action': 'inbox-record', 'data-id': s.id, text: `Record as ${OUTCOME_LABEL[s.outcome] ?? s.outcome}` }));
    }
    if (draftsEnabled) {
      row.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'inbox-draft', 'data-id': s.id, text: 'Draft a reply' }));
    }
    row.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'inbox-dismiss', 'data-id': s.id, text: 'Dismiss' }));
    item.append(row, el('div', { class: 'inbox-draft', id: `draft-${s.id}` }));
    list.append(item);
  }
  if (info.enabled && !(info.suggestions ?? []).length) list.append(el('li', { class: 'muted', text: 'No replies waiting for you.' }));
  body.append(list);
}

export async function openInbox() {
  openDialog($('dlgInbox'));
  $('inboxBody').replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  try { renderInbox(await api('/api/inbox')); } catch (err) { $('inboxBody').replaceChildren(el('p', { class: 'st-blocked', text: err.message })); }
}

async function sync() {
  $('inboxStatus').textContent = 'Reading your inbox…';
  try {
    const r = await postJson('/api/inbox/sync');
    renderInbox({ enabled: true, ...r });
  } catch (err) {
    $('inboxStatus').textContent = err.message;
  }
}

async function decide(target, action) {
  try {
    const r = await postJson('/api/inbox/decide', { id: target.dataset.id, action });
    renderInbox({ enabled: true, suggestions: r.suggestions });
    toast(action === 'record' ? 'Recorded on the application.' : 'Dismissed.');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/** Show a drafted reply: editable, with what to fill in, and ways to take it to your email. Never sent from here. */
function showDraft(id, draft) {
  const host = $(`draft-${id}`);
  if (!host) return;
  host.textContent = '';
  const areaId = `draftText-${id}`;
  host.append(el('label', { for: areaId, class: 'faint', text: `Draft reply to ${draft.to || 'the sender'} (edit before sending; JobAgent never sends it)` }));
  const area = el('textarea', { id: areaId, class: 'inbox-draft-text', rows: '9' });
  area.value = draft.text;
  host.append(area);
  if (draft.gaps?.length) {
    const ul = el('ul', { class: 'inbox-gaps' });
    for (const g of draft.gaps) ul.append(el('li', { text: g }));
    host.append(el('p', { class: 'faint', text: 'Fill these in before you send:' }), ul);
  }
  if (draft.dropped?.length) host.append(el('p', { class: 'muted', text: `${draft.dropped.length} sentence(s) were left out because your resume does not back them.` }));
  const row = el('div', { class: 'row-gap' });
  const copy = el('button', { type: 'button', class: 'small', text: 'Copy' });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(area.value); toast('Copied. Paste it into your email.'); } catch { area.select(); toast('Select all and copy.'); }
  });
  const open = el('a', { class: 'btn small ghost', href: mailtoHref({ to: draft.to, subject: draft.subject, text: area.value }), text: 'Open in email app' });
  const download = el('button', { type: 'button', class: 'small ghost', text: 'Download .eml' });
  download.addEventListener('click', () => {
    const blob = new Blob([emlFile({ to: draft.to, subject: draft.subject, text: area.value })], { type: 'message/rfc822' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'reply.eml' });
    document.body.append(a); a.click(); a.remove();
  });
  area.addEventListener('input', () => { open.href = mailtoHref({ to: draft.to, subject: draft.subject, text: area.value }); });
  row.append(copy, open, download);
  host.append(row);
}

async function draft(target) {
  const id = target.dataset.id;
  const host = $(`draft-${id}`);
  if (host) host.replaceChildren(el('p', { class: 'muted', text: 'Drafting, and checking each sentence against your resume…' }));
  try {
    const r = await postJson('/api/inbox/draft', { id });
    showDraft(id, r.draft);
  } catch (err) {
    if (host) host.replaceChildren(el('p', { class: 'st-blocked', text: err.message }));
  }
}

export const inboxActions = {
  'inbox-draft': draft,
  'open-inbox': openInbox,
  'inbox-sync': sync,
  'inbox-record': (target) => decide(target, 'record'),
  'inbox-dismiss': (target) => decide(target, 'dismiss'),
};
