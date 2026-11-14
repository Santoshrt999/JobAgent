/** The one mutable page state object, and the filter control ids. */

/* ───────────────────────────── state ───────────────────────────── */


export const state = {
  activeTab: 'all',
  page: 1,
  pageSize: 100,
  sort: 'score',
  selectedId: null,
  // Set by a view switch: the next list to load re-syncs the detail rail.
  syncDetail: false,
  /** @type {Set<string>} */
  selected: new Set(),
  /** id -> row, for every row seen this session (batch actions need off-page rows) */
  known: new Map(),
  /** ids rendered on the current page, in order (keyboard nav + select-all) */
  visible: [],
  stats: null,
  running: false,
  serverUp: null,
  detailJob: null,
  /** Last /api/run/status payload, so the details panel needs no extra fetch. */
  lastRunStatus: null,
  /** Per-tab counts under the ACTIVE filters; null when no filter is set. */
  filteredViewCounts: null,
  /** finishedAt of a result the user dismissed; a newer run reappears. */
  runDismissedAt: null,
  /*
   * WHICH SEARCH THE BOARD IS SHOWING — 'profile' or 'role_search'.
   *
   * 'profile' is the personalized board and the default everywhere. A role
   * search never changes it; it opens its OWN list, scoped to one query, which
   * is why the query is held alongside the mode rather than in the text filter.
   * Using the text filter for this was the original leak: it made role-search
   * rows look like personalized rows that happened to match a string.
   */
  discoveryMode: 'profile',
  roleQuery: null,
  /** Last link-check result per job id, so a re-render does not erase it. */
  linkHealth: new Map(),
  /** Why the last Prepare of a job failed, by job id, until a later Prepare succeeds. */
  prepareFailures: new Map(),
  /** The template notice's items as last rendered (JSON), so a change redraws the open job. */
  templatedItems: undefined,
  /** Rewrite suggestions per job id (GET /api/jobs/:id/rewrites), and whether the feature is on. */
  rewrites: new Map(),
  rewritesEnabled: null,
  /** Document versions per job id (GET /api/jobs/:id/versions). */
  versions: new Map(),
  /** 'today' (the action queue), 'board' (Jobs) or 'applications'. */
  view: 'today',
  /** Last /api/today payload (or its derived fallback). */
  today: null,
  /** Tool-level blockers from /api/today, e.g. browser_unavailable. */
  systemNotices: [],
  /** True while the automation browser is missing: every Auto-fill waits. */
  browserUnavailable: false,
  /** Applications view layout: 'kanban' (the workspace board) or 'list' (stage tabs). */
  appsLayout: 'kanban',
  /** True while the Applications view was reached by a deep link to one stage. */
  appsDeepLink: false,
  /** Last /api/applications payload. */
  workspace: null,
  /** Last /api/health (doctor) payload, fetched once when idle. */
  health: null,
};

export const FILTER_IDS = [
  'q', 'fit', 'appStatus', 'postedWithinHours', 'state', 'city',
  'sponsorship', 'employmentType', 'source', 'ats', 'resumeStatus',
];
/**
 * Checkbox filters. Every one is OFF by default, including `includeClosed`:
 * "Hide closed ✓" was a checked-by-default double negative that read as an
 * active filter you had to UNcheck, and its pill said the opposite of its label.
 */
export const TOGGLE_IDS = ['remoteOnly', 'sponsorshipGated', 'undated', 'includeClosed'];
