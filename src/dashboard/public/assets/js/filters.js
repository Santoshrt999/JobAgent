/** Board filters: reading, writing, chips, reset, and the query they produce. */

import { $, el, toast } from './dom.js';
import { FILTER_IDS, state, TOGGLE_IDS } from './state.js';
import { renderTabs } from './analytics.js';
import { loadBoard } from './board.js';
import { setView } from './today.js';
import { syncBoardSearchAction } from './actions.js';
import { hasActiveFilters, savePreference, syncFilterSheetCount, syncSortIndicator } from './main.js';

/* ── one accessor per filter kind ─────────────────────────────────────────
 * Filters are read, written, cleared, counted, and chipped through these three
 * helpers alone. Each control kind (text box, select, checkbox, segmented
 * switch) is handled in exactly one place, so adding or restyling a filter
 * cannot leave one of the five behaviours behind — which is how the posting-age
 * control could previously be set but never appear as a chip.
 */
export function filterValue(id) {
  const node = $(id);
  return node.type === 'checkbox' ? (node.checked ? 'true' : '') : node.value.trim();
}

export function setFilterValue(id, value) {
  const node = $(id);
  if (node.type === 'checkbox') node.checked = Boolean(value) && value !== 'false';
  else node.value = value == null ? '' : String(value);
  if (id === 'postedWithinHours') syncSegments();
}

export function clearFilter(id) {
  setFilterValue(id, id === 'postedWithinHours' ? '' : '');
}

/** Reflect the hidden posting-age value on its segmented buttons. */
export function syncSegments() {
  const current = $('postedWithinHours').value;
  for (const button of document.querySelectorAll('[data-action="set-posted"]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === current && current !== ''));
  }
}

/**
 * Which sort direction each board sort actually applies, for aria-sort.
 *
 * This doubles as the allow-list boot validates a saved sort against, so a sort
 * missing here is silently discarded on reload. `discovered` (the "Found"
 * column) was absent while the server supported it, which made it the only
 * column whose sort did not survive a refresh — and it is the one the
 * run-result flow sends you to, to see what a run actually turned up.
 */
export const SORT_DIRECTION = {
  score: 'descending', posted: 'descending', company: 'ascending',
  updated: 'descending', discovered: 'descending',
};

export const TABS = [
  ['all', 'All jobs', false],
  // "Priority", not "Today": the landing view is called Today now, and two
  // different things wearing one name is how a count stops being trusted.
  ['today', 'Priority', true],
  ['best', 'Best matches', false],
  ['shortlisted', 'Shortlisted', false],
  // The way back from Archive: before this tab, archived jobs were only in the
  // status dropdown, so there was no visible place to find and restore them.
  ['archived', 'Archived', false],
  ['needs_review', 'Needs review', true],
  ['ready_apply', 'Ready to apply', true],
  ['needs_you', 'Needs you', true],
  ['submitted', 'Submitted', false],
];

/** The application stages: the Applications view shows these, Jobs the rest. */
export const APP_TABS = TABS.filter(([key]) => ['needs_review', 'ready_apply', 'needs_you', 'submitted'].includes(key));
/** Application stages, plus `blocked`: next actions still deep-link to that narrower view. */
export const APP_TAB_KEYS = new Set([...APP_TABS.map(([key]) => key), 'blocked']);

/* ─────────────────────── filters + query ─────────────────────── */

export function filterParams({ forCount = false } = {}) {
  const p = new URLSearchParams();
  if (state.activeTab && state.activeTab !== 'all') p.set('view', state.activeTab);
  for (const id of FILTER_IDS) {
    const value = filterValue(id);
    if (value) p.set(id, value);
  }
  if ($('remoteOnly').checked) p.set('remote', 'true');
  if ($('sponsorshipGated').checked) p.set('sponsorshipGated', 'true');
  if ($('undated').checked) p.set('undated', 'true');
  // The API speaks hideClosed; the UI asks the question the positive way round.
  p.set('hideClosed', String(!$('includeClosed').checked));
  // Jobs is for deciding what to apply to next: jobs already applied to live
  // in Applications. "Closed jobs" brings them back with everything else.
  if (state.view !== 'applications' && !$('includeClosed').checked) p.set('hideApplied', 'true');
  p.set('sort', state.sort);
  // Scope every board read to the active mode. Omitted for 'profile' because
  // that is the server's default too, so an older client and a newer server
  // agree on what an unscoped request means.
  // Applications are a RECORD of your own work, so that view reads every
  // search, as the Applications board, the exports and the stats' application
  // counts do. A job prepared from a role search no longer vanishes from the
  // list the moment you leave that search.
  const applications = state.view === 'applications';
  if (applications) p.set('discoveryMode', 'all');
  else if (state.discoveryMode === 'role_search') {
    p.set('discoveryMode', 'role_search');
    if (state.roleQuery) p.set('searchQuery', state.roleQuery);
  }
  if (!forCount) {
    p.set('limit', String(state.pageSize));
    p.set('page', String(state.page));
    // Only worth computing when the tab counts in /api/stats would NOT already
    // be exactly right — otherwise this is eight predicate passes over the
    // corpus for an answer we already have.
    //
    // Two cases need them. A filter narrowing the board is the obvious one. The
    // other is role-search mode: /api/stats describes the PERSONALIZED board,
    // so while the board is showing a role search the badges were counting a
    // different set of rows than the tabs would open — the same
    // "count doesn't match what clicking it opens" fault the board's own
    // filters were built to prevent.
    if (hasActiveFilters() || (!applications && state.discoveryMode === 'role_search')) {
      p.set('withViewCounts', 'true');
    }
  }
  return p;
}

/** Labels for the checkbox filters, used by both the chips and the badge. */
export const TOGGLE_LABELS = {
  remoteOnly: 'Remote only',
  sponsorshipGated: 'Needs sponsor check',
  undated: 'Posting date unknown',
  includeClosed: 'Including closed jobs',
};

/**
 * Field names for the chips of the selects inside "More filters". Their option
 * text is deliberately terse ("Likely", "Contract"), which reads as a mystery
 * chip once the panel is closed, so the chip names the field too. The primary
 * selects need no prefix — "Strong fit" and "Posted < 3h ago" say it already.
 */
export const FIELD_LABELS = {
  sponsorship: 'Sponsorship', employmentType: 'Job type', source: 'Source',
  ats: 'ATS', resumeStatus: 'Resume', state: 'Location',
};

/**
 * Render a posting-age window the way the button that set it is labelled.
 * Without this a week reads as "168h", which no one thinks in.
 */
export function humanizeHours(value) {
  const h = Number(value);
  if (!Number.isFinite(h)) return `${value}`;
  if (h % 168 === 0) return h === 168 ? '1 week' : `${h / 168} weeks`;
  if (h % 24 === 0) return h === 24 ? '24 hours' : `${h / 24} days`;
  return `${h} hours`;
}

/** Chip text for filters that are not <select>s (no option label to borrow). */
export const VALUE_LABELS = {
  postedWithinHours: (value) => `Posted < ${humanizeHours(value)} ago`,
  city: (value) => `City: ${value}`,
};

/**
 * Every active filter (not the tab) as [id, label], in the words the chip row
 * shows. The email draft describes its scope with the same labels.
 */
export function activeFilterChips() {
  const chips = [];
  const labelFor = (id) => {
    const node = $(id);
    const option = node.selectedOptions?.[0];
    return option ? option.textContent.trim() : node.value;
  };
  for (const id of FILTER_IDS) {
    const value = filterValue(id);
    if (!value) continue;
    if (id === 'q') chips.push([id, `“${value}”`]);
    else if (VALUE_LABELS[id]) chips.push([id, VALUE_LABELS[id](value)]);
    else chips.push([id, FIELD_LABELS[id] ? `${FIELD_LABELS[id]}: ${labelFor(id)}` : labelFor(id)]);
  }
  for (const [id, label] of Object.entries(TOGGLE_LABELS)) {
    if ($(id).checked) chips.push([id, label]);
  }
  return chips;
}

/** Human-readable chips for every active filter, each individually clearable. */
export function renderActiveFilters() {
  const host = $('activeFilters');
  host.textContent = '';
  const chips = [];
  // The tab is a scope like any other, and now that filters stack on top of it
  // the chip row is the one place that shows the WHOLE scope in one line.
  // Without it, "12 results" inside Needs review looks like 12 results overall.
  if (state.activeTab !== 'all') {
    const tab = TABS.find(([key]) => key === state.activeTab);
    if (tab) {
      host.append(el('span', { class: 'pill pill-scope' }, `In: ${tab[1]}`,
        el('button', { 'data-action': 'clear-tab', 'aria-label': `Leave the ${tab[1]} tab`, text: '✕' })));
    }
  }
  for (const id of FILTER_IDS) {
    if ($(id).tagName === 'SELECT') $(id).classList.toggle('on', Boolean(filterValue(id)));
  }
  chips.push(...activeFilterChips());

  syncFilterSheetCount();
  // Every path that writes the query without an `input` event lands here —
  // Reset, "Clear all", dismissing the search chip, a restored URL, a metric
  // tile applying a filter object. One call at the single point they all share
  // beats remembering to add one to each of them.
  syncBoardSearchAction();

  for (const [id, label] of chips) {
    host.append(el('span', { class: 'pill' }, label,
      el('button', { 'data-action': 'clear-filter', 'data-filter': id, 'aria-label': `Clear filter ${label}`, text: '✕' })));
  }
  if (chips.length > 1) {
    host.append(el('button', { class: 'small ghost', 'data-action': 'reset-filters', text: 'Clear all' }));
  }
}

export function resetFilters({ keepTab = false, silent = false } = {}) {
  if (!keepTab) state.activeTab = 'all';
  for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);
  state.sort = 'score';
  savePreference('sort', state.sort);
  syncSortIndicator();
  state.page = 1;
  renderTabs();
  // `silent` is for callers that are mid-transition and will refresh once
  // themselves — switching board modes clears filters AND changes scope, and
  // refreshing here would fetch the old scope with the new filters first.
  if (!silent) loadBoard();
}

/** Apply a metric/next-action filter object. Honors EVERY key it is given. */
export function applyFilterObject(filter = {}) {
  state.activeTab = 'all';
  for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);

  // A filter naming a closed status must reveal closed rows, or it shows zero.
  const CLOSED = ['rejected', 'archived', 'discarded'];
  for (const [key, value] of Object.entries(filter)) {
    if (value === null || value === undefined) continue;
    if (key === 'view') {
      // A curated tab IS the filter (its badge counts the same predicate), so
      // next actions whose count spans several statuses can point at one.
      state.activeTab = String(value);
      continue;
    }
    if (key === 'appStatus') {
      const select = $('appStatus');
      // Guard against a status the select does not offer: silently falling back
      // to "" used to show the WHOLE board instead of the requested subset.
      if ([...select.options].some((o) => o.value === value)) select.value = value;
      else toast(`No filter exists for status "${value}"`, 'bad');
      if (CLOSED.includes(value)) setFilterValue('includeClosed', true);
    } else if (key === 'last24h') setFilterValue('postedWithinHours', value ? '24' : '');
    else if (key === 'postedWithinHours') setFilterValue('postedWithinHours', value);
    else if (key === 'remote') setFilterValue('remoteOnly', value);
    else if (key === 'sponsorshipGated') setFilterValue('sponsorshipGated', value);
    else if (key === 'undated') {
      setFilterValue('undated', value);
      // Undated rows are exactly where the freshness gate parked them, so they
      // are only reachable with closed jobs in scope — but only when the filter
      // is actually being switched ON.
      if (value) setFilterValue('includeClosed', true);
    } else if (key === 'includeClosed' || key === 'hideClosed') {
      setFilterValue('includeClosed', key === 'hideClosed' ? !value : value);
    } else if (FILTER_IDS.includes(key)) setFilterValue(key, value);
  }
  state.page = 1;
  renderTabs();
  setView('board');
  loadBoard();
}
