/**
 * JobAgent dashboard front end.
 *
 * Design notes that matter for correctness:
 *
 *  - NO inline event handlers. Every interaction is routed through one
 *    delegated listener keyed on `data-action`, and every job id travels in a
 *    `data-id` attribute. The previous build interpolated ids into
 *    `onclick="select('…')"` strings, so an id containing an apostrophe (ids are
 *    derived from third-party feed data) broke the row or executed as script.
 *    Values are now never parsed as code, and the page needs no
 *    `script-src 'unsafe-inline'`.
 *
 *  - The board is PAGINATED against the server. It previously rendered whatever
 *    the API's default 200-row cap returned while the tab badges counted every
 *    match, so ~1,400 jobs were unreachable and the numbers disagreed.
 *
 *  - Mutations update the affected row in place and schedule ONE coalesced
 *    background refresh, instead of re-fetching stats + sections + board after
 *    every click (~1s of work each on a large database).
 */

/** Entry module: keyboard wiring, filter wiring, view preferences, and boot. */

import { $, el } from './dom.js';
import { FILTER_IDS, state, TOGGLE_IDS } from './state.js';
import { filterValue, SORT_DIRECTION } from './filters.js';
import { renderTabs } from './analytics.js';
import { loadBoard, setRowTabStop } from './board.js';
import { cssEscape, isSheetLayout, placeDetail, selectJob, SHEET_QUERY } from './detail.js';
import { openDialog } from './dialogs.js';
import { decide, prepareOne, refreshAll } from './mutations.js';
import { loadHealthChecks, setView } from './today.js';
import { syncSelectionBar, toggleSelect } from './selection.js';
import { uploadMasterResume } from './master.js';
import { uploadMasterLetter } from './letters.js';
import { loadProfileFlag } from './profile.js';
import { pollRun, scheduleBackgroundRefresh, setRunDetails } from './runs.js';
import { dispatchAction, loadFeatures, syncBoardSearchAction } from './actions.js';
import { installPalette } from './palette.js';
import { closeMainMenu } from './menus.js';
import { installWorkspaceDrag } from './workspace.js';
import { announcePendingSwitch, loadProfiles } from './profiles.js';

/* ────────────────────── keyboard support ────────────────────── */

$('rows').addEventListener('keydown', (event) => {
  const row = event.target.closest('tr.job');
  if (!row) return;
  const index = state.visible.indexOf(row.dataset.id);

  // When a link inside the row has focus, Enter belongs to the LINK. Without
  // this the handler's preventDefault() swallowed it and selected the row
  // instead — a keyboard user could focus the role link and never open it.
  if (event.key === 'Enter' && event.target.closest('a[href]')) return;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectJob(row.dataset.id, { user: true });
    return;
  }
  // Single-key triage on the focused row (never with a modifier, never while
  // a control inside the row has focus). Each is the same action as its
  // button, with the same Undo; nothing here approves, fills or submits.
  const TRIAGE = { s: 'shortlisted', e: 'archived', r: 'rejected' };
  if (event.target === row && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (TRIAGE[key]) { event.preventDefault(); decide(row.dataset.id, TRIAGE[key]); return; }
    if (key === 'p') { event.preventDefault(); prepareOne(row.dataset.id); return; }
  }
  if (event.key === 'x' || event.key === 'X') {
    event.preventDefault();
    const box = row.querySelector('input[type=checkbox]');
    box.checked = !box.checked;
    toggleSelect(row.dataset.id, box.checked);
    return;
  }
  // j/k as in every triage tool; Home/End to the ends of the page. Only on
  // the row itself, never while a control inside it has focus.
  const onRow = event.target === row;
  const delta = event.key === 'ArrowDown' || (onRow && event.key === 'j') ? 1
    : event.key === 'ArrowUp' || (onRow && event.key === 'k') ? -1
      : onRow && event.key === 'Home' ? -index
        : onRow && event.key === 'End' ? state.visible.length - 1 - index : 0;
  if (!delta) return;
  event.preventDefault();
  const next = state.visible[index + delta];
  if (next) {
    const nextRow = $('rows').querySelector(`tr.job[data-id="${cssEscape(next)}"]`);
    nextRow?.focus();
    // Wide: the rail follows focus, debounced so holding ↓ costs one request.
    // Narrow: the detail is a modal sheet, and opening one per keypress would
    // trap the user — arrows move, Enter opens.
    if (!isSheetLayout()) selectJob(next, { defer: 120 });
  }
});

// Whichever row receives focus (a click, restored focus, arrows) takes the
// board's single tab stop, so Tab out and Shift+Tab back return to it.
$('rows').addEventListener('focusin', (event) => {
  const row = event.target.closest('tr.job');
  if (row && row.tabIndex !== 0) setRowTabStop(row);
});

/**
 * Arrow-key movement inside the tablist, as the tab pattern requires.
 *
 * With a roving tabindex the arrow keys are the ONLY way to reach the other
 * tabs from the keyboard, so this is not a nicety — without it seven of the
 * eight tabs become unreachable. Left/Right wrap; Home/End jump to the ends.
 */
$('tabs').addEventListener('keydown', (event) => {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const tabs = [...$('tabs').querySelectorAll('[role="tab"]')];
  const from = tabs.indexOf(event.target.closest('[role="tab"]'));
  if (from === -1) return;
  event.preventDefault();
  const to = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (from + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  // Focus moves first so the tab that is about to be re-rendered is not the one
  // we are trying to land on; activation follows, as this tablist is
  // selection-follows-focus (each tab is a cheap board query).
  tabs[to].focus();
  tabs[to].click();
});

/**
 * The metric tiles are spans with role="button" (they must not nest inside the
 * flex strip as real buttons), so Enter/Space has to be wired up by hand —
 * without this they were focusable but impossible to activate by keyboard.
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest?.('[role="button"][data-action]');
  if (!target || target.tagName === 'BUTTON' || target.tagName === 'A') return;
  event.preventDefault();
  target.click();
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  // "/" focuses search, as in most triage tools.
  if (event.key === '/' && !typing) {
    event.preventDefault();
    $('q').focus();
  }
  // "?" opens the shortcut sheet — the conventional key, so the feature does
  // not itself need discovering.
  if (event.key === '?' && !typing) {
    event.preventDefault();
    openDialog($('dlgKeys'));
  }
  if (event.key !== 'Escape') return;
  closeMainMenu();
  if (!$('runDetails').hidden) {
    setRunDetails(false);
    $('btnRunDetails').focus();
    return;
  }
  // Escape in the search box clears it, the standard search-field behavior.
  if (event.target === $('q') && $('q').value) {
    $('q').value = '';
    state.page = 1;
    onFilterChange();
  }
});

$('selAll').addEventListener('change', (event) => {
  for (const id of state.visible) {
    if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
  }
  for (const box of $('rows').querySelectorAll('input[data-action="toggle-select"]')) {
    box.checked = event.target.checked;
  }
  syncSelectionBar();
});

/**
 * Mark the column the board is actually sorted by.
 *
 * This is derived from state rather than set on click, so "Reset" and the
 * initial load agree with the data: the old build left a stale indicator on
 * whichever header you last clicked, and never marked the default sort at all.
 */
export function syncSortIndicator() {
  for (const th of document.querySelectorAll('th.sortable')) {
    if (th.dataset.sort === state.sort) {
      th.setAttribute('aria-sort', SORT_DIRECTION[state.sort] ?? 'descending');
    } else th.removeAttribute('aria-sort');
  }
}

/**
 * Remember VIEW preferences (sort column, rows per page) but never filters.
 * Coming back to a board that is silently narrowed is disorienting; coming back
 * to the row count and ordering you chose is just the tool remembering you.
 */
export function savePreference(key, value) {
  try { localStorage.setItem(`jobagent-${key}`, String(value)); }
  catch { /* private mode */ }
}
export function readPreference(key) {
  try { return localStorage.getItem(`jobagent-${key}`); }
  catch { return null; }
}

/* Header sort toggles */
for (const th of document.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    state.sort = th.dataset.sort;
    state.page = 1;
    savePreference('sort', state.sort);
    syncSortIndicator();
    loadBoard();
  });
  th.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    th.click();
  });
}

/* Filter wiring */
// Free-text filters debounce on every keystroke so the board tracks what is
// typed. A bare `change` listener would only fire on blur/Enter, which reads
// as the filter being broken while you are still looking at the field.
export const DEBOUNCED_TEXT_FILTERS = ['q', 'city'];
export let searchTimer = null;
for (const id of DEBOUNCED_TEXT_FILTERS) {
  $(id).addEventListener('input', () => {
    // The escalating action tracks the query on every keystroke, NOT on the
    // debounce — it is a property of what is typed, not of what the board has
    // finished loading, and a quarter-second of lag on a control appearing
    // reads as the field being unresponsive.
    if (id === 'q') syncBoardSearchAction();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.page = 1; onFilterChange(); }, 250);
  });
}
// Also after any programmatic write: Reset, a restored URL/preference, or a
// filter chip being dismissed all change the query without an `input` event.
syncBoardSearchAction();
// Every other filter control except the segmented switch (a click, not a
// change) reloads the board when it changes.
for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) {
  if (DEBOUNCED_TEXT_FILTERS.includes(id) || $(id).type === 'hidden') continue;
  $(id).addEventListener('change', () => { state.page = 1; onFilterChange(); });
}
$('pageSize').addEventListener('change', (event) => {
  state.pageSize = Number(event.target.value) || 100;
  state.page = 1;
  savePreference('pageSize', state.pageSize);
  loadBoard();
});

/**
 * A filter now narrows WITHIN the current tab instead of leaving it.
 *
 * Touching any filter used to force the tab back to "All jobs". That was done
 * to keep each badge equal to what clicking it opens — but it also meant the
 * most natural move on this board ("of the 179 needing review, which are strong
 * fits?") silently threw you into all 19,212 rows. The server always supported
 * the combination; only the UI refused it.
 *
 * The badge promise is kept instead of dodged: when a filter is active the
 * board request also returns per-tab counts computed against that same filter,
 * so every badge still says exactly how many rows clicking it would show.
 */
export function onFilterChange() {
  loadBoard();
}

/* ─────────────────── view preferences: density + columns ───────────────────
 * Both are VIEW settings, so they persist like sort and page size and never
 * like a filter: coming back to a board that is silently narrowed is
 * disorienting, coming back to the shape you chose is the tool remembering you.
 */

/**
 * Columns the reader may hide. Grade, company/role and status are not offered:
 * a board with no fit, no role and no state is not a denser board, it is an
 * empty one. `nth` is the 1-based column position the CSS rules key on.
 */
export const OPTIONAL_COLUMNS = [
  { key: 'sponsor', nth: 4, label: 'Sponsor' },
  { key: 'posted', nth: 5, label: 'Posted' },
  { key: 'found', nth: 6, label: 'Found' },
  { key: 'resume', nth: 7, label: 'Resume' },
];

export function hiddenColumns() {
  try { return new Set(JSON.parse(readPreference('hiddenColumns') ?? '[]')); }
  catch { return new Set(); }
}

/** Reflect density + hidden columns onto the board, and remember both. */
export function applyViewPrefs({ density, hidden } = {}) {
  const d = density ?? readPreference('density') ?? 'comfortable';
  document.documentElement.dataset.density = d;
  savePreference('density', d);
  for (const button of document.querySelectorAll('[data-action="set-density"]')) {
    button.setAttribute('aria-checked', String(button.dataset.density === d));
  }

  const set = hidden ?? hiddenColumns();
  savePreference('hiddenColumns', JSON.stringify([...set]));
  // One attribute on the table drives every rule; the alternative — toggling a
  // class on ~800 cells after each render — is both slower and easy to miss on
  // a re-render.
  $('board').dataset.hide = [...set].join(' ');

  const host = $('columnToggles');
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.column : null;
  host.textContent = '';
  for (const column of OPTIONAL_COLUMNS) {
    const on = !set.has(column.key);
    host.append(el('button', {
      type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on), tabindex: '-1',
      'data-action': 'toggle-column', 'data-column': column.key,
    }, el('span', { class: 'tick', 'aria-hidden': 'true', text: on ? '✓' : '' }), column.label));
  }
  // Rebuilt on every toggle; without this, ticking a column dropped focus out
  // of the open menu.
  if (focused) host.querySelector(`[data-column="${cssEscape(focused)}"]`)?.focus();
}

/** True when any filter is set, i.e. the tab alone no longer describes the board. */
export function hasActiveFilters() {
  return [...FILTER_IDS, ...TOGGLE_IDS].some((id) => filterValue(id));
}

/**
 * "More filters": fold every control except search, fit and status behind
 * one button, at every width.
 *
 * The CSS does the hiding (`.filterbar[data-collapsed]`), so this only tracks
 * the flag and keeps the button honest about how many filters are set — a
 * collapsed bar with three active filters must say three, or it is the same
 * hidden-state problem the old popover had.
 */
export function setFilterSheet(open) {
  $('filterbar').dataset.collapsed = String(!open);
  $('btnFilterSheet').setAttribute('aria-expanded', String(open));
}

/** Filters that are always on screen, so the panel count leaves them out. */
const ALWAYS_VISIBLE_FILTERS = new Set(['q', 'fit', 'appStatus']);

/** Keep the "More filters" count in step with what the panel is filtering. */
export function syncFilterSheetCount() {
  const n = [...FILTER_IDS, ...TOGGLE_IDS]
    .filter((id) => !ALWAYS_VISIBLE_FILTERS.has(id) && filterValue(id)).length;
  const button = $('btnFilterSheet');
  button.textContent = '';
  button.append('More filters');
  if (n) button.append(el('span', { class: 'n', 'aria-label': `${n} active`, text: String(n) }));
}

/* Dialog submit-on-Enter is the <form> itself now — see the submit listener. */

/* Master resume upload — the hidden picker is opened by the visible button. */
$('masterFile').addEventListener('change', (event) => {
  uploadMasterResume(event.target.files?.[0]);
});
$('letterFile').addEventListener('change', (event) => {
  uploadMasterLetter(event.target.files?.[0]);
});

/* ───────────────────────────── boot ───────────────────────────── */

/**
 * Publish the topbar's live height so sticky things can sit below it.
 *
 * The topbar is sticky and opaque, and it wraps to two rows around 1280px and
 * three on a phone. Anything else that sticks has to know how tall it currently
 * is — a constant is wrong at two of those three widths, which is how the
 * column headers ended up parked underneath it.
 */
export const topbarEl = document.querySelector('.topbar');
export function syncTopbarHeight() {
  const h = Math.round(topbarEl.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}
new ResizeObserver(syncTopbarHeight).observe(topbarEl);
syncTopbarHeight();


export const savedTheme = readPreference('theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme;
}

/**
 * Name the theme toggle by where it GOES ("Switch to dark theme"), from the
 * theme actually showing — which, until the user picks one, is the OS's. The
 * icon follows in CSS; only the words need script.
 */
export function syncThemeControl() {
  const current = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const label = `Switch to ${current === 'light' ? 'dark' : 'light'} theme`;
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}
syncThemeControl();
// Who the dashboard is searching as: the header's initials and the Profile
// menu's switcher. Not awaited — the board must never wait on it.
loadProfiles().then(announcePendingSwitch);
loadFeatures();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', syncThemeControl);

export function jobIdFromHash() {
  const match = location.hash.match(/^#job=(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

// Back/forward between jobs now works (the old build wrote the hash but never
// listened for changes).
window.addEventListener('hashchange', () => {
  const id = jobIdFromHash();
  if (id && id !== state.selectedId) selectJob(id, { user: true });
});

// Restore the view preferences, validating both against the offered choices so
// a stale or hand-edited value can never put the board in an unreachable state.
export const savedSort = readPreference('sort');
if (savedSort && Object.hasOwn(SORT_DIRECTION, savedSort)
  && document.querySelector(`th.sortable[data-sort="${savedSort}"]`)) {
  state.sort = savedSort;
}
export const savedPageSize = readPreference('pageSize');
if (savedPageSize && [...$('pageSize').options].some((o) => o.value === savedPageSize)) {
  $('pageSize').value = savedPageSize;
} else if (window.innerWidth <= 860) {
  // First run on a narrow screen. A row is a table row on a desktop and a
  // ~137px card on a phone, so the same 100 rows are ~7,000px there and
  // ~15,000px here — eighteen screens of scrolling to reach the end of one
  // page. This only sets the STARTING point when nothing has been chosen; a
  // saved preference always wins.
  $('pageSize').value = '50';
}
state.pageSize = Number($('pageSize').value) || 100;
if (readPreference('analyticsOpen') === '1') {
  $('analytics').hidden = false;
  $('btnAnalytics').setAttribute('aria-expanded', 'true');
  $('btnAnalytics').querySelector('.caret').textContent = '▾';
}
SHEET_QUERY.addEventListener('change', placeDetail);

// Find jobs' glass catches the light where the pointer is. Only with a mouse
// and only for people who have not asked for less motion; the CSS keeps a
// fixed highlight otherwise. `--gx` is registered as non-inheriting, so
// moving it restyles the capsule, not the menu inside it.
{
  const glass = document.querySelector('.split.menu');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  glass?.addEventListener('pointermove', (event) => {
    if (!fine.matches || still.matches || event.target.closest('.menu-pop')) return;
    const r = glass.getBoundingClientRect();
    glass.style.setProperty('--gx', `${Math.round(((event.clientX - r.left) / r.width) * 100)}%`);
  });
  glass?.addEventListener('pointerleave', () => glass.style.removeProperty('--gx'));
}
placeDetail();
// Today is the landing view unless the user last chose the board.
state.appsLayout = readPreference('appsLayout') === 'list' ? 'list' : 'kanban';
installWorkspaceDrag();
installPalette(dispatchAction);
setView(['board', 'applications'].includes(readPreference('view')) ? readPreference('view') : 'today', { save: false });
applyViewPrefs();
renderTabs();
syncSortIndicator();
refreshAll({ force: true }).then(() => {
  const initial = jobIdFromHash();
  if (initial) selectJob(initial);
});
// The profile pill is an extra: fetched once the page is idle, not on the
// critical path, and again only when a dialog or an auto-fill run changes it.
(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(() => {
  loadProfileFlag();
  // The doctor spawns Python and probes the browser, so it waits for idle too.
  loadHealthChecks();
});
pollRun();
scheduleBackgroundRefresh();
syncSelectionBar();
