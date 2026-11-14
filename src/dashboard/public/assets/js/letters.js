/**
 * Your materials, part two: the master cover letter, each job's own letter,
 * and the master-vs-tailored resume comparison.
 *
 * Three dialogs, one rule: the person's words are the source and the person
 * decides. Nothing here approves, fills or submits; saving a job's letter
 * that was already approved sends it back to review.
 */
import { $, el, fmt, shortStamp, slowProgress, toast } from './dom.js';
import { api, postJson } from './api.js';
import { closeDialog, guardDialog, openDialog, confirmAction } from './dialogs.js';
import { state } from './state.js';
import { bytesToBase64 } from './master.js';

/* ───────────────────────── shared pieces ───────────────────────── */

const TOKEN_LABEL = { company: 'Company', title: 'Role', role: 'Role' };

/** A letter as paragraphs, with {tokens} and [prompts] made visible. */
export function letterPaper(text, { emptyText = 'Nothing written yet.' } = {}) {
  const paper = el('article', { class: 'lt-paper' });
  const blocks = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) { paper.append(el('p', { class: 'faint', text: emptyText })); return paper; }
  for (const block of blocks) {
    const p = el('p');
    // Split on tokens and prompts, keeping them as their own pieces.
    for (const part of block.split(/(\{\w+\}|\[[^\]\n]{3,120}\])/g)) {
      if (!part) continue;
      const token = part.match(/^\{(\w+)\}$/);
      if (token) {
        p.append(el('span', { class: 'lt-token', title: `Filled in for each job: ${token[1]}`, text: TOKEN_LABEL[token[1]] ?? token[1] }));
      } else if (/^\[[^\]]+\]$/.test(part)) {
        p.append(el('mark', { class: 'lt-prompt', title: 'Replace this with your own words before the letter is used', text: part.slice(1, -1) }));
      } else {
        // Line breaks inside a block (an address, a sign-off) stay line breaks.
        part.split('\n').forEach((line, i) => { if (i) p.append(el('br')); p.append(line); });
      }
    }
    paper.append(p);
  }
  return paper;
}

const LEVEL_TEXT = { block: 'Must fix', warn: 'Worth fixing', info: 'Suggestion' };

/** The quality read: a label, the words, and what to look at. */
export function qualityPanel(quality, { title = 'Quality check' } = {}) {
  const box = el('section', { class: 'lt-quality', 'aria-label': title });
  if (!quality) return box;
  const tone = quality.label === 'Strong' ? 'good' : quality.label === 'Good' ? 'info' : quality.label === 'Unfinished' ? 'bad' : 'warn';
  box.append(el('div', { class: 'lt-q-head' },
    el('span', { class: 'lt-q-title', text: title }),
    el('span', { class: `chip ${tone}`, text: quality.label })));
  box.append(el('p', { class: 'lt-q-facts', text: `${fmt(quality.words)} words · ${quality.paragraphs} paragraph${quality.paragraphs === 1 ? '' : 's'}` }));
  if (!quality.issues.length) {
    box.append(el('p', { class: 'lt-q-ok', text: 'Nothing to fix. It reads specific and complete.' }));
    return box;
  }
  const list = el('ul', { class: 'lt-issues' });
  for (const issue of quality.issues) {
    list.append(el('li', { class: `lt-issue is-${issue.level}` },
      el('span', { class: 'lt-issue-level', text: LEVEL_TEXT[issue.level] ?? issue.level }),
      el('span', { text: issue.message })));
  }
  box.append(list);
  return box;
}

const words = (text) => (String(text ?? '').match(/\b[\w'’-]+\b/g) ?? []).length;
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? shortStamp(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/* ─────────────────────── the master cover letter ─────────────────────── */

/**
 * view: 'read' | 'edit' | 'version' | 'tryout'
 * The dialog has one main column (the letter) and one quiet aside (quality,
 * try it on a job, versions), stacked on narrow screens.
 */
const ml = { data: null, view: 'read', draft: '', saved: '', version: null, tryout: null, previewTimer: null };

guardDialog($('dlgLetter'), () => ml.view === 'edit' && ml.draft.trim() !== ml.saved.trim());

export async function openMasterLetter(target) {
  closeDialog(target?.closest?.('dialog:not(#dlgDetail):not(#dlgLetter)'));
  const body = $('letterBody');
  const stop = slowProgress(body, 'Opening your master cover letter…');
  $('letterMsg').textContent = '';
  openDialog($('dlgLetter'));
  try {
    ml.data = await api('/api/master-letter');
    ml.saved = ml.data.text;
    ml.view = 'read'; ml.version = null; ml.tryout = null;
    renderMasterLetter();
  } catch (err) {
    body.textContent = '';
    body.append(el('p', { class: 'st-blocked', text: err.message }));
  } finally { stop(); }
}

function setMsg(text, tone = 'muted') {
  const msg = $('letterMsg');
  msg.className = `grow-1 ${tone}`;
  msg.textContent = text;
}

function renderMasterLetter() {
  const body = $('letterBody');
  const data = ml.data;
  body.textContent = '';
  const person = document.body.dataset.person ?? '';
  $('dlgLetterTitle').textContent = person && Number(document.body.dataset.people) > 1
    ? `${person.split(' ')[0]}'s master cover letter` : 'Master cover letter';

  if (!data.exists && ml.view !== 'edit') { body.append(emptyLetter()); return; }

  // ── the bar: facts on the left, the view switch and file actions on the right
  const bar = el('div', { class: 'lt-bar' });
  const facts = data.exists
    ? [`${fmt(data.words)} words`, `updated ${when(data.modifiedAt)}`].join(' · ')
    : 'Not saved yet';
  bar.append(el('div', { class: 'lt-bar-meta' },
    el('div', { class: 'lt-bar-name', text: 'Your letter' }),
    el('div', { class: 'lt-bar-facts', text: facts })));
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'View' });
  for (const [view, label] of [['read', 'Read'], ['edit', 'Edit']]) {
    seg.append(el('button', {
      type: 'button', 'data-action': 'letter-view', 'data-view': view,
      'aria-pressed': String(ml.view === view || (view === 'read' && (ml.view === 'version' || ml.view === 'tryout'))), text: label,
    }));
  }
  const files = el('div', { class: 'lt-bar-actions' }, seg,
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pick-letter-file', title: 'Replace it with a .docx, .txt or .md file. The current letter is kept as a version.', text: 'Upload' }));
  if (data.exists) files.append(el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-download', title: 'Save it as a .txt file', text: 'Download' }));
  bar.append(files);
  body.append(bar);

  const layout = el('div', { class: 'lt-layout' });
  const main = el('div', { class: 'lt-main' });
  const aside = el('aside', { class: 'lt-aside', 'aria-label': 'Check, try and history' });
  layout.append(main, aside);
  body.append(layout);

  if (ml.view === 'edit') main.append(letterEditor());
  else if (ml.view === 'version' && ml.version) main.append(versionView());
  else if (ml.view === 'tryout' && ml.tryout) main.append(tryoutView());
  else main.append(letterPaper(data.text));

  const quality = ml.view === 'edit' ? null : ml.view === 'version' ? ml.version.quality
    : ml.view === 'tryout' ? ml.tryout?.quality : data.quality;
  const qTitle = { version: 'This version', tryout: 'This tailored letter' }[ml.view] ?? 'Quality check';
  const qHost = el('div', { id: 'letterQuality' });
  if (quality) qHost.append(qualityPanel(quality, { title: qTitle }));
  aside.append(qHost);
  if (ml.view === 'edit') schedulePreview();
  aside.append(tryoutPicker());
  aside.append(versionList());
}

function emptyLetter() {
  return el('div', { class: 'lt-empty' },
    el('h3', { text: 'Write your cover letter once' }),
    el('p', { text: 'JobAgent tailors it to every job you apply for. It names the company and role, keeps the paragraphs that fit the posting, and adds results from your profile. It never adds experience you have not written down.' }),
    el('div', { class: 'lt-empty-actions' },
      el('button', { type: 'button', class: 'small primary', 'data-action': 'letter-starter', text: 'Start from a draft' }),
      el('button', { type: 'button', class: 'small', 'data-action': 'pick-letter-file', text: 'Upload a letter' }),
      el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-blank', text: 'Write from scratch' })),
    el('p', { class: 'faint lt-empty-note', text: 'The draft uses only what your profile states, and leaves highlighted prompts where your own words are needed.' }));
}

function letterEditor() {
  const wrap = el('div', { class: 'lt-editor' });
  const tools = el('div', { class: 'lt-tools', role: 'group', 'aria-label': 'Insert a placeholder' },
    el('span', { class: 'faint', text: 'Insert' }),
    el('button', { type: 'button', class: 'small ghost lt-insert', 'data-action': 'letter-insert', 'data-token': '{company}', title: 'Replaced with the employer\'s name for each job', text: 'Company' }),
    el('button', { type: 'button', class: 'small ghost lt-insert', 'data-action': 'letter-insert', 'data-token': '{title}', title: 'Replaced with the job title for each job', text: 'Role' }));
  const area = el('textarea', {
    id: 'letterText', class: 'lt-textarea', spellcheck: 'true', 'aria-label': 'Master cover letter',
    'aria-describedby': 'letterCount', rows: '18', text: ml.draft,
  });
  area.addEventListener('input', () => {
    ml.draft = area.value;
    $('letterCount').textContent = `${fmt(words(area.value))} words`;
    schedulePreview();
  });
  area.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      $('letterSave')?.click();
    }
  });
  const foot = el('div', { class: 'lt-edit-foot' },
    el('span', { id: 'letterCount', class: 'faint', 'aria-live': 'polite', text: `${fmt(words(ml.draft))} words` }),
    el('span', { class: 'grow-1' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-cancel', text: 'Cancel' }),
    el('button', { type: 'button', class: 'small primary', id: 'letterSave', 'data-action': 'letter-save', text: 'Save' }));
  wrap.append(tools, area, foot);
  queueMicrotask(() => area.focus());
  return wrap;
}

/** Live quality while typing: debounced, read-only. */
function schedulePreview() {
  clearTimeout(ml.previewTimer);
  ml.previewTimer = setTimeout(async () => {
    const host = $('letterQuality');
    if (!host || ml.view !== 'edit') return;
    try {
      const out = await postJson('/api/master-letter/preview', { text: ml.draft });
      host.replaceChildren(qualityPanel(out.quality, { title: 'As you write' }));
    } catch { /* the editor keeps working without it */ }
  }, 350);
}

function versionView() {
  const v = ml.version;
  const wrap = el('div', { class: 'lt-version' });
  wrap.append(el('div', { class: 'lt-banner', role: 'status' },
    el('span', { text: `Version from ${when(v.modifiedAt)} · ${fmt(v.words)} words` }),
    el('span', { class: 'grow-1' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-view', 'data-view': 'read', text: 'Back to current' }),
    el('button', { type: 'button', class: 'small', 'data-action': 'letter-restore', 'data-name': v.name, text: 'Restore this version' })));
  wrap.append(letterPaper(v.text));
  return wrap;
}

function tryoutView() {
  const t = ml.tryout;
  const wrap = el('div', { class: 'lt-version' });
  wrap.append(el('div', { class: 'lt-banner', role: 'status' },
    el('span', {}, 'Tailored for ', el('b', { text: t.company ?? 'this job' }), ` · ${t.title ?? ''}`),
    el('span', { class: 'grow-1' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'letter-view', 'data-view': 'read', text: 'Back to your letter' })));
  const source = t.source === 'master'
    ? `Built from your letter${t.master?.depth ? `, ${t.master.depth} length for this match` : ''}.`
    : 'Your letter has no finished paragraphs yet, so this is the basic template.';
  wrap.append(el('p', { class: 'mr-note', text: `${source} A preview only: nothing is saved.` }));
  for (const w of t.master?.warnings ?? []) wrap.append(el('p', { class: 'mr-note st-warn', text: w }));
  wrap.append(letterPaper(t.text));
  return wrap;
}

/** Prepared jobs first, then the best matches: somewhere real to try it. */
function tryoutJobs() {
  const jobs = [...state.known.values()].filter((j) => j?.id && j.company);
  const prepared = jobs.filter((j) => j.resumeDocxPath).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rest = jobs.filter((j) => !j.resumeDocxPath).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return [...prepared, ...rest].slice(0, 25);
}

function tryoutPicker() {
  const box = el('section', { class: 'lt-side-sec' }, el('h3', { text: 'Try it on a job' }));
  const jobs = tryoutJobs();
  if (!jobs.length) {
    box.append(el('p', { class: 'faint', text: 'Jobs on your board appear here, so you can see the letter each would get.' }));
    return box;
  }
  const select = el('select', { id: 'letterTryJob', class: 'small', 'aria-label': 'Job to tailor the letter for' });
  for (const j of jobs) {
    select.append(el('option', { value: j.id, text: `${j.company} · ${j.title ?? ''}`.slice(0, 80), selected: ml.tryout?.jobId === j.id }));
  }
  box.append(el('div', { class: 'lt-try' }, select,
    el('button', { type: 'button', class: 'small', 'data-action': 'letter-tryout', text: 'Preview' })));
  return box;
}

function versionList() {
  const versions = ml.data?.versions ?? [];
  const box = el('section', { class: 'lt-side-sec' }, el('h3', { text: versions.length ? `Earlier versions (${versions.length})` : 'Earlier versions' }));
  if (!versions.length) {
    box.append(el('p', { class: 'faint', text: 'Each save keeps the version it replaces, so you can always go back.' }));
    return box;
  }
  const list = el('ol', { class: 'lt-versions' });
  for (const v of versions.slice(0, 12)) {
    list.append(el('li', { class: ml.version?.name === v.name ? 'is-current' : '' },
      el('button', {
        type: 'button', class: 'lt-version-btn', 'data-action': 'letter-version', 'data-name': v.name,
        'aria-current': ml.version?.name === v.name ? 'true' : null,
      },
      el('span', { class: 'lt-v-when', text: when(v.modifiedAt) }),
      el('span', { class: 'lt-v-words', text: `${fmt(v.words)} words` }))));
  }
  box.append(list);
  return box;
}

function enterEdit(text) {
  ml.view = 'edit';
  ml.draft = text;
  renderMasterLetter();
}

async function saveMasterLetter(button) {
  const text = ml.draft;
  try {
    const result = await postJson('/api/master-letter', { text });
    ml.data = result.state;
    ml.saved = result.state.text;
    ml.view = 'read';
    setMsg('');
    toast(result.saved ? (result.backup ? 'Cover letter saved. The previous version is kept.' : 'Cover letter saved.') : 'No changes to save.', 'good');
    renderMasterLetter();
    $('dlgLetter').querySelector('[data-view="edit"]')?.focus();
  } catch (err) {
    setMsg(err.message, 'st-blocked');
    button?.focus();
  }
}

export async function uploadMasterLetter(file) {
  if (!file) return;
  if (!/\.(docx|txt|md|markdown)$/i.test(file.name)) { setMsg('Use a .docx, .txt or .md file.', 'st-blocked'); return; }
  if (file.size > 4 * 1024 * 1024) { setMsg('That file is larger than 4 MB.', 'st-blocked'); return; }
  setMsg(`Reading ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await postJson('/api/master-letter/upload', { filename: file.name, contentBase64: bytesToBase64(bytes) });
    ml.data = result.state; ml.saved = result.state.text; ml.view = 'read'; ml.version = null;
    setMsg('');
    toast(result.backup ? 'Letter uploaded. The previous version is kept.' : 'Letter uploaded.', 'good');
    renderMasterLetter();
  } catch (err) {
    setMsg(err.message, 'st-blocked');
  }
}

export const letterActions = {
  'open-master-letter': (target) => openMasterLetter(target),
  'letter-view': (target) => {
    const view = target.dataset.view;
    if (view === 'edit') { enterEdit(ml.view === 'edit' ? ml.draft : ml.data.text); return; }
    const leave = () => { ml.view = 'read'; ml.version = null; ml.tryout = null; ml.draft = ''; renderMasterLetter(); };
    if (ml.view === 'edit' && ml.draft.trim() !== ml.saved.trim()) {
      confirmAction('Your edits to the letter have not been saved.', leave, { title: 'Discard your edits?', confirmLabel: 'Discard edits', cancelLabel: 'Keep editing' });
      return;
    }
    leave();
  },
  'letter-starter': async () => {
    try { enterEdit((await api('/api/master-letter/starter')).text); } catch (err) { setMsg(err.message, 'st-blocked'); }
  },
  'letter-blank': () => enterEdit('Dear Hiring Team,\n\n\n\nSincerely,\n'),
  'letter-insert': (target) => {
    const area = $('letterText');
    if (!area) return;
    const { selectionStart: s, selectionEnd: e, value } = area;
    area.value = `${value.slice(0, s)}${target.dataset.token}${value.slice(e)}`;
    area.selectionStart = area.selectionEnd = s + target.dataset.token.length;
    area.dispatchEvent(new Event('input'));
    area.focus();
  },
  'letter-cancel': () => letterActions['letter-view']({ dataset: { view: 'read' } }),
  'letter-save': (target) => saveMasterLetter(target),
  'pick-letter-file': () => { $('letterFile').value = ''; $('letterFile').click(); },
  'letter-download': () => { window.location.href = '/api/master-letter/file'; },
  'letter-version': async (target) => {
    try {
      const v = await api(`/api/master-letter/version?name=${encodeURIComponent(target.dataset.name)}`);
      const meta = ml.data.versions.find((x) => x.name === v.name) ?? {};
      ml.version = { ...meta, ...v }; ml.view = 'version';
      renderMasterLetter();
    } catch (err) { setMsg(err.message, 'st-blocked'); }
  },
  'letter-restore': async (target) => {
    try {
      const result = await postJson('/api/master-letter/restore', { name: target.dataset.name });
      ml.data = result.state; ml.saved = result.state.text; ml.view = 'read'; ml.version = null;
      toast('Version restored. The letter it replaced is kept too.', 'good');
      renderMasterLetter();
    } catch (err) { setMsg(err.message, 'st-blocked'); }
  },
  'letter-tryout': async () => {
    const jobId = $('letterTryJob')?.value;
    if (!jobId) return;
    try {
      const out = await postJson('/api/master-letter/preview', { jobId, ...(ml.view === 'edit' ? { text: ml.draft } : {}) });
      if (ml.view === 'edit' && ml.draft.trim() !== ml.saved.trim()) {
        toast('Showing the letter your unsaved edits would produce.', '');
      }
      ml.tryout = out.letter; ml.view = 'tryout';
      renderMasterLetter();
    } catch (err) { setMsg(err.message, 'st-blocked'); }
  },

  /* ── one job's letter ── */
  'open-job-letter': (target) => openJobLetter(target.dataset.id),
  'job-letter-rebuild': () => rebuildJobLetter(),
  'job-letter-save': (target) => saveJobLetter(target),
  'job-letter-copy': async () => {
    const text = $('jobLetterText')?.value ?? jl.text;
    try { await navigator.clipboard.writeText(text); toast('Letter copied.', 'good'); } catch { toast('Copy failed: select the text and copy it.', 'bad'); }
  },

  /* ── resume comparison ── */
  'open-resume-diff': (target) => openResumeDiff(target.dataset.id),
  'diff-filter': (target) => { rd.filter = target.dataset.filter; renderResumeDiff(); },
  'diff-keep': (target) => {
    const text = target.dataset.text;
    if (rd.keep.has(text)) rd.keep.delete(text); else rd.keep.add(text);
    renderResumeDiff();
    $('dlgResumeDiff').querySelector(`[data-action="diff-keep"][data-text="${CSS.escape(text)}"]`)?.focus();
  },
  'diff-save-keep': (target) => saveKeepAndRetailor(target),
};

export const LETTER_BUSY_ACTIONS = ['letter-save', 'letter-restore', 'letter-tryout', 'letter-starter',
  'job-letter-save', 'job-letter-rebuild', 'diff-save-keep'];

/* ───────────────────────── one job's letter ───────────────────────── */

const jl = { jobId: null, exists: false, text: '', saved: '', frozen: false, draft: false };
guardDialog($('dlgJobLetter'), () => !jl.draft && jl.exists && ($('jobLetterText')?.value ?? jl.saved).trim() !== jl.saved.trim());

export async function openJobLetter(jobId) {
  const job = state.known.get(jobId) ?? state.detailJob;
  jl.jobId = jobId;
  $('dlgJobLetterSub').textContent = job ? `${job.company ?? ''} · ${job.title ?? ''}` : '';
  $('jobLetterMsg').textContent = '';
  const body = $('jobLetterBody');
  const stop = slowProgress(body, 'Opening the letter…');
  openDialog($('dlgJobLetter'));
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(jobId)}/cover-letter`);
    Object.assign(jl, { exists: data.exists, text: data.text ?? '', saved: data.text ?? '', frozen: data.frozen, draft: false });
    if (!data.exists) {
      const draft = await postJson(`/api/jobs/${encodeURIComponent(jobId)}/letter-draft`, {});
      Object.assign(jl, { text: draft.text, draft: true, source: draft.source });
      renderJobLetter(draft.quality);
    } else {
      renderJobLetter(data.quality);
    }
  } catch (err) {
    body.textContent = '';
    body.append(el('p', { class: 'st-blocked', text: err.message }));
  } finally { stop(); }
}

function renderJobLetter(quality) {
  const body = $('jobLetterBody');
  body.textContent = '';
  const layout = el('div', { class: 'lt-layout' });
  const main = el('div', { class: 'lt-main' });
  const aside = el('aside', { class: 'lt-aside', 'aria-label': 'Quality check' });
  layout.append(main, aside);
  if (jl.draft) {
    body.append(el('p', { class: 'mr-note', text: jl.source === 'master'
      ? 'No letter was written for this job when it was prepared. Here is one from your master cover letter: copy it, or download it, for this application.'
      : 'No letter was written for this job. Here is one from the basic template; write a master cover letter for a better one.' }));
  } else if (jl.frozen) {
    body.append(el('p', { class: 'mr-note', text: 'This application was submitted, so the letter is kept exactly as sent.' }));
  }
  const area = el('textarea', {
    id: 'jobLetterText', class: 'lt-textarea', rows: '18', spellcheck: 'true', 'aria-label': 'Cover letter for this job',
    readonly: jl.frozen ? true : null, text: jl.text,
  });
  area.addEventListener('input', () => {
    $('jobLetterCount').textContent = `${fmt(words(area.value))} words`;
  });
  area.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); $('jobLetterSave')?.click(); }
  });
  main.append(area);
  main.append(el('div', { class: 'lt-edit-foot' },
    el('span', { id: 'jobLetterCount', class: 'faint', 'aria-live': 'polite', text: `${fmt(words(jl.text))} words` }),
    el('span', { class: 'grow-1' }),
    jl.frozen ? null : el('button', { type: 'button', class: 'small ghost', 'data-action': 'job-letter-rebuild', title: 'Write it again from your current master cover letter. Nothing is saved until you press Save.', text: 'Rebuild from master' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'job-letter-copy', text: 'Copy' }),
    jl.draft || jl.frozen ? null : el('button', { type: 'button', class: 'small primary', id: 'jobLetterSave', 'data-action': 'job-letter-save', text: 'Save' })));
  aside.append(el('div', { id: 'jobLetterQuality' }, qualityPanel(quality)));
  aside.append(el('section', { class: 'lt-side-sec' },
    el('h3', { text: 'Your master letter' }),
    el('p', { class: 'faint', text: 'Every job\'s letter starts from it. Improve it once and rebuild here.' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'open-master-letter', text: 'Open master cover letter' })));
  body.append(layout);
  if (!jl.frozen) queueMicrotask(() => area.focus({ preventScroll: true }));
}

async function rebuildJobLetter() {
  try {
    const draft = await postJson(`/api/jobs/${encodeURIComponent(jl.jobId)}/letter-draft`, {});
    const area = $('jobLetterText');
    area.value = draft.text;
    area.dispatchEvent(new Event('input'));
    $('jobLetterQuality').replaceChildren(qualityPanel(draft.quality));
    $('jobLetterMsg').className = 'grow-1 muted';
    $('jobLetterMsg').textContent = jl.draft ? '' : 'Rebuilt from your master letter. Press Save to use it.';
  } catch (err) { toast(err.message, 'bad'); }
}

async function saveJobLetter(button) {
  const text = $('jobLetterText')?.value ?? '';
  const msg = $('jobLetterMsg');
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(jl.jobId)}/cover-letter`, { text });
    jl.saved = text;
    $('jobLetterQuality').replaceChildren(qualityPanel(result.quality));
    msg.className = 'grow-1 muted';
    msg.textContent = '';
    toast(result.needsReapproval
      ? 'Letter saved. The application went back to review, since what it sends changed.'
      : 'Letter saved for this application.', 'good');
    state.versions?.delete?.(jl.jobId);
  } catch (err) {
    msg.className = 'grow-1 st-blocked';
    msg.textContent = err.message;
    button?.focus();
  }
}

/* ─────────────────────── resume: master vs tailored ─────────────────────── */

const rd = { jobId: null, data: null, filter: 'changes', keep: new Set(), saved: new Set() };
guardDialog($('dlgResumeDiff'), () => !sameSet(rd.keep, rd.saved));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const STATUS_LABEL = {
  same: 'Unchanged', moved: 'Moved up', reordered: 'Reordered', reworded: 'Reworded', omitted: 'Left out', added: 'Added',
};

export async function openResumeDiff(jobId) {
  const job = state.known.get(jobId) ?? state.detailJob;
  rd.jobId = jobId;
  $('dlgResumeDiffSub').textContent = job ? `${job.company ?? ''} · ${job.title ?? ''}` : '';
  const body = $('resumeDiffBody');
  const stop = slowProgress(body, 'Comparing with your master resume…');
  openDialog($('dlgResumeDiff'));
  try {
    rd.data = await api(`/api/jobs/${encodeURIComponent(jobId)}/resume-diff`);
    rd.keep = new Set(rd.data.keep ?? []);
    rd.saved = new Set(rd.keep);
    rd.filter = 'changes';
    renderResumeDiff();
  } catch (err) {
    body.textContent = '';
    body.append(el('p', { class: 'st-blocked', text: err.message }));
  } finally { stop(); }
}

function renderResumeDiff() {
  const body = $('resumeDiffBody');
  const { summary, rows, masterChanged } = rd.data;
  body.textContent = '';

  // One line of numbers, then the one decision worth making.
  const stats = el('dl', { class: 'rd-stats' });
  for (const [k, label] of [['same', 'unchanged'], ['moved', 'moved up'], ['reordered', 'reordered'], ['reworded', 'reworded'], ['omitted', 'left out'], ['added', 'added']]) {
    if (!summary[k] && !['same', 'omitted'].includes(k)) continue;
    stats.append(el('div', { class: `rd-stat is-${k}` }, el('dt', { text: label }), el('dd', { text: fmt(summary[k]) })));
  }
  body.append(stats);

  if (masterChanged) {
    body.append(el('p', { class: 'mr-note st-warn', text: 'Your master resume changed after this resume was tailored, so some differences come from your own edits. Re-tailor to compare like for like.' }));
  }
  const omitted = rows.filter((r) => r.status === 'omitted');
  if (omitted.length) {
    const notable = omitted.filter((r) => r.flags.length);
    body.append(el('div', { class: notable.length ? 'attention rd-call' : 'mr-block rd-call' },
      notable.length ? el('span', { class: 'mark', 'aria-hidden': 'true', text: '!' }) : '',
      el('div', {},
        el('b', { text: notable.length
          ? `${notable.length} of the ${omitted.length} left-out line${omitted.length === 1 ? '' : 's'} may matter. `
          : `${omitted.length} line${omitted.length === 1 ? ' was' : 's were'} left out to hold the page limit. ` }),
        'Mark any you want back with Keep. The next tailoring keeps them, even if the resume runs longer.')));
  } else {
    body.append(el('p', { class: 'mr-note', text: 'Nothing from your master resume was left out. Tailoring only changed order and emphasis.' }));
  }

  const seg = el('div', { class: 'seg rd-filter', role: 'group', 'aria-label': 'Show' });
  for (const [f, label] of [['changes', 'Changes only'], ['all', 'Whole resume']]) {
    seg.append(el('button', { type: 'button', 'data-action': 'diff-filter', 'data-filter': f, 'aria-pressed': String(rd.filter === f), text: label }));
  }
  body.append(seg);

  const list = el('ol', { class: 'rd-list', 'aria-label': 'Resume lines' });
  let section = null;
  for (const row of rows) {
    if (rd.filter === 'changes' && row.status === 'same') continue;
    if (row.section && row.section !== section) {
      section = row.section;
      list.append(el('li', { class: 'rd-section', 'aria-hidden': 'true', text: section }));
    }
    const item = el('li', { class: `rd-row is-${row.status}${rd.keep.has(row.text) ? ' is-kept' : ''}` });
    item.append(el('span', { class: 'rd-tag', text: STATUS_LABEL[row.status] }));
    const text = el('div', { class: 'rd-text' });
    if (row.status === 'reworded' && row.before) {
      text.append(el('del', { text: row.before }), el('ins', { text: row.text }));
    } else {
      text.append(el('span', { text: row.text }));
    }
    if (row.status === 'omitted') {
      const why = [row.role ? `From ${row.role}` : '', row.reason].filter(Boolean).join(' · ');
      if (why) text.append(el('span', { class: 'rd-why', text: why }));
      if (row.flags.length) {
        const flags = el('span', { class: 'rd-flags' });
        for (const f of row.flags) flags.append(el('span', { class: 'chip warn', text: f }));
        text.append(flags);
      }
    }
    item.append(text);
    if (row.status === 'omitted' && !row.flags.includes('section heading')) {
      const kept = rd.keep.has(row.text);
      item.append(el('button', {
        type: 'button', class: `small ${kept ? 'primary' : 'ghost'} rd-keep`, 'data-action': 'diff-keep', 'data-text': row.text,
        'aria-pressed': String(kept), text: kept ? 'Kept' : 'Keep',
      }));
    }
    list.append(item);
  }
  if (!list.children.length) list.append(el('li', { class: 'rd-empty faint', text: 'No differences: the tailored resume reads the same as your master.' }));
  body.append(list);

  const foot = $('resumeDiffFoot');
  foot.textContent = '';
  const changed = !sameSet(rd.keep, rd.saved);
  foot.append(el('span', { class: 'grow-1 faint', id: 'resumeDiffMsg', text: changed ? `${rd.keep.size} line${rd.keep.size === 1 ? '' : 's'} marked to keep.` : '' }));
  foot.append(el('button', { type: 'button', class: 'small', 'data-action': 'close-dialog', text: 'Close' }));
  if (changed) foot.append(el('button', { type: 'button', class: 'small primary', 'data-action': 'diff-save-keep', text: 'Keep and re-tailor' }));
}

async function saveKeepAndRetailor() {
  try {
    await postJson(`/api/jobs/${encodeURIComponent(rd.jobId)}/keep-bullets`, { bullets: [...rd.keep] });
    rd.saved = new Set(rd.keep);
    closeDialog($('dlgResumeDiff'));
    // The same path as the resume card's "Re-tailor".
    const { prepareOne } = await import('./mutations.js');
    await prepareOne(rd.jobId);
  } catch (err) {
    toast(err.message, 'bad');
  }
}
