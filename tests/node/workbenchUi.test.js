import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

import { POSTED_WINDOWS } from '../../src/dashboard/data.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
// The front end is ES modules now (assets/js/*.js, entry main.js). The
// assertions below are about the shipped code as a whole, so they read every
// module; each function still lives whole in one file, so slices between two
// function names stay within that file.
const jsDir = new URL('../../src/dashboard/public/assets/js/', import.meta.url);
const app = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => readFileSync(new URL(f, jsDir), 'utf8')).join('\n');

describe('dashboard shell structure', () => {
  it('exposes every element id the application script binds to', () => {
    // If markup and script drift apart the UI silently half-renders, so the
    // contract between them is asserted directly.
    for (const id of [
      'health', 'tabs', 'rows', 'pager', 'detail', 'nextActions', 'activeFilters',
      // `dailyTrend` replaced the `dailyRows` table: the daily figures are a
      // time series across three measures of wildly different magnitude, which
      // is small multiples, not four columns of numbers.
      'srcRows', 'sponRows', 'stateRows', 'blockRows', 'dailyTrend',
      'selbar', 'selCount', 'selAll', 'toasts', 'conn', 'runStatus', 'offline',
      'btnDiscover', 'btnPrepare', 'btnCancel', 'autoApplyBtn', 'cmpBtn',
      // The board region the tabs control and the skip link targets.
      'boardwrap', 'filterbar', 'boardAnnounce',
      // View preferences: density + columns.
      'viewMenu', 'columnToggles',
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('declares every filter control the script reads', () => {
    for (const id of [
      'q', 'fit', 'appStatus', 'postedWithinHours', 'state', 'city',
      'sponsorship', 'employmentType', 'source', 'ats',
      'resumeStatus', 'remoteOnly', 'sponsorshipGated', 'undated',
      'includeClosed', 'pageSize',
    ]) {
      expect(html, `missing filter #${id}`).toContain(`id="${id}"`);
    }
  });

  it('offers location filtering, with state populated from real data', () => {
    // State is a closed list built from the states that actually have jobs
    // (stats.byState), so it can never offer one that returns nothing. City
    // stays free text: real postings spell the same place "Austin, TX",
    // "Austin, Texas" and "USA - Austin, TX", so no closed list would hold.
    expect(html).toContain('id="state"');
    expect(html).toContain('id="city"');
    expect(app).toContain('function populateStates');
    expect(app).toContain('stats.byState');
    // 'US' (national/remote) and 'unknown' are not states and must not be
    // offered as ones — Remote has its own dedicated entry.
    expect(app).toContain("code !== 'US' && code !== 'unknown'");
    expect(html).toContain('value="REMOTE"');
  });

  it('debounces the city box on input, like the search box', () => {
    // A bare `change` listener fires only on blur/Enter, which reads as the
    // filter being broken while you are still typing in it.
    expect(app).toContain('DEBOUNCED_TEXT_FILTERS');
    expect(app).toContain("['q', 'city']");
  });

  it('asks about closed jobs positively, with every checkbox filter off by default', () => {
    // "Hide closed ✓" was a checked-by-default double negative: it read as an
    // active filter you had to UNcheck, and its own chip said the opposite.
    expect(html).toContain('id="includeClosed"');
    expect(html).toContain('Closed jobs<');
    expect(html).not.toContain('id="hideClosed"');
    expect(html).not.toMatch(/<input type="checkbox" id="\w+" checked>/);
    // The API still speaks hideClosed; the UI just inverts it at the boundary.
    expect(app).toContain("p.set('hideClosed', String(!$('includeClosed').checked))");
  });

  it('moves rows-per-page out of the filters and into the pager', () => {
    // Page size changes how MUCH of a result set you see, never which jobs
    // match, so it does not belong among the filters.
    const pagerBar = html.slice(html.indexOf('class="pagerbar"'), html.indexOf('class="analytics"'));
    expect(pagerBar).toContain('id="pageSize"');
    const filterBar = html.slice(html.indexOf('class="filterbar"'), html.indexOf('id="activeFilters"'));
    expect(filterBar).not.toContain('id="pageSize"');
  });

  it('offers posting age as a segmented switch, not a dropdown', () => {
    // Mutually exclusive choices belong on one row where each is visible and
    // one click away, and where clicking the active one clears it — a <select>
    // hid them behind a click and needed an extra "any date" option.
    expect(html).toContain('id="postedWithinHours"');
    expect(html).toContain('class="seg"');
    expect(html).not.toContain('id="last24h"');
    expect(app).toContain("'set-posted'");
    expect(app).toContain('function syncSegments');
    // Clicking the active segment clears it.
    expect(app).toContain("filterValue('postedWithinHours') === target.dataset.value ? '' : target.dataset.value");
  });

  it('offers the windows the filter actually honors — including a week', () => {
    // The button values and POSTED_WINDOWS must not drift: a chip offering a
    // window the filter ignores would look active over an unfiltered board.
    // A week matters because that is where the jobs are — one measured run had
    // 5 postings under 24h old and 4,439 under a week.
    const offered = [...html.matchAll(/data-action="set-posted"\s+data-value="(\d+)"/g)]
      .map((m) => Number(m[1]));
    expect(offered).toEqual(expect.arrayContaining([3, 6, 24, 72, 168]));
    for (const v of offered) expect(POSTED_WINDOWS).toContain(v);
  });

  it('labels a week as a week, not as 168h', () => {
    expect(app).toContain('function humanizeHours');
    expect(app).toContain('humanizeHours(value)');
  });

  it('reads, writes, and clears every filter through one set of accessors', () => {
    // Five behaviours (query string, chip, reset, tile-applied filters, active
    // highlighting) used to each poke at the DOM their own way, so a control
    // that was not a <select> or checkbox could be set but never chipped.
    for (const fn of ['function filterValue', 'function setFilterValue', 'function clearFilter']) {
      expect(app).toContain(fn);
    }
    expect(app).toContain('for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);');
    expect(app).not.toMatch(/\$\((?:id|key)\)\.value = /);
  });

  it('keeps every filter inline in three aligned rows, with no popover at all', () => {
    // A dropdown pane covered the very rows it had just filtered, hid its own
    // active state behind a count badge, and needed open/close/outside-click/
    // Escape/clear/done plumbing to be usable. Visible rows need none of it.
    for (const row of ['frow-find', 'frow-refine', 'frow-only']) {
      expect(html, `missing row ${row}`).toContain(row);
    }
    for (const gone of ['id="moreFilters"', 'id="moreFiltersPanel"', 'id="moreFiltersCount"',
      'toggle-more-filters', 'close-more-filters', 'clear-advanced-filters']) {
      expect(html, `"${gone}" should be gone`).not.toContain(gone);
    }
    for (const gone of ['setMoreFilters', 'closeMoreFilters', 'syncAdvancedBadge',
      'advancedFilterCount', 'ADVANCED_IDS']) {
      expect(app, `${gone}() should be gone`).not.toContain(gone);
    }
    expect(css).not.toContain('.secondary-filters');
    // Each refine select names its own field, so no labels are needed and
    // nothing has to be opened to see what is on.
    for (const placeholder of ['Any fit', 'Any status', 'Any sponsorship', 'Any job type',
      'Any source', 'Any ATS', 'Any resume']) {
      expect(html, `missing self-describing option "${placeholder}"`).toContain(`>${placeholder}<`);
    }
  });

  it('lays the refine row out as seven equal columns, so nothing is stranded', () => {
    // A wrapped flex row left single controls ("City", "Closed jobs") alone on
    // rows of their own. A grid of equal columns cannot. Location, city and
    // the five remaining selects fill the seven columns; fit and status moved
    // up to the always-visible find row.
    const refine = html.slice(html.indexOf('frow-refine'), html.indexOf('frow-posted'));
    expect((refine.match(/<select |<input id="city"/g) || []).length).toBe(7);
    const find = html.slice(html.indexOf('frow-find'), html.indexOf('filter-panel'));
    for (const id of ['id="q"', 'id="fit"', 'id="appStatus"', 'id="btnFilterSheet"']) expect(find).toContain(id);
    expect(css).toMatch(/\.frow-refine \{[^}]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
    // The grid reflows by the card's width, never into a ragged last row.
    expect(css).toContain('container-type: inline-size');
    expect(css).toMatch(/@container filters \(max-width: 820px\)[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
  });

  it('gives every filter control the same height', () => {
    const base = css.slice(css.indexOf('.filters input[type=text], .filters input[type=search], .filters select {'));
    expect(base).toMatch(/^[^}]*height: 34px/);
    expect(css).toMatch(/\.toggle \{[^}]*height: 34px/);
    expect(css).toMatch(/\.seg \{[^}]*height: 34px/);
  });

  it('keeps status in one row under the header, with the loading bar on top', () => {
    // The header reads identity -> stage tabs -> actions; everything that
    // REPORTS state (connection, the run, health) is the header's second row,
    // so a run result gets the full width instead of an ellipsis.
    const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
    expect(header.indexOf('class="stages"')).toBeLessThan(header.indexOf('class="split menu"'));
    const row = header.slice(header.indexOf('id="statusbar"'));
    for (const id of ['id="conn"', 'id="runbox"', 'id="health"']) expect(row).toContain(id);
    expect(row.indexOf('id="runbox"')).toBeLessThan(row.indexOf('class="spacer"'));
    // The loading bar runs along the very top edge of the window.
    expect(header).toContain('id="runline"');
    expect(css).toContain('.topbar .runline { top: 0;');
    // The run panel opens downward from the status row.
    expect(css.slice(css.indexOf('.run-details {'))).toMatch(/^\s*position: absolute; top: calc\(100% \+ 8px\); left: 0;/m);
  });

  it('offers a status filter option for every status the app can surface', () => {
    // A next-action linking to a status with no matching <option> silently
    // cleared the filter and showed the whole board instead.
    for (const status of [
      'discovered', 'scored', 'shortlisted', 'needs_review', 'approved',
      'ready_for_submit', 'submit_unverified', 'blocked', 'failed', 'cancelled',
      'skipped', 'submitted', 'rejected', 'archived', 'discarded', 'date_unconfirmed',
    ]) {
      expect(html, `no status option for "${status}"`).toContain(`<option value="${status}">`);
    }
  });

  it('keeps the primary workflow reachable from the shell', () => {
    // One primary button on the header; its siblings live in the split menu.
    for (const label of ['>Find jobs<', 'Find jobs and prepare packets', 'Add a job by URL']) {
      expect(html).toContain(label);
    }
    for (const id of ['id="btnDiscover"', 'id="btnPrepare"', 'id="btnAddUrl"']) expect(html).toContain(id);
    for (const action of [
      'batch-autofill', 'batch-prepare', 'batch-approve', 'batch-decide', 'compare',
    ]) {
      expect(html).toContain(`data-action="${action}"`);
    }
  });

  it('links its stylesheet and module script rather than inlining them', () => {
    expect(html).toContain('<link rel="stylesheet" href="/assets/css/app.css">');
    expect(html).toContain('<script type="module" src="/assets/js/main.js"></script>');
  });
});

describe('no inline event handlers or inline styles', () => {
  it('uses delegated data-action wiring, never on* attributes', () => {
    // Inline handlers were how a job id containing an apostrophe could break a
    // row or execute as script; they also force script-src 'unsafe-inline'.
    const inlineHandlers = html.match(/\son[a-z]+\s*=/gi) ?? [];
    expect(inlineHandlers).toEqual([]);
    expect(html).toContain('data-action=');
  });

  it('keeps markup free of style attributes', () => {
    expect(html.match(/\sstyle="/g) ?? []).toEqual([]);
  });

  it('never interpolates a job id into executable text', () => {
    // Ids travel as data-id attributes and are read back via dataset. Comments
    // are stripped first so prose ABOUT the old pattern does not trip this.
    const code = app
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\bon(?:click|change|input|submit)\s*=/);
    expect(code).not.toMatch(/setAttribute\(\s*['"]on/);
    expect(app).toContain("'data-id': job.id");
    expect(app).toContain('target.dataset.id');
  });
});

describe('safety guarantees are preserved in the UI', () => {
  it('ordinary Auto-fill never requests a final submit', () => {
    expect(app).toContain('/api/assist-batch');
    // The advanced auto-submit endpoint must not be reachable from this UI.
    expect(app).not.toContain('/api/auto-submit-batch');
    expect(app).not.toContain('autoSubmit: true');
    expect(app).toMatch(/stops before Submit/i);
  });

  it('manual submission stays explicit and honest about verification', () => {
    expect(app).toContain('verified: Boolean(confirmation)');
    expect(app).toMatch(/pending your verification/i);
    expect(app).toMatch(/Not counted as applied/i);
  });

  it('surfaces the packet stop-before-submit guarantee for review', () => {
    expect(app).toContain('Stops before submit');
    expect(app).toContain('submit-ready flag');
  });

  it('escapes untrusted values used in class names', () => {
    expect(app).toContain('function esc(value)');
  });
});

describe('board pagination and reconciliation', () => {
  it('renders the real match total, not just the returned page', () => {
    // The board previously showed the API's default 200-row cap while the tab
    // badges counted every match, hiding ~1,400 jobs with no indication.
    expect(app).toContain('function renderPager');
    expect(app).toContain('Showing ');
    expect(app).toContain("p.set('page'");
    expect(app).toContain("p.set('limit'");
  });

  it('offers page navigation controls', () => {
    for (const label of ['First page', 'Previous page', 'Next page', 'Last page']) {
      expect(app).toContain(`'aria-label': '${label}'`);
    }
    expect(app.match(/'data-action': 'page'/g)).toHaveLength(4);
  });

  it('clears manual filters when a tab scope is chosen so counts agree', () => {
    expect(app).toContain("'set-tab'");
    expect(app).toContain('renderTabs();');
  });
});

describe('master resume management', () => {
  it('gives the master resume its own screen, reachable from the places it matters', () => {
    expect(html).toContain('id="dlgMaster"');
    expect(html).toContain('id="masterBody"');
    // From the menu, from the Resume library, and from a job with no resume yet.
    expect(html).toContain('data-action="open-master"');
    expect(app).toContain("'open-master'");
    expect(app.match(/'data-action': 'open-master'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('supports viewing the real contents, downloading to edit, and uploading back', () => {
    expect(app).toContain("api('/api/master-resume')");
    expect(app).toContain("href: '/api/master-resume/file'");
    expect(app).toContain("postJson('/api/master-resume'");
    expect(app).toContain('Download to edit');
    // A .docx-only picker, opened by a real button rather than a bare input.
    expect(html).toContain('id="masterFile"');
    expect(html).toContain('accept=".docx');
    expect(app).toContain("'pick-master-file'");
  });

  it('keeps replacement reversible and says so', () => {
    expect(app).toContain("postJson('/api/master-resume/restore'");
    expect(app).toContain("'restore-master'");
    expect(app).toMatch(/previous version kept/i);
    // The read-only guarantee is stated where the file is managed.
    expect(html).toContain('Opened read-only');
  });

  it('warns when the master is missing or unreadable instead of failing silently', () => {
    expect(app).toContain('No master resume yet.');
    expect(app).toContain('master.textError');
    expect(app).toContain('stalePackets');
  });
});

describe('accessibility', () => {
  it('makes board rows keyboard operable', () => {
    // One roving tab stop for the whole board (BUG-12), moved by arrows and j/k.
    expect(app).toContain("tabindex: '-1'");
    expect(app).toContain('export function setRowTabStop(row)');
    expect(app).toContain("event.key === 'j'");
    expect(app).toContain("event.key === 'Enter'");
    expect(app).toContain("event.key === 'ArrowDown'");
  });

  it('uses native dialogs so Escape, focus trapping, and backdrop work', () => {
    expect(html).toMatch(/<dialog id="dlgResume"/);
    expect(html).toMatch(/<dialog id="dlgSubmit"/);
    expect(html).toMatch(/<dialog id="dlgAddUrl"/);
    expect(app).toContain('showModal()');
    expect(app).toContain('lastFocused');
  });

  it('lets the native resume dialog become hidden again after close', () => {
    expect(css).not.toMatch(/#dlgResume\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/#dlgResume\[open\]\s*\{[^}]*display:\s*flex/);
  });

  it('reloads the selected job after a re-tailor refresh', () => {
    expect(app).toMatch(/async function refreshAll\([^)]*\)[\s\S]*if \(state\.selectedId\) await selectJob\(state\.selectedId\)/);
  });

  it('marks up tabs and live regions for assistive tech', () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-live="polite"');
    expect(app).toContain("role: 'tab'");
    expect(app).toContain("'aria-selected'");
  });

  it('honors reduced-motion and provides visible focus', () => {
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain(':focus-visible');
  });
});

describe('theme and responsive design', () => {
  it('supports an explicit light theme alongside the default dark one', () => {
    expect(css).toContain(':root[data-theme="light"]');
    expect(app).toContain("savePreference('theme', next)");
    expect(app).toContain("localStorage.setItem(`jobagent-${key}`");
  });

  it('remembers view preferences but never restores hidden filters', () => {
    // Reopening a board that is silently narrowed reads as lost data; the
    // ordering and row count you chose are just the tool remembering you.
    expect(app).toContain("savePreference('sort'");
    expect(app).toContain("savePreference('pageSize'");
    for (const id of ['fit', 'appStatus', 'sponsorship', 'includeClosed']) {
      expect(app, `filter #${id} must not be persisted`).not.toContain(`savePreference('${id}'`);
    }
    // A stale or hand-edited value must not strand the board in a state the
    // controls cannot reach.
    expect(app).toContain('Object.hasOwn(SORT_DIRECTION, savedSort)');
    expect(app).toContain(".options].some((o) => o.value === savedPageSize)");
  });

  it('collapses to a single column on narrow viewports', () => {
    expect(css).toContain('@media (max-width: 1240px)');
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
  });
});

describe('the top pane states things once', () => {
  it('keeps three views in the header and each view\'s stages inside it', () => {
    // Eight stage tabs in the header wrapped it onto a second line below
    // ~1500px. The header now carries Today / Jobs / Applications; the stage
    // tabs sit in the board view they scope. Health stays in the status row.
    const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
    expect(header).not.toContain('id="tabs"');
    for (const view of ['today', 'board', 'applications']) expect(header).toContain(`data-view="${view}"`);
    expect(header).toContain('id="health"');
    const board = html.slice(html.indexOf('id="boardView"'), html.indexOf('id="filterbar"'));
    expect(board).toContain('id="tabs"');
    expect(html).not.toContain('class="pipeline"');
    expect(html).not.toContain('class="metrics"');
  });

  it('never shows a number the tabs already carry', () => {
    // "awaiting approval" == Needs review, "ready to submit" == Ready to apply,
    // "submitted" == Submitted. Duplicating them is what made the top busy.
    const facts = app.slice(app.indexOf('const HEALTH_FACTS'), app.indexOf('function statNode'));
    for (const duplicated of ['pendingReview', 'readyForSubmit', 'submittedTotal']) {
      expect(facts, `${duplicated} duplicates a tab`).not.toContain(duplicated);
    }
    // What remains is what changed and what is worth a look; corpus size and
    // coverage moved to the Discovery and data quality dialog.
    for (const kept of ['postedLast7d', 'strongFit']) expect(facts).toContain(kept);
    for (const moved of ['jobsTracked', 'discoveredLast24h', 'postedLast24h']) {
      expect(facts, `${moved} belongs in the data-quality dialog`).not.toContain(`key: '${moved}'`);
    }
  });

  it('shows attention flags only when they are non-zero and nothing else shows them', () => {
    const flags = app.slice(app.indexOf('const HEALTH_FLAGS'), app.indexOf('function statNode'));
    for (const key of ['submitUnverified', 'undatedDropped']) {
      expect(flags).toContain(key);
    }
    // The sponsor check is a Next-up rail action; a flag too showed 386 twice.
    expect(flags).not.toMatch(/key: 'needsSponsorshipCheck'/);
    expect(app).toContain("if ((stats.totals[flag.key] ?? 0) === 0) continue;");
  });

  // REGRESSION: statNode used `stats.totals[key] ?? 0`, which renders a stat
  // key MISSING from the server's response identically to a real computed
  // zero. This is exactly how a long-running dashboard server process
  // (started before a new stat field was added — Node does not hot-reload
  // edited source) can display an impossible state: "4 posted 24h, 0 posted
  // 1w" is a contradiction (24h is a strict subset of 1w), and the "0" there
  // was never actually computed — the field just didn't exist yet in that
  // process's in-memory code. An honest "—" makes the gap visible instead of
  // silently masquerading as data.
  it('renders a stat tile as "—", not a fabricated "0", when the key is missing from the response', () => {
    const fn = app.slice(app.indexOf('function statNode'), app.indexOf('function renderHealth'));
    expect(fn).not.toContain('stats.totals[key] ?? 0');
    expect(fn).toContain("typeof raw === 'number'");
    expect(fn).toContain("'n/a'");
  });

  // REGRESSION: stats/board were only ever refetched in reaction to a user
  // action (approve/reject/note/a run finishing). A tab left open while a
  // SEPARATE process changed the database (a `npm run score` in another
  // terminal, or watch mode) had no way to notice — the two numbers on screen
  // could be from arbitrarily different moments in time, since nothing ever
  // re-synced them together. This is quiet by design: only refreshes a
  // visible, idle tab, so it never fights an in-progress run's own rendering.
  it('periodically refreshes an idle, visible tab instead of going stale forever', () => {
    expect(app).toContain('function scheduleBackgroundRefresh');
    expect(app).toContain("document.visibilityState === 'visible'");
    expect(app).toContain('!state.lastRunStatus?.running');
    expect(app).toContain('scheduleBackgroundRefresh();');
  });

  it('states nationwide coverage as data, and lets it be inspected', () => {
    // "Are we really searching every state?" has to be answerable from the UI.
    expect(app).toContain('coverage.statesCovered');
    expect(app).toContain('US states');
    expect(html).toContain('Where the jobs are');
    expect(html).toContain('id="stateRows"');
  });
});

describe('board sorting', () => {
  it('marks the column the board is actually sorted by, from state', () => {
    // Setting aria-sort on click left a stale indicator after Reset, and never
    // marked the default sort at all.
    expect(app).toContain('function syncSortIndicator');
    expect(app).toContain('SORT_DIRECTION');
    // Company sorts A–Z; the others newest/highest first. Announcing every
    // column as "descending" was simply untrue for one of them.
    expect(app).toContain("company: 'ascending'");
    expect(html).toContain('data-sort="company"');
    // Sortable headers are reachable and operable by keyboard.
    expect(html).toMatch(/<th class="sortable"[^>]*tabindex="0"/);
  });
});

describe('run state and recovery', () => {
  it('actually hides the elements the script hides', () => {
    // `button { display: inline-flex }` outranks the UA's `[hidden]` rule, so
    // <button hidden> kept rendering — "Cancel" sat in the header permanently,
    // offering to cancel a run that was not happening.
    expect(css).toContain('[hidden] { display: none !important; }');
    expect(html).toContain('id="btnCancel"');
    expect(app).toContain('cancel.hidden = !state.running;');
  });

  it('restores each run button real tooltip once the run finishes', () => {
    // The old code re-read button.title, which by then held "a run is in
    // progress", so these buttons never explained themselves again.
    expect(app).toContain('if (button.dataset.title === undefined) button.dataset.title = button.title;');
    expect(app).not.toContain('button.dataset.title ?? button.title');
  });

  it('polls run status and reloads once a run finishes', () => {
    expect(app).toContain('/api/run/status');
    expect(app).toContain('wasRunning');
    expect(app).toContain('refreshAll()');
  });

  it('supports cancelling a run and keeping finished work', () => {
    expect(app).toContain('/api/run/cancel');
    expect(app).toMatch(/finished work is kept/i);
  });

  it('reports per-source discovery progress', () => {
    expect(app).toContain('progress.currentSource');
  });

  it('gives a long run one region that owns every state', () => {
    // A discovery pass takes minutes across a dozen boards. It used to be one
    // truncated line — "discover running… 3/12 · greenhouse" clipped at 320px —
    // with no progress bar, no elapsed time, and no way to see which board was
    // slow or failing. One element now owns idle / running / ok / warn / error,
    // so the header cannot reflow as the state changes.
    expect(html).toContain('id="runbox"');
    for (const state of ['idle', 'running', 'ok', 'warn', 'error']) {
      expect(css, `no style for run state "${state}"`).toContain(`.runbox[data-state="${state}"]`);
    }
    expect(css).toContain('.runbox[data-state="idle"] { display: none; }');
  });

  it('names the run in the words the button used, not the internal phase', () => {
    expect(app).toContain('const PHASE_LABELS');
    expect(app).toContain("discover: 'Finding new jobs'");
    // "Find new jobs" is the button; "discover running…" was the old status.
    expect(app).not.toContain('running…`');
  });

  it('shows a determinate progress line, and motion only when there is no total', () => {
    expect(html).toContain('id="runline"');
    expect(css).toContain('.runline i');
    expect(css).toContain('.runline.indeterminate i');
    // A bar must not imply a fraction the server never reported.
    expect(app).toContain("line.classList.add('indeterminate')");
    // The fraction is clamped to the real ratio and cleared when there is none.
    expect(app).toContain('Math.min(1, done / total)');
    expect(app).toContain("removeProperty('--progress')");
  });

  it('animates the progress bar on the compositor, not by relayout', () => {
    // A run can span minutes, and the bar was transitioning `width` — which
    // relayouts the element on every frame. `transform` is composited, so the
    // element stays full width and is scaled instead.
    expect(css).toContain('transform: scaleX(var(--progress, 0))');
    expect(css).toContain('transition: transform .3s ease');
    expect(css).not.toMatch(/\.runline i \{[^}]*transition: width/);
    // The indeterminate keyframes must carry the scale themselves: an
    // animation's `transform` replaces the static one outright, so animating
    // translateX alone would slide a FULL-width bar across.
    const slide = css.match(/@keyframes slide \{[\s\S]*?\n\}/)[0];
    expect(slide).toContain('scaleX(.3)');
  });

  it('shows elapsed time and progress against the real total', () => {
    expect(app).toContain('function elapsedSince');
    expect(app).toContain('${progress.completed ?? 0} of ${progress.total} ${unit}');
  });

  it('surfaces the per-source breakdown and RCA the server already tracked', () => {
    // found counts, errors, duration, cached and status per board — plus the
    // structured failure explanations — had nowhere to appear, so a throttled
    // board looked exactly like one that returned nothing.
    expect(html).toContain('id="runDetails"');
    expect(html).toContain('data-action="toggle-run-details"');
    expect(app).toContain('function renderRunDetails');
    for (const field of ['item.found', 'item.errors', 'item.cached', 'item.durationMs', 'status.rca']) {
      expect(app, `run details ignore ${field}`).toContain(field);
    }
    // Dismissable, and a newer run's outcome still appears after a dismissal.
    expect(html).toContain('data-action="dismiss-run"');
    expect(app).toContain('state.runDismissedAt === finished');
  });

  it('explains WHY a source failed, not just what it cost', () => {
    // The classifier already produced a category, an HTTP status, the sanitized
    // provider message and per-category guidance. Rendering only `impact` meant
    // the panel said "16 results are missing" and never why.
    const render = app.slice(app.indexOf('function renderRunDetails'), app.indexOf('function applyRunGate'));
    for (const field of ['entry.category', 'entry.status', 'entry.message', 'entry.guidance', 'entry.impact']) {
      expect(render, `run details drop ${field}`).toContain(field);
    }
    expect(css).toContain('.run-why');
    expect(css).toContain('.run-fix');
  });

  it('groups the big counts a discovery run produces', () => {
    // "Found 14461" is materially harder to read than "Found 14,461".
    // The seen count is read once into `seen` (so "N new (all of them)" can
    // compare it with the new count) and is only ever printed through fmt().
    expect(app).toMatch(/const seen = Number\(counters\.jobs_found \?\? 0\)/);
    expect(app).toContain('fmt(seen)');
    expect(app).not.toMatch(/\$\{seen\}|\$\{counters\.jobs_found \?\? 0\}/);
  });

  it('leads the discovery summary with what was NEW, not the total seen', () => {
    // The total is dominated by already-known rows on a mature corpus, so
    // leading with it made a successful run read as "nothing happened".
    const summary = app.slice(app.indexOf("result.phase === 'discover'"));
    const newIdx = summary.indexOf('new');
    const seenIdx = summary.indexOf('seen');
    expect(summary).toContain('counters.jobs_new');
    expect(newIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(seenIdx);
  });

  it('draws the connection dot once', () => {
    // The dot became a CSS pseudo-element; leaving it in the text too rendered
    // "● ● connected".
    expect(css).toContain('.conn::before');
    expect(app).toContain("conn.textContent = up ? 'Connected' : 'Disconnected';");
    expect(html).not.toContain('●');
  });

  it('reports skipped jobs in a batch result instead of hiding them', () => {
    expect(app).toContain('skipped');
    expect(app).toContain("result.skipped ?? []");
  });

  it('shows an offline banner and recovers automatically', () => {
    expect(html).toContain('id="offline"');
    expect(app).toContain('setServerStatus');
  });
});

describe('tailored resume review', () => {
  it('gives the resume a first-class, one-click preview path', () => {
    expect(app).toContain("'preview-resume'");
    expect(app).toContain('/resume-preview');
    expect(app).toContain('resume?format=pdf');
    expect(app).toContain('resume?format=docx');
    expect(app).toContain('function resumeCard');
  });

  it('explains what changed and what was deliberately not added', () => {
    expect(app).toContain('What was changed in your resume');
    expect(app).toContain('Asked for, but not in your resume');
    expect(app).toMatch(/deliberately NOT added/);
  });

  it('reports grounded requirement-analysis provenance when present', () => {
    expect(app).toContain('llmRequirements');
    expect(app).toMatch(/found verbatim in the job description/);
  });
});

/**
 * The role is a link to the posting.
 *
 * Reaching a posting used to take two clicks and a context switch (select the
 * row, then "Open posting ↗" in the detail rail) even though every board row
 * already carried its URL — measured: 0 of 2,219 open rows lacked one.
 */
describe('job role links to the posting', () => {
  const cell = app.slice(app.indexOf('function nameCellFor'), app.indexOf('function hostLabel'));

  it('makes the role itself the link, opened safely in a new tab', () => {
    // Through safeHref: only an absolute http(s) URL ever becomes an href.
    expect(cell).toContain('safeHref(job.url)');
    expect(cell).toContain("target: '_blank'");
    // noreferrer as well as noopener: these are third-party job boards.
    expect(cell).toContain("rel: 'noopener noreferrer'");
  });

  it('marks aggregator listings instead of silently bypassing the existing warning', () => {
    // 1,061 of 2,219 open rows (48%) point at LinkedIn/Indeed/Dice rather than
    // an employer form, and the detail rail already warns about exactly that.
    // Linking every title with no marker would drop that safeguard on half the
    // board, so the source is named inline.
    expect(cell).toContain('isAggregatorUrl(job.url)');
    expect(cell).toContain("class: 'chip agg'");
    expect(cell).toContain('hostLabel(job.url)');
    expect(css).toContain('.chip.agg');
  });

  it('never renders a dead link when a row has no URL', () => {
    expect(cell).toContain("class: 'rolelink none'");
    expect(css).toContain('.rolelink.none');
    expect(css).toContain('cursor: default');
  });

  it('elides a long title rather than stretching the column', () => {
    // Real titles reach 150 characters; the cell had no width constraint, so
    // those forced the whole table to scroll sideways.
    expect(app).toContain('TITLE_MAX_CHARS');
    expect(cell).toContain('TITLE_MAX_CHARS');
    expect(css).toContain('.namecell');
    // The untruncated title stays reachable.
    expect(cell).toContain('title: aggregator');
  });

  it('leads with the role, since the board is scanned by role', () => {
    // The role used to be `.muted` — the quietest text in the cell — under a
    // bold company name.
    expect(css).toContain('.rolelink');
    expect(css).toContain('.namemeta');
    expect(cell.indexOf('rolelink')).toBeLessThan(cell.indexOf('namemeta'));
  });

  it('gives the link an accessible name that says it opens a new tab', () => {
    expect(cell).toContain('opens the posting in a new tab');
  });
});

describe('a link inside a clickable row behaves like a link', () => {
  it('never triggers the row action when a real link is clicked', () => {
    // Rows are themselves clickable (`data-action="select"`). The pre-existing
    // guard only covered anchors that carried their OWN data-action, so any
    // link that forgot one would be swallowed by the row entirely.
    expect(app).toContain("if (event.target.closest?.('a[href]')) return;");
  });

  it('lets Enter follow a focused link instead of selecting the row', () => {
    // The rows keydown handler calls preventDefault() on Enter and selects the
    // row, so a keyboard user could focus the role link and never open it.
    expect(app).toContain("if (event.key === 'Enter' && event.target.closest('a[href]')) return;");
  });
});

describe('status reason is readable, not tooltip-only', () => {
  it('renders the reason as real text rather than a bare glyph plus title=', () => {
    // WHY a job is blocked/discarded is the most useful thing in the column and
    // was reachable only by hovering a mouse over an "ⓘ".
    const fn = app.slice(app.indexOf('const statusCell'), app.indexOf('tr.append(statusCell)'));
    expect(fn).toContain("class: 'statusreason'");
    expect(fn).toContain('text: job.statusReason');
    expect(fn).not.toContain('ⓘ');
    // Clamped so a long reason cannot make rows different heights.
    expect(css).toContain('.statusreason');
    expect(css).toContain('text-overflow: ellipsis');
  });
});

describe('mutations are single-flight and dialogs submit on Enter', () => {
  it('sends the X-Job-Agent header on every non-GET, from the one api helper', () => {
    expect(app).toContain("if (method !== 'GET' && method !== 'HEAD') headers['X-Job-Agent'] = '1';");
    // No mutation bypasses it with a bare fetch.
    const code = app.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/fetch\([^)]*method:\s*'(?:POST|PUT|DELETE)'/);
  });

  it('guards mutating buttons with withBusy instead of per-handler flags', () => {
    expect(app).toContain('async function withBusy(button, fn');
    expect(app).toContain('const BUSY_ACTIONS = new Set([');
    for (const action of ['submit-add-url', 'submit-link', 'confirm-submitted', 'run', 'decide']) {
      expect(app).toContain(`'${action}'`);
    }
  });

  it('wraps each small dialog in a form whose submit is the only path to its action', () => {
    for (const action of ['submit-add-url', 'submit-job-search', 'confirm-submitted', 'submit-link', 'confirm-go']) {
      expect(html).toContain(`<form method="dialog" class="dlg-form" data-submit="${action}">`);
      // The submit button must NOT also carry the action, or one click fires it twice.
      expect(html).not.toContain(`type="submit" class="small primary" data-action="${action}"`);
    }
    expect(app).toContain("document.addEventListener('submit'");
    // The hand-rolled Enter handlers are gone: the form does it for every field.
    expect(app).not.toContain("$('addUrlInput').addEventListener('keydown'");
  });
});

describe('no data-driven HTML', () => {
  it('el() has no innerHTML escape hatch', () => {
    expect(app).not.toContain("k === 'html'");
    expect(app).not.toMatch(/\.innerHTML\s*=/);
  });

  it('only puts absolute http(s) job URLs into hrefs', () => {
    expect(app).toContain('function safeHref(url)');
    expect(app).toContain("parsed.protocol === 'http:' || parsed.protocol === 'https:'");
    expect(app).not.toMatch(/href: job\.url\b/);
  });
});

describe('E4 — the resume keyword-match chip states its band honestly', () => {
  it('names every band atsReport.py writes, with a tone, and never calls the number an ATS score', () => {
    const py = readFileSync(new URL('../../src/resume/atsReport.py', import.meta.url), 'utf8');
    const bands = [...py.matchAll(/band = "([a-z_]+)"/g)].map((m) => m[1]);
    expect(bands.sort()).toEqual(['below_threshold', 'over_optimized', 'strong']);
    for (const band of bands) expect(app).toMatch(new RegExp(`${band}: \\{ label: '[^']+', tone: '(good|warn|bad)' \\}`));
    expect(app).toContain('Keyword match ${job.atsScore}%');
    expect(app).not.toContain('`ATS ${job.atsScore}%`');
  });
});
