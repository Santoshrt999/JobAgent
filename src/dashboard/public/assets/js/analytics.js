/** The health strip, stage tabs, Discovery health cards and the Next panel. */

import { $, el, esc, fmt, relTime } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { TABS, APP_TABS, APP_TAB_KEYS } from './filters.js';
import { renderBoardStatus } from './board.js';
import { renderHealthProfileFlag } from './profile.js';

/* ───────────────────────── pipeline health ─────────────────────────
 * Only facts that are NOT already a tab. "Awaiting approval", "ready to
 * submit" and "submitted" were dropped from here because Needs review, Ready
 * to apply and Submitted are literally the same numbers one row away — showing
 * them twice, in two visual languages, is what made the top of the page busy.
 */

/**
 * Always shown: what CHANGED and what is worth a look — not how big the
 * database is. The strip used to open with "125,706 in store", "0 seen in
 * last 24h", "0 posted in 24h" and "52/56 US states": four numbers about the
 * corpus, three of them usually zero, none of them a reason to act. The
 * corpus figures (and why most of it was filtered) now live one click away in
 * "Discovery and data quality", linked from the end of this row.
 */
export const HEALTH_FACTS = [
  // The 24h count is often single digits while a week holds hundreds.
  { key: 'postedLast7d', label: 'posted this week', tone: 'hot', filter: { postedWithinHours: '168' }, title: 'Open jobs whose POSTING is less than 1 week old — filter the board to them' },
  { key: 'strongFit', label: 'strong fits', tone: 'hot', filter: { fit: 'strong' }, title: 'Open jobs scored as a strong match — filter the board to them' },
];

/** Shown only when non-zero, and only where no tab already carries it. */
export const HEALTH_FLAGS = [
  { key: 'submitUnverified', label: 'unverified submits', tone: 'bad', filter: { appStatus: 'submit_unverified' }, title: 'Auto-submits with no confirmation — only you can resolve these' },
  { key: 'undatedDropped', label: 'undated', tone: 'attn', filter: { undated: true }, title: 'The source gave no confirmed posting date — held back, or still live but worth a quick check' },
];

/**
 * Render one stat tile, distinguishing "computed and genuinely zero" from
 * "not present in this response at all".
 *
 * REGRESSION GUARD. `stats.totals[key] ?? 0` treats both the same way,
 * rendering a missing key as a confident "0" — indistinguishable from a real
 * zero. This is exactly how a long-running dashboard server process (started
 * before a new stat field was added to the backend, since Node does not
 * hot-reload edited source) can show an impossible state: "4 posted 24h, 0
 * posted 1w" is a contradiction (24h is a subset of 1w) that can only happen
 * if the "0" is not a real computed value but a fallback for a key the
 * server's in-memory code never set. An honest "—" makes that gap visible
 * instead of masquerading as data.
 */
export function statNode({ key, label, tone, filter, title }, stats) {
  const raw = stats.totals[key];
  const known = typeof raw === 'number' && Number.isFinite(raw);
  const value = known ? raw : 0;
  const attrs = {
    class: `stat ${known && value > 0 ? tone ?? '' : ''} ${filter ? 'clickable' : ''}`.trim().replace(/\s+/g, ' '),
    title: known ? (title ?? '') : `${title ?? label} — not reported by the server (it may need a restart to pick up a recent update)`,
  };
  // A REAL button when it does something, a plain span when it does not.
  // These were spans carrying role="button" + tabindex, which meant Enter and
  // Space had to be hand-wired in a global keydown listener — behaviour every
  // browser already gives a <button> for free, and which silently breaks the
  // moment that listener is refactored. The flex strip does not care which
  // element it lays out.
  if (filter) {
    return el('button', {
      ...attrs,
      type: 'button',
      'data-action': 'metric-filter',
      'data-filter': JSON.stringify(filter),
    // The visible words ARE the accessible name (WCAG 2.5.3: a voice-control
    // user says what they see). The purpose rides along as hidden text.
    }, el('b', { text: known ? fmt(value) : 'n/a' }), ' ', el('span', { class: 'l', text: label }),
    el('span', { class: 'sr-only', text: ' (filter the board to these)' }));
  }
  return el('span', attrs, el('b', { text: known ? fmt(value) : 'n/a' }), el('span', { class: 'l', text: label }));
}

export function renderHealth(stats) {
  const host = $('health');
  host.textContent = '';
  // When discovery last found anything — the first question on opening the app.
  const last = relTime(stats.lastDiscoveryAt);
  host.append(el('span', { class: 'stat', title: 'When discovery last found anything' },
    el('span', { class: 'l', text: 'Last search' }), el('b', { text: last ?? 'never' })));
  for (const fact of HEALTH_FACTS) host.append(statNode(fact, stats));

  for (const flag of HEALTH_FLAGS) {
    // An empty warning is noise; only real attention items get a pill.
    if ((stats.totals[flag.key] ?? 0) === 0) continue;
    host.append(statNode(flag, stats));
  }
  host.append(el('button', {
    type: 'button', class: 'stat clickable stat-link', 'data-action': 'open-data-quality',
    title: `${fmt(stats.totals?.jobsTracked ?? 0)} jobs stored in total. See why jobs were filtered, how long they stay, and missing descriptions.`,
  }, el('span', { class: 'l', text: 'Data quality' })));

  // This strip is rebuilt from scratch on every stats load, so the profile
  // pill has to be re-added here or it would vanish on the next poll.
  renderHealthProfileFlag();
}

/**
 * Move `n` jobs between two tab counts right away. /api/stats is throttled to
 * once a minute (it reads the whole store), so after approving ten packets the
 * "Needs review" tab kept saying 10 over an empty list until the next recount.
 * The recount still follows and corrects anything this guessed wrong.
 */
export function shiftViewCount(from, to, n = 1) {
  const views = state.stats?.views;
  if (!views || !(n > 0)) return;
  if (from && Number.isFinite(views[from])) views[from] = Math.max(0, views[from] - n);
  if (to && Number.isFinite(views[to])) views[to] += n;
  renderTabs();
}

export function renderTabs() {
  // When filters are active the board response carries counts computed against
  // those same filters, so a badge never promises rows the tab would not show.
  const filtered = state.filteredViewCounts;
  const views = filtered ?? state.stats?.views ?? {};
  const host = $('tabs');
  const keptFocus = host.contains(document.activeElement);
  host.textContent = '';
  // Each list view carries its own stages: discovery under Jobs, application
  // work under Applications. The header nav shows the waiting application
  // work as one number, so it is visible from anywhere.
  const inApps = state.view === 'applications';
  const appsWaiting = APP_TABS.filter(([, , urgent]) => urgent).reduce((n, [key]) => n + (state.stats?.views?.[key] ?? 0), 0);
  const appsBadge = $('appsCount');
  if (appsBadge) {
    appsBadge.hidden = appsWaiting === 0;
    appsBadge.textContent = fmt(appsWaiting);
    appsBadge.title = `${fmt(appsWaiting)} application(s) waiting on you`;
  }
  for (const [key, label, urgent] of TABS) {
    if (APP_TAB_KEYS.has(key) !== inApps) continue;
    const count = views[key] ?? 0;
    const selected = state.activeTab === key;
    host.append(el('button', {
      class: `tab${urgent && count > 0 ? ' urgent' : ''}${filtered ? ' scoped' : ''}`,
      role: 'tab',
      id: `tab-${key}`,
      'aria-selected': String(selected),
      // The tabs announced themselves as tabs while controlling nothing, so a
      // screen reader had no way to know what changed when one was activated.
      'aria-controls': 'boardwrap',
      // Roving tabindex: a tablist is ONE tab stop and the arrow keys move
      // within it. Eight separate stops between the header and the board is
      // exactly what the skip link exists to avoid.
      tabindex: selected ? '0' : '-1',
      'data-action': 'set-tab',
      'data-tab': key,
      title: filtered
        ? `${fmt(count)} of these match the filters you have set`
        : `${fmt(count)} job(s)`,
    }, label, el('span', { class: `badge${count === 0 ? ' zero' : ''}`, text: fmt(count) })));
  }
  // Name the panel after whichever tab is currently showing in it.
  $('boardwrap').setAttribute('aria-labelledby', `tab-${state.activeTab}`);

  // These buttons are destroyed and rebuilt on every render — including the
  // background refresh a moment after a tab is activated. If focus was inside
  // the tablist it would land on <body>, stranding a keyboard user mid-row and
  // breaking arrow-key navigation after exactly one press.
  if (keptFocus) $(`tab-${state.activeTab}`)?.focus();
}

/**
 * How many rows a breakdown shows before it offers the rest.
 *
 * Measured: the location breakdown listed 56 rows and the source breakdown 16,
 * which made the analytics section 3,041px — 28% of a 10,738px page — to show
 * numbers whose whole job is "which few dominate?". A long tail of one-job
 * states answers nothing that the top eight do not.
 */
export const BREAKDOWN_ROWS = 8;

/**
 * Fill a breakdown table with at most `BREAKDOWN_ROWS` rows, plus a control
 * that reveals the rest in place.
 *
 * The tail is BUILT but hidden rather than dropped, so expanding costs no
 * request and the numbers can never disagree with the summary above them.
 *
 * @param {HTMLElement} body tbody to fill
 * @param {any[]} entries every row, already sorted
 * @param {(entry:any, index:number) => HTMLElement} rowFn builds one <tr>
 * @param {number} colspan width of the "show all" row
 */
export function fillBreakdown(body, entries, rowFn, colspan) {
  body.textContent = '';
  entries.forEach((entry, i) => {
    const tr = rowFn(entry, i);
    if (i >= BREAKDOWN_ROWS) tr.classList.add('tail');
    body.append(tr);
  });
  const hidden = entries.length - BREAKDOWN_ROWS;
  if (hidden <= 0) return;
  const cell = el('td', { colspan: String(colspan) });
  cell.append(el('button', {
    type: 'button', class: 'small ghost breakdown-more',
    'data-action': 'toggle-breakdown',
    'aria-expanded': 'false',
    text: `Show all ${fmt(entries.length)} ▾`,
  }));
  body.append(el('tr', { class: 'more-row' }, cell));
}

/**
 * Confidence is an ORDERED scale, so it is listed in scale order.
 *
 * It was sorted by count, which produced Unconfirmed(118k), Unclassified(9.1k),
 * Denied(2.4k), Likely(2.2k), Confirmed(155) — the scale shuffled into a
 * ranking, so "is this getting better or worse" could not be read off it at
 * all. Sorting an ordinal scale by frequency destroys the only thing it means.
 */
export const SPONSORSHIP_SCALE = ['Confirmed', 'Likely', 'Unconfirmed', 'Denied'];

/**
 * "Can you apply?" — sponsorship verdicts, and only verdicts.
 *
 * The old card listed "Unclassified" (99,438 on a real store) as a fifth
 * confidence next to real verdicts, and folded it into "still unknown" in the
 * lead line — but those jobs were never evaluated at all: they closed before
 * classification ran. Counting them as unknown made sponsorship look ten
 * times less known than it is. They are now reported apart, greyed, and
 * never added to a verdict.
 *
 * Prefers `stats.sponsorshipOpen` (open jobs only: { confirmed, likely,
 * unconfirmed, denied, notEvaluated }); an older server's `bySponsorship`
 * covers every stored job and has no per-bucket split of what is open.
 */
export function renderSponsorship(stats) {
  const body = $('sponRows');
  body.textContent = '';
  const open = stats.sponsorshipOpen;
  const legacy = stats.bySponsorship ?? {};
  const rows = SPONSORSHIP_SCALE.map((key) => {
    const count = open ? Number(open[key.toLowerCase()] ?? 0) : Number(legacy[key]?.count ?? 0);
    const strong = open ? null : Number(legacy[key]?.strong ?? 0);
    return { key, count, strong };
  });
  const notEvaluated = open ? Number(open.notEvaluated ?? 0) : Number(legacy.Unclassified?.count ?? 0);
  const max = Math.max(0, ...rows.map((r) => r.count));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
  $('sponsorLead').textContent = `${fmt(byKey.Confirmed + byKey.Likely)} confirmed or likely · `
    + `${fmt(byKey.Unconfirmed)} unconfirmed · ${fmt(byKey.Denied)} denied`
    + (open ? ' — open jobs' : ' — every stored job');
  // The strong-fit column only exists in the legacy shape.
  $('sponRows').closest('table').querySelector('thead th:nth-child(3)').hidden = Boolean(open);
  for (const row of rows) {
    if (!row.count && !open) continue;
    body.append(el('tr', {},
      el('td', {}, el('span', { class: `chip ${esc(row.key)}`, text: row.key })),
      el('td', { class: 'r' }, el('span', { class: 'num-with-bar' },
        el('span', { class: 'n', text: fmt(row.count) }), bar(row.count, max))),
      open ? null : el('td', { class: 'r' }, el('b', { class: row.strong > 0 ? 'yield-on' : 'yield-off', text: fmt(row.strong) }))));
  }
  if (notEvaluated > 0) {
    body.append(el('tr', { class: 'not-evaluated' },
      el('td', { colspan: open ? '2' : '3', class: 'faint' },
        `${fmt(notEvaluated)} not evaluated — closed before classification, so they are not counted above.`)));
  }
}

export function renderAnalytics(stats) {
  const srcEntries = Object.entries(stats.bySource).sort((a, b) => b[1].found - a[1].found);
  const srcMax = Math.max(0, ...srcEntries.map(([, v]) => v.found));
  const srcRows = $('srcRows');

  // The lead states the diagnostic the table is there to support: how much of
  // the corpus rides on a handful of boards. Concentration is what you act on —
  // if the top three are 80% of everything, three outages are a dead pipeline.
  const foundTotal = srcEntries.reduce((sum, [, v]) => sum + v.found, 0);
  const topThree = srcEntries.slice(0, 3).reduce((sum, [, v]) => sum + v.found, 0);
  $('sourceLead').textContent = srcEntries.length
    ? `${srcEntries.length} sources · top 3 produce ${foundTotal ? Math.round((topThree / foundTotal) * 100) : 0}% of everything found`
    : 'Nothing found yet.';

  if (!srcEntries.length) {
    srcRows.textContent = '';
    srcRows.append(el('tr', {}, el('td', { colspan: '3', class: 'muted', text: 'No jobs yet — run “Find new jobs”.' })));
  } else {
    fillBreakdown(srcRows, srcEntries, ([src, v]) => el('tr', {},
      el('td', {}, el('button', {
        class: 'small ghost cell-link', 'data-action': 'metric-filter',
        'data-filter': JSON.stringify({ source: src }), text: src,
      })),
      el('td', { class: 'r' }, el('span', { class: 'num-with-bar' },
        el('span', { class: 'n', text: fmt(v.found) }), bar(v.found, srcMax))),
      // Volume next to yield, which is the comparison the old five-column table
      // buried: one source can supply a third of the corpus and one strong fit.
      el('td', { class: 'r' }, el('b', { class: v.strong > 0 ? 'yield-on' : 'yield-off', text: fmt(v.strong) }))), 3);
  }

  // Nationwide coverage, made inspectable: which states the board actually
  // holds jobs from. An empty or lopsided list here is a real coverage gap, not
  // a display quirk.
  const stateRows = $('stateRows');
  stateRows.textContent = '';
  const stateEntries = Object.entries(stats.byState ?? {})
    .sort((a, b) => b[1].count - a[1].count);
  const stateMax = Math.max(0, ...stateEntries.map(([, v]) => v.count));
  const coverage = stats.coverage;
  $('stateLead').textContent = coverage?.statesPossible
    ? `${coverage.statesCovered} of ${coverage.statesPossible} US states and territories represented`
    : `${stateEntries.length} location(s)`;

  if (!stateEntries.length) {
    stateRows.append(el('tr', {}, el('td', { colspan: '3', class: 'muted', text: 'No jobs yet.' })));
  } else {
    fillBreakdown(stateRows, stateEntries, ([code, v]) => {
      const label = code === 'US' || code === 'unknown' ? v.name : `${v.name} (${code})`;
      return el('tr', {},
        el('td', { class: 'ellipsis', title: label, text: label }),
        el('td', { class: 'r' }, el('span', { class: 'num-with-bar' },
          el('span', { class: 'n', text: fmt(v.count) }), bar(v.count, stateMax))),
        el('td', { class: 'r' }, el('b', { class: v.strong > 0 ? 'yield-on' : 'yield-off', text: fmt(v.strong) })));
    }, 3);
  }

  renderSponsorship(stats);

  renderDailyTrend(stats.daily ?? []);
  renderNextActions(stats.nextActions ?? []);
}

/* ─────────────────────── next actions ───────────────────────
 * This was six identical blue sentences in a bulleted list.
 *
 * Three things were wrong with that, and they compound:
 *
 *  1. It RESTATED the tabs. "179 prepared packet(s) await your approval" is the
 *     Needs review tab; "20 blocked" is Needs you; "224 strong-fit… no decision"
 *     is Best matches; "249 … sponsorship check" is the verify-sponsor chip.
 *     Four of six items repeated a number sitting 200px away, in a third visual
 *     language — the exact thing the nine-tile metric strip was deleted for.
 *  2. The COUNT — the only scannable thing in each line — was buried mid-
 *     sentence in link-coloured prose, so nothing could be skimmed.
 *  3. The order of this list is a real priority ranking, and rendering every
 *     item identically threw that away.
 *
 * So: the top-ranked action is PROMOTED (its count set as a figure, its verb as
 * the headline, its guidance kept underneath, and an explicit button), the rest
 * become one scannable line each with counts right-aligned in a fixed column,
 * and notices about the tool rather than the jobs are separated out entirely.
 * Verb-first phrasing is what keeps this panel answering a different question
 * from the tabs: they say where the work IS, this says what to DO first.
 */
export function actionButton(action, className) {
  const attrs = { class: className, type: 'button' };
  if (action.filter) {
    attrs['data-action'] = 'metric-filter';
    attrs['data-filter'] = JSON.stringify(action.filter);
  } else {
    // A system notice has no board filter; its action is to run discovery.
    attrs['data-action'] = 'run';
    attrs['data-phase'] = 'discover';
  }
  // The visible count and verb are the accessible name (WCAG 2.5.3, so a
  // voice-control user can say what they see). Callers add the rest of the
  // guidance as visible or screen-reader-only text inside the button.
  return el('button', attrs);
}

export function renderNextActions(list) {
  const host = $('nextActions');
  host.textContent = '';
  host.append(el('h2', { text: 'Next' }));

  const jobs = list.filter((a) => a.kind !== 'system');
  const notices = list.filter((a) => a.kind === 'system');

  if (!jobs.length && !notices.length) {
    host.append(el('div', { class: 'muted', text: 'All caught up — nothing waiting on you.' }));
    return;
  }

  const [first, ...rest] = jobs;
  if (first) {
    const primary = actionButton(first, 'na-primary');
    primary.append(el('span', { class: 'na-count', text: fmt(first.count) }), ' ');
    const body = el('span', { class: 'na-body' });
    body.append(el('b', { text: first.verb }), ' ');
    body.append(el('span', { class: 'na-detail', text: first.detail }));
    primary.append(body);
    primary.append(el('span', { class: 'na-go', 'aria-hidden': 'true', text: '→' }));
    host.append(primary);
  }

  if (rest.length) {
    const ul = el('ul', { class: 'na-list' });
    for (const action of rest) {
      const button = actionButton(action, 'na-row');
      button.append(el('span', { class: 'na-n', text: fmt(action.count) }), ' ');
      button.append(el('span', { class: 'na-verb', text: action.verb }));
      if (action.detail) button.append(el('span', { class: 'sr-only', text: `. ${action.detail}` }));
      button.append(el('span', { class: 'na-go', 'aria-hidden': 'true', text: '→' }));
      button.title = action.detail;
      ul.append(el('li', {}, button));
    }
    host.append(ul);
  }

  // Not a queue of jobs — a fact about the tool. Kept visually apart so it does
  // not read as "the fifth most important job to work on".
  for (const notice of notices) {
    const note = el('div', { class: 'na-note' });
    note.append(el('span', { class: 'na-note-text', text: notice.detail }));
    const run = actionButton(notice, 'small');
    run.append(notice.verb);
    note.append(run);
    host.append(note);
  }
}

/* ─────────────────── daily trend: small multiples ───────────────────
 * This was a four-column table, which is the wrong form twice over: the data's
 * job is CHANGE OVER TIME (a table makes you read seven numbers and hold the
 * shape in your head), and the three measures differ by three orders of
 * magnitude — a run finds thousands, prepares a handful, submits one or two.
 *
 * Plotting them together would need two y-axes, which is the single worst thing
 * a chart can do. Small multiples are the honest answer: one facet per measure,
 * each with its OWN scale, sharing the x axis. Each facet is a single series, so
 * identity comes from its title rather than from colour — no categorical
 * palette, no legend, and nothing for a colour-blind reader to tell apart.
 *
 * The numbers stay readable as a table for assistive tech and for anyone who
 * wants the exact figures.
 */
export const TREND_FACETS = [
  { key: 'discovered', label: 'Found' },
  { key: 'prepared', label: 'Prepared' },
  { key: 'submitted', label: 'Submitted' },
];

/** One 7-point sparkline. Returns an <svg>, or null when there is nothing to draw. */
export function sparkline(values, { width = 168, height = 30, pad = 4 } = {}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const span = max > 0 ? max : 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const y = (v) => height - pad - (v / span) * (height - pad * 2);
  const pts = values.map((v, i) => [pad + i * stepX, y(v)]);

  const svg = el('svg', {
    class: 'spark', viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
  });
  // A flat run of zeros is a real answer ("nothing happened"), so it draws a
  // baseline rather than disappearing.
  svg.append(el('polyline', {
    class: 'spark-line',
    points: pts.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(' '),
  }));
  // End marker carries a surface-coloured ring so it stays legible where the
  // line doubles back under it.
  const [lx, ly] = pts[pts.length - 1];
  svg.append(el('circle', { class: 'spark-end', cx: lx.toFixed(1), cy: ly.toFixed(1), r: '3.5' }));
  return svg;
}

export function renderDailyTrend(daily) {
  const host = $('dailyTrend');
  host.textContent = '';
  if (!daily.length) {
    $('activityLead').textContent = 'No activity recorded yet.';
    host.append(el('div', { class: 'muted', text: 'No activity recorded yet.' }));
    return;
  }
  const days = daily.map((d) => d.day.slice(5));

  // The card's own question is "is the pipeline moving?", and the three facets
  // answer "by how much". How MANY of the last seven days saw anything at all
  // is the part neither facet shows: seven quiet days and one huge one average
  // out to a healthy-looking week.
  const activeDays = daily.filter((d) => (Number(d.discovered) || 0) > 0).length;
  $('activityLead').textContent = activeDays === daily.length
    ? `Discovery found something on all ${daily.length} of the last ${daily.length} days`
    : `Discovery found something on ${activeDays} of the last ${daily.length} days`;

  for (const facet of TREND_FACETS) {
    const values = daily.map((d) => Number(d[facet.key]) || 0);
    const latest = values[values.length - 1];
    const total = values.reduce((a, b) => a + b, 0);

    const row = el('div', { class: 'trend' });
    const head = el('div', { class: 'trend-head' });
    head.append(el('span', { class: 'trend-label', text: facet.label }));
    // The card promises "last 7 days", so the WEEK is the headline. Leading
    // with the latest day instead put a bold "0" at the top of every facet
    // first thing each morning — technically true and completely useless, with
    // the number that answers the question demoted to a footnote beside it.
    head.append(el('b', { class: 'trend-now', text: fmt(total) }));
    row.append(head);
    const chart = sparkline(values);
    if (chart) row.append(chart);
    row.append(el('span', { class: 'trend-sum', text: `${fmt(latest)} today` }));
    host.append(row);
  }

  // The exact figures, for a screen reader and for anyone who wants to read
  // rather than eyeball. `sr-only` rather than removed: a chart without its
  // numbers available is a chart that excludes people.
  const table = el('table', { class: 'sr-only' });
  table.append(el('caption', { text: 'Daily activity for the last 7 days' }));
  const head = el('tr', {}, el('th', { scope: 'col', text: 'Day' }));
  for (const facet of TREND_FACETS) head.append(el('th', { scope: 'col', text: facet.label }));
  table.append(el('thead', {}, head));
  const body = el('tbody', {});
  daily.forEach((d, i) => {
    const tr = el('tr', {}, el('th', { scope: 'row', text: days[i] }));
    for (const facet of TREND_FACETS) tr.append(el('td', { text: fmt(Number(d[facet.key]) || 0) }));
    body.append(tr);
  });
  table.append(body);
  host.append(table);
}

export function bar(value, max) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const wrap = el('span', { class: 'mini', title: fmt(value) });
  const fill = el('i');
  fill.style.width = `${pct}%`;
  wrap.append(fill);
  return wrap;
}

/*
 * /api/stats reads the whole corpus — ~6s cold on a 120k-row store — and it
 * was fetched after EVERY click. It is now single-flight (concurrent callers
 * share one request) and throttled to once a minute, with a trailing refetch
 * so a burst of decisions still ends with fresh numbers. `force` is for the
 * moments the numbers are known to have moved a lot: boot and the end of a run.
 */
export const STATS_MIN_INTERVAL_MS = 60_000;
export let statsInFlight = null;
export let statsFetchedAt = 0;
export let statsTrailing = null;

export function loadStats({ force = false } = {}) {
  if (statsInFlight) return statsInFlight;
  const wait = STATS_MIN_INTERVAL_MS - (Date.now() - statsFetchedAt);
  if (!force && wait > 0) {
    if (!statsTrailing) statsTrailing = setTimeout(() => { statsTrailing = null; loadStats(); }, wait);
    return Promise.resolve(state.stats);
  }
  clearTimeout(statsTrailing);
  statsTrailing = null;
  statsInFlight = fetchStats().finally(() => {
    statsInFlight = null;
    statsFetchedAt = Date.now();
  });
  return statsInFlight;
}

export async function fetchStats() {
  const stats = await api('/api/stats');
  state.stats = stats;
  // Served from cache while the server recomputes: say so, and come back for
  // the real numbers shortly rather than waiting out the throttle.
  if (stats.stale) setTimeout(() => loadStats({ force: true }), 10_000);
  renderBoardStatus();
  renderHealth(stats);
  renderTabs();
  renderAnalytics(stats);
  const select = $('source');
  const current = select.value;
  select.textContent = '';
  // Matches the "Any" wording of every other select in the panel.
  select.append(el('option', { value: '', text: 'Any source' }));
  for (const src of Object.keys(stats.bySource)) {
    select.append(el('option', { value: src, text: src, selected: src === current }));
  }
  populateStates(stats);
}

/**
 * Fill the state dropdown from the states that ACTUALLY have jobs, with each
 * one's count, so the list can never offer a state that returns nothing.
 *
 * `byState` is keyed by two-letter code, plus 'US' for national/remote-only
 * postings that name no state and 'unknown' for locations we could not read.
 * Neither of those is a state, so neither becomes a state option — 'US' is
 * already served by the dedicated Remote entry, and offering "unknown" as a
 * location choice would be meaningless.
 */
export function populateStates(stats) {
  const select = $('state');
  const current = select.value;
  const entries = Object.entries(stats.byState ?? {})
    .filter(([code]) => code !== 'US' && code !== 'unknown')
    .sort((a, b) => (a[1].name ?? a[0]).localeCompare(b[1].name ?? b[0]));

  select.textContent = '';
  select.append(el('option', { value: '', text: 'Any location' }));
  select.append(el('option', { value: 'REMOTE', text: 'Remote', selected: current === 'REMOTE' }));
  for (const [code, info] of entries) {
    select.append(el('option', {
      value: code,
      text: `${info.name ?? code} (${fmt(info.count)})`,
      selected: code === current,
    }));
  }
}

/**
 * "What is failing" — the only thing on the page that reads /api/sections —
 * lives inside the collapsed Discovery health disclosure, so it is fetched
 * only while that is open, and only the one section it draws. A server that
 * predates `?only=` returns everything, which reads the same.
 */
export async function loadSections() {
  if ($('analytics').hidden) return;
  const sections = await api('/api/sections?only=blockedByReason').catch(() => null);
  if (!sections) return;
  const host = $('blockRows');
  host.textContent = '';
  const rows = sections.blockedByReason ?? [];
  const total = rows.reduce((sum, r) => sum + (Number(r.count) || 0), 0);
  $('blockLead').textContent = rows.length
    ? `${fmt(total)} job(s) stopped, across ${rows.length} distinct cause(s)`
    : 'Nothing is failing right now.';
  if (!rows.length) {
    host.append(el('tr', {}, el('td', { colspan: '2', class: 'muted', text: 'Nothing blocked' })));
    return;
  }
  for (const entry of rows) {
    host.append(el('tr', {},
      // These reasons come from live automation failures, so some are raw
      // driver messages ("field Start date year*: locator.fill: Error: Cannot
      // type text into input[type=nu…"). Unclamped, one of them set the height
      // of the whole card. Full text stays on hover and in the row itself.
      el('td', { class: 'clamp-2', title: entry.reason, text: entry.reason }),
      el('td', { class: 'r', text: fmt(entry.count) })));
  }
}
