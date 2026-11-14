/**
 * The command palette: ⌘K / Ctrl+K (audit Backlog #4).
 *
 * One box that reaches every view, every menu command and any job already
 * loaded, by typing. Each command is the SAME action its menu item or button
 * dispatches (dispatchAction), so nothing here can do what the page itself
 * cannot: no approving, filling or submitting from a keystroke.
 *
 * Opened many times a day, so it opens and closes with no animation, and it
 * is the ARIA combobox pattern: focus stays in the input, ↑/↓ move the active
 * option (aria-activedescendant), Enter runs it, Escape closes.
 */
import { $, el } from './dom.js';
import { state } from './state.js';
import { selectJob } from './detail.js';
import { setView } from './today.js';

const COMMANDS = [
  { group: 'Go to', label: 'Today', keywords: 'home landing queue', run: () => setView('today', { nav: true }) },
  { group: 'Go to', label: 'Jobs', keywords: 'board discover list', run: () => setView('board', { nav: true }) },
  { group: 'Go to', label: 'Applications', keywords: 'pipeline kanban workspace', run: () => setView('applications', { nav: true }) },
  { group: 'Do', label: 'Find new jobs', keywords: 'search run discover', action: 'run', data: { phase: 'discover' } },
  { group: 'Do', label: 'Search job boards by role…', keywords: 'query role search', action: 'open-job-search' },
  { group: 'Do', label: 'Add a job by link…', keywords: 'url paste add', action: 'open-add-url' },
  { group: 'Do', label: 'Remove closed postings', keywords: 'sweep closed dead', action: 'sweep-postings' },
  { group: 'Your materials', label: 'Application profile and answers', keywords: 'questions screening profile', action: 'open-profile' },
  { group: 'Your materials', label: 'Master resume', keywords: 'resume cv docx', action: 'open-master' },
  { group: 'Your materials', label: 'Master cover letter', keywords: 'letter cover', action: 'open-master-letter' },
  { group: 'Your materials', label: 'Tailored documents', keywords: 'documents files resumes', action: 'open-documents' },
  { group: 'Insights', label: 'Data quality', keywords: 'filtered discarded backlog', action: 'open-data-quality' },
  { group: 'Insights', label: 'Reports', keywords: 'analytics funnel stats', action: 'open-reports' },
  { group: 'Insights', label: 'Run history', keywords: 'runs log', action: 'open-runs' },
  { group: 'Insights', label: 'System health', keywords: 'doctor setup health', action: 'open-health' },
  { group: 'Settings', label: 'Switch light or dark', keywords: 'theme dark light', action: 'toggle-theme' },
  { group: 'Settings', label: 'Keyboard shortcuts', keywords: 'keys help', action: 'open-keys' },
  { group: 'Export', label: 'Export jobs (CSV)', keywords: 'csv download', action: 'export-jobs' },
];

const MAX_JOBS = 8;
let dispatch = null;
let active = 0;
let shown = [];

/** Lowercase words of a string, for a forgiving every-word match. */
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);

/** Does every typed word prefix some word of the haystack? */
export function matches(query, haystack) {
  const want = words(query);
  if (!want.length) return true;
  const have = words(haystack);
  return want.every((w) => have.some((h) => h.startsWith(w)));
}

/** The palette's results for a query: commands first, then loaded jobs. */
export function paletteResults(query, { known = new Map(), commands = COMMANDS } = {}) {
  const out = commands.filter((c) => matches(query, `${c.label} ${c.keywords} ${c.group}`));
  if (String(query ?? '').trim().length >= 2) {
    let n = 0;
    for (const job of known.values()) {
      if (n >= MAX_JOBS) break;
      if (!job?.id || !matches(query, `${job.title} ${job.company} ${job.location ?? ''}`)) continue;
      out.push({ group: 'Jobs', label: `${job.title ?? 'Untitled'}`, detail: job.company ?? '', jobId: job.id });
      n += 1;
    }
  }
  return out;
}

function render() {
  const list = $('paletteList');
  const query = $('paletteInput').value;
  shown = paletteResults(query, { known: state.known });
  active = Math.min(active, Math.max(0, shown.length - 1));
  list.textContent = '';
  let group = null;
  shown.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group;
      list.append(el('li', { class: 'pal-group', role: 'presentation', text: group }));
    }
    list.append(el('li', {
      id: `pal-${i}`, role: 'option', class: 'pal-item', 'data-index': String(i),
      'aria-selected': String(i === active),
    }, el('span', { class: 'pal-label', text: item.label }), item.detail ? el('span', { class: 'pal-detail', text: item.detail }) : ''));
  });
  if (!shown.length) list.append(el('li', { class: 'pal-empty', role: 'presentation', text: 'No matching command or loaded job' }));
  $('paletteInput').setAttribute('aria-activedescendant', shown.length ? `pal-${active}` : '');
  list.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
}

export function openPalette() {
  const dialog = $('dlgPalette');
  if (!dialog || dialog.open) return;
  $('paletteInput').value = '';
  active = 0;
  render();
  dialog.showModal();
  $('paletteInput').focus();
}

export function closePalette() {
  const dialog = $('dlgPalette');
  if (dialog?.open) dialog.close();
}

function runItem(index) {
  const item = shown[index];
  if (!item) return;
  closePalette();
  if (item.jobId) { selectJob(item.jobId, { user: true }); return; }
  if (item.run) { item.run(); return; }
  if (item.action && dispatch) {
    const target = el('button', { type: 'button', 'data-action': item.action });
    for (const [k, v] of Object.entries(item.data ?? {})) target.dataset[k] = v;
    dispatch(item.action, target, null);
  }
}

/**
 * Wire the palette. `dispatchAction` is passed in (not imported) so this
 * module does not form an import cycle with actions.js.
 */
export function installPalette(dispatchAction) {
  dispatch = dispatchAction;
  const dialog = $('dlgPalette');
  if (!dialog) return;
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (dialog.open) closePalette(); else openPalette();
    }
  });
  $('paletteInput').addEventListener('input', () => { active = 0; render(); });
  $('paletteInput').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!shown.length) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(active);
    }
  });
  $('paletteList').addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) runItem(Number(option.dataset.index));
  });
  // A click on the backdrop (the dialog box itself, outside the panel) closes it.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closePalette(); });
}
