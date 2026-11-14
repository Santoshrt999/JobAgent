/** The job board: page loading, rows, focus restore, pager, status line. */

import { $, el, esc, fmt, icon, relTime, safeHref } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { filterParams, renderActiveFilters, TABS } from './filters.js';
import { renderTabs } from './analytics.js';
import { cssEscape, isAggregatorUrl, syncDetailToList } from './detail.js';
import { syncSelectAll, syncSelectionBar } from './selection.js';
import { hasActiveFilters } from './main.js';
import { freshnessOf } from './format.js';

/* ──────────────────────────── board ──────────────────────────── */

export let boardSeq = 0;

/**
 * One quiet line saying how fresh the board is. A 2px sweep along the top of
 * the table was the only sign a query was running, and nothing at all said
 * how old the numbers were — or that the server was serving cached ones.
 */
export const boardStatus = { loading: false, updatedAt: 0 };

export function renderBoardStatus() {
  const node = $('boardStatus');
  if (!node) return;
  const parts = [];
  if (boardStatus.loading) parts.push('Refreshing…');
  else if (boardStatus.updatedAt) {
    const secs = Math.round((Date.now() - boardStatus.updatedAt) / 1000);
    parts.push(secs < 5 ? 'Updated just now'
      : secs < 60 ? `Updated ${secs}s ago` : `Updated ${Math.floor(secs / 60)}m ago`);
  }
  if (state.stats?.stale) parts.push('Showing cached numbers — recalculating');
  node.textContent = parts.join(' · ');
  node.classList.toggle('busy', boardStatus.loading);
}
setInterval(renderBoardStatus, 10_000);

/** Reload the board page once, however many mutations asked for it. */
export let boardReloadTimer = null;
export function scheduleBoardReload(delay = 300) {
  clearTimeout(boardReloadTimer);
  boardReloadTimer = setTimeout(loadBoard, delay);
}

/**
 * How many columns a full-width message row must span.
 *
 * Counted from the header rather than written as a literal. Three separate
 * `colspan: '11'` literals had to be found and changed by hand every time a
 * column was added or removed, and a missed one silently narrows the empty
 * state to part of the table.
 */
export const boardColSpan = () => String(document.querySelectorAll('#board thead th').length);

export async function loadBoard() {
  const seq = ++boardSeq;
  const body = $('rows');
  if (!body.children.length) {
    body.append(el('tr', {}, el('td', { colspan: boardColSpan() },
      el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }))));
  }
  // Skeletons only appear on an EMPTY board, so every subsequent query showed
  // the previous result set, unchanged and unmarked, until it returned.
  // Measured: opening the "tracked" fact reads all 132,531 rows and takes ~7s,
  // during which the board silently displayed the wrong 100 jobs. Dimming the
  // stale rows and disabling their controls says "this is being replaced"
  // without the layout jump of throwing them away.
  $('boardwrap').dataset.loading = 'true';

  boardStatus.loading = true;
  renderBoardStatus();
  let page;
  try {
    // Slim rows: the board draws ~20 fields and the full row carries the
    // explanation, keyword lists, paths and signals (~2 KB each). The detail
    // rail fetches the full job by id when it opens one.
    const params = filterParams();
    params.set('fields', 'board');
    page = await api(`/api/jobs?${params}`);
  } catch (err) {
    if (seq !== boardSeq) return;
    boardStatus.loading = false;
    renderBoardStatus();
    $('boardwrap').dataset.loading = 'false';
    body.textContent = '';
    body.append(el('tr', {}, el('td', { colspan: boardColSpan(), class: 'empty', text: err.message })));
    $('pager').textContent = '';
    return;
  }
  if (seq !== boardSeq) return; // a newer request already won
  $('boardwrap').dataset.loading = 'false';
  boardStatus.loading = false;
  boardStatus.updatedAt = Date.now();
  renderBoardStatus();

  // The server may clamp the page (e.g. filters narrowed while on page 7).
  if (page.page && page.page !== state.page) state.page = page.page;

  state.visible = page.jobs.map((j) => j.id);
  for (const job of page.jobs) state.known.set(job.id, job);

  // Absent when no filter is active — the unfiltered stats counts are then the
  // right ones, so clearing this is what restores them.
  state.filteredViewCounts = page.viewCounts ?? null;

  renderRows(page.jobs);
  if (state.syncDetail) { state.syncDetail = false; syncDetailToList(state.visible); }
  renderPager(page);
  renderTabs();
  syncSelectAll();
  // Fresh rows can move a selected job along the pipeline (an approve just
  // landed), which changes which bulk step deserves the primary button.
  syncSelectionBar();
  renderActiveFilters();
}

/**
 * Remember which board control has focus, so a re-render can put it back.
 *
 * Every board reload replaced all 100 rows, so a keyboard user sitting on a
 * row — or on its checkbox — was dropped onto <body> by a refresh they did not
 * cause. Recorded by job id and control, never by node, because the nodes are
 * the thing being replaced.
 */
export function captureRowFocus() {
  const active = document.activeElement;
  const row = active?.closest?.('#rows tr.job');
  if (!row) return null;
  return {
    id: row.dataset.id,
    action: active === row ? null : active.dataset?.action ?? null,
    index: [...$('rows').querySelectorAll('tr.job')].indexOf(row),
  };
}

export function restoreRowFocus(spec) {
  if (!spec) return;
  const rows = [...$('rows').querySelectorAll('tr.job')];
  // The focused job may have left the page (rejected, filtered out): the row
  // now in its position is where a keyboard user expects to be.
  const row = rows.find((tr) => tr.dataset.id === spec.id) ?? rows[Math.min(spec.index, rows.length - 1)];
  if (!row) { $('boardwrap').focus({ preventScroll: true }); return; }
  const target = row.dataset.id === spec.id && spec.action
    ? row.querySelector(`[data-action="${cssEscape(spec.action)}"]`) : null;
  (target ?? row).focus({ preventScroll: true });
}

export function renderRows(jobs) {
  const body = $('rows');
  const focus = captureRowFocus();
  body.textContent = '';

  if (!jobs.length) {
    const tracked = state.stats?.totals?.jobsTracked ?? 0;
    const cell = el('td', { colspan: boardColSpan() });
    const box = el('div', { class: 'empty' });
    // With more than one person, say whose empty board this is: a newly added
    // profile starts with its own, empty, job list.
    const first = Number(document.body.dataset.people) > 1 ? (document.body.dataset.person ?? '').split(' ')[0] : '';
    box.append(el('div', { class: 'big', text: tracked === 0 ? `No jobs yet${first ? ` for ${first}` : ''}` : 'Nothing matches these filters' }));
    if (tracked === 0) {
      box.append(el('p', { class: 'muted', text: 'Find jobs searches every job board for the titles in this profile and scores each match.' }));
      box.append(el('div', { class: 'row-gap empty-actions' },
        el('button', { type: 'button', class: 'small primary', 'data-action': 'run', 'data-phase': 'discover', text: 'Find jobs' })));
    } else {
      const actions = el('div', { class: 'row-gap empty-actions' });
      actions.append(el('button', { class: 'small', 'data-action': 'reset-filters', text: 'Reset filters' }));
      // THE MOMENT THE ESCALATION IS ACTUALLY WANTED. "Nothing here matches
      // what I typed" is precisely when someone wants to ask the job boards
      // for it, and the only thing offered was to clear the search that had
      // just failed them. `data-query` carries the phrase, so the dialog opens
      // on it rather than empty.
      const query = $('q').value.trim();
      if (query) {
        actions.append(el('button', {
          class: 'small primary', 'data-action': 'open-job-search', 'data-query': query,
          text: `Search job boards for “${query}”`,
        }));
      }
      box.append(actions);
    }
    cell.append(box);
    body.append(el('tr', {}, cell));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const job of jobs) {
    const tr = rowFor(job);
    for (const c of tr.querySelectorAll(ROW_CONTROLS)) c.tabIndex = -1;
    frag.append(tr);
  }
  body.append(frag);
  setRowTabStop(body.querySelector('tr.job[aria-current="true"]') ?? body.querySelector('tr.job'));
  restoreRowFocus(focus);
}

/** Interactive controls inside a row: tabbable only on the row holding the tab stop. */
export const ROW_CONTROLS = 'a[href], button, input, select, textarea, [role="button"]';

/**
 * Give `row` the board's single tab stop (and its own controls with it).
 * @param {HTMLElement|null} row
 */
export function setRowTabStop(row) {
  for (const tr of $('rows').querySelectorAll('tr.job[tabindex="0"]')) {
    if (tr === row) continue;
    tr.tabIndex = -1;
    for (const c of tr.querySelectorAll(ROW_CONTROLS)) c.tabIndex = -1;
  }
  if (!row) return;
  row.tabIndex = 0;
  for (const c of row.querySelectorAll(ROW_CONTROLS)) c.tabIndex = 0;
}

export function rowFor(job) {
  const selected = job.id === state.selectedId;
  // `aria-selected` is only meaningful on a row inside a grid/treegrid. This is
  // a plain table, so it was invalid ARIA on all 100 rows — and it described
  // the wrong thing anyway: the highlighted row is the one whose detail is
  // open, not one of a multi-select (that is the checkbox). `aria-current` is
  // valid anywhere and says exactly that.
  const tr = el('tr', {
    class: 'job',
    'data-id': job.id,
    'data-action': 'select',
    ...(selected ? { 'aria-current': 'true' } : {}),
    // ROVING TAB STOP (BUG-12): one row is in the tab order, not all 100 —
    // with every row and its controls tabbable, reaching the pager took 300+
    // presses. Arrow keys / j k move between rows; see setRowTabStop.
    tabindex: '-1',
    role: 'row',
  });

  // checkbox
  const check = el('input', {
    type: 'checkbox', 'data-action': 'toggle-select', 'data-id': job.id,
    'aria-label': `Select ${job.company ?? ''} ${job.title ?? ''}`.trim(),
  });
  check.checked = state.selected.has(job.id);
  tr.append(el('td', { class: 'check' }, check));

  // grade + score. The letter alone carries no meaning to a screen reader —
  // "A" is a letter, not a verdict — and the label explaining it ("Excellent
  // fit") lived only in a tooltip.
  const grade = job.grade;
  tr.append(el('td', {},
    el('span', {
      class: `grade ${grade ? grade.letter : 'none'}`,
      role: 'img',
      'aria-label': grade ? `grade ${grade.letter}, ${grade.label}, score ${job.score}` : 'not scored yet',
      title: grade ? `${grade.label} · score ${job.score}` : 'Not scored yet',
      text: grade ? grade.letter : '—',
    }),
    fitMeter(job)));

  tr.append(nameCellFor(job));

  // sponsorship — the badge carries its own evidence, so a claim as consequential
  // as "Confirmed" can be checked on hover instead of taken on trust.
  // A gated row (a strong fit held back from automatic preparation until
  // sponsorship is verified) says so in words, not only in a tooltip.
  const sponsorCell = el('td', { 'data-label': 'Sponsor' }, el('span', {
    class: `chip ${esc(job.sponsorship ?? '')}`,
    title: sponsorshipTitle(job),
    text: job.sponsorship ?? '—',
  }));
  if (job.sponsorshipGated) {
    sponsorCell.append(el('div', {
      class: 'gate-mark',
      title: 'A strong fit held back from automatic preparation until you confirm the employer sponsors. Open it to see the evidence.',
      text: 'Verify first',
    }));
  }
  tr.append(sponsorCell);

  // posted
  // The dot is a coloured 7px circle with no text: a `title` on an empty span is
  // announced inconsistently at best, so the confidence of a posting date —
  // which decides whether the date can be trusted at all — reached neither a
  // screen reader nor a touch user. `role="img"` + a label makes it a real
  // graphic with a real name.
  // The date stays on one line; the "new" chip may wrap under it. With the
  // whole cell nowrap, "Today" + chip overflowed and rendered as "Today …".
  const fresh = freshnessOf(job.postedAt);
  const postedCell = el('td', {
    class: `posted-cell${fresh ? ` age-${fresh.tone}` : ''}`, 'data-label': 'Posted',
    title: fresh ? `Posted ${fresh.days} day${fresh.days === 1 ? '' : 's'} ago` : '',
  },
    el('span', { class: 'nowrap' },
      el('span', {
        class: `dot ${job.postedConfidence}`,
        role: 'img',
        'aria-label': `posting date ${job.postedConfidence}`,
        title: `Posting date ${job.postedConfidence}`,
      }),
      job.postedLabel));
  if (job.postedLast24h) postedCell.append(' ', el('span', { class: 'chip good', text: 'new' }));
  else if (fresh?.tone === 'stale') postedCell.append(el('div', { class: 'age-note', text: `${fresh.days}d old` }));
  tr.append(postedCell);

  // found — when THIS agent first discovered the job, which is a different
  // question from when the employer posted it. A months-old posting can be a
  // brand-new find (a board was only just added), and that is exactly the row
  // a user checking "what did the last run turn up?" wants to see.
  tr.append(el('td', { class: 'nowrap', 'data-label': 'Found', title: job.createdAt ?? '' },
    relTime(job.createdAt) || '—'));

  // resume — one click straight to the tailored document.
  //
  // The state chip and a separate 👁 button used to sit side by side, needing
  // 112px in a 96px column, so the button was clipped away by the cell's own
  // overflow. They said the same thing anyway: the chip names the state, the
  // button opened the document that state refers to. One control now does
  // both — narrower, and a 60px click target instead of a 22px one.
  const label = job.resumeStatus === 'tailored' ? 'tailored'
    : job.resumeStatus === 'prepared' ? 'packet' : '—';
  // Slim board rows may carry a `hasResumeDoc` flag instead of the file paths
  // (paths are detail-only data); either one means there is something to open.
  const hasDoc = Boolean(job.hasResumeDoc ?? (job.resumeDocxPath || job.resumePdfPath));
  tr.append(el('td', { class: 'nowrap', 'data-label': 'Resume' }, hasDoc
    ? el('button', {
      class: `rs ${job.resumeStatus} rs-open`, 'data-action': 'preview-resume', 'data-id': job.id,
      title: 'Preview the tailored resume',
      'aria-label': `Preview tailored resume for ${job.company ?? ''} ${job.title ?? ''}`.trim(),
      text: label,
    })
    : el('span', { class: `rs ${job.resumeStatus}`, text: label })));

  // WHY a job is blocked/discarded/skipped was carried only by a `title=`
  // tooltip plus a bare ⓘ glyph — invisible on touch, unreliable for screen
  // readers, and the single most useful thing in the column. It is now real
  // text, clamped to one line so the row height stays stable.
  //
  // Progress lives here too. As its own column it was an unlabelled 80px bar
  // that only made sense once you had read the status beside it, so the two
  // were always read together while being laid out apart.
  const statusCell = el('td', { class: `st-${job.appStatus}`, 'data-label': 'Status' });
  statusCell.append(el('span', { class: `stpill st-${job.appStatus}`, text: statusLabel(job) }));
  // Progress only once an application is under way. On a discovered or
  // scored row every bar was the same sliver, which said nothing and made
  // every row look half-finished.
  const bar = PRE_APPLICATION.has(job.appStatus) ? '' : progressBar(job.progress);
  if (bar) statusCell.append(bar);
  if (job.statusReason) {
    statusCell.append(el('div', {
      class: 'statusreason', title: job.statusReason, text: job.statusReason,
    }));
  }
  tr.append(statusCell);

  // The card layout sets `display: block/flex` on these cells, which drops
  // their implicit `cell` role in every engine. Stating it keeps the board a
  // table for assistive tech at every width.
  for (const cell of tr.children) cell.setAttribute('role', 'cell');
  return tr;
}

/** Statuses before any application work, where a progress bar says nothing. */
const PRE_APPLICATION = new Set(['discovered', 'scored', 'needs_description', 'shortlisted', 'date_unconfirmed']);

/**
 * The fit meter under the grade: the score as a number and a bar. The bar
 * is decoration (the grade carries the accessible name); the number is what
 * people compare. An unread row shows "unread" rather than a fabricated 0.
 */
export function fitMeter(job) {
  if (job.score == null || job.appStatus === 'needs_description') {
    return el('div', { class: 'fitmeter none', 'aria-hidden': 'true', text: job.appStatus === 'needs_description' ? 'unread' : '—' });
  }
  const fill = el('i');
  fill.style.width = `${Math.max(4, Math.min(100, Number(job.score)))}%`;
  return el('div', { class: `fitmeter ${job.fit ?? ''}`.trim(), 'aria-hidden': 'true' },
    el('span', { class: 'fitmeter-n', text: String(job.score) }),
    el('span', { class: 'fitmeter-bar' }, fill));
}

/** The one-line skills summary under a role: "4 of 6 skills · SQL, Python, dbt". */
export function skillLine(job) {
  const m = job.skillMatch;
  if (job.appStatus === 'needs_description') {
    return el('div', { class: 'skillline incomplete', text: 'Description not read yet, so fit is not judged' });
  }
  if (!m) return null;
  const asked = m.matched + m.missing;
  return el('div', {
    class: 'skillline',
    title: m.missing ? `${m.missing} asked-for skill(s) not evidenced in your resume. Open the job for the full list.` : 'Every asked-for skill is evidenced in your resume.',
  },
  el('span', { class: 'skillline-n', text: `${m.matched} of ${asked} skills` }),
  m.top.length ? el('span', { class: 'skillline-top', text: ` · ${m.top.join(', ')}` }) : null);
}

/** Longest title rendered in full before eliding. */
export const TITLE_MAX_CHARS = 72;

/**
 * The Company / role cell.
 *
 * Three deliberate decisions:
 *
 *  1. The ROLE is the link and the primary line. Reaching a posting previously
 *     took two clicks and a context switch (select the row, then "Open posting"
 *     in the detail rail) even though every row already carries its URL —
 *     measured: 0 of 2,219 open rows lacked one. The role also leads visually,
 *     because you scan this board by role; it used to be the quietest text in
 *     the cell (`.muted`) under a bold company name.
 *
 *  2. Aggregator listings are MARKED. Measured on real data, 1,061 of 2,219
 *     open rows (48%) point at LinkedIn/Indeed/Dice rather than an employer's
 *     own form, and the app already warns about exactly that in the detail rail
 *     ("not a reliable application form"). Linking every title without a marker
 *     would silently bypass that warning on half the board, so the source is
 *     named inline — you can see what you are about to open.
 *
 *  3. Long titles are elided. Real titles reach 150 characters (3.5% exceed 72),
 *     and the cell has no width constraint, so those stretched the column and
 *     forced the whole table to scroll sideways. The full text stays available
 *     as the link's tooltip and in the detail rail.
 */
export function nameCellFor(job) {
  const cell = el('td', { class: 'namecell' });
  let aggChip = null;
  const title = String(job.title ?? '').trim() || 'Title not identified';
  const shown = title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : title;

  // Only an absolute http(s) URL becomes a link; anything else (a feed that
  // handed us `javascript:` or a bare path) is rendered as plain text.
  const href = safeHref(job.url);
  if (href) {
    const aggregator = isAggregatorUrl(job.url);
    const link = el('a', {
      class: 'rolelink',
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      // `data-action` keeps this inside the one delegated-dispatch convention the
      // rest of the UI uses; the dispatcher lets real links navigate.
      'data-action': 'open-posting',
      title: aggregator
        ? `${title}\n\nOpens ${hostLabel(job.url)} — an aggregator listing, not the employer's own application form.`
        : title,
      // The accessible name is the VISIBLE text plus a hidden note, never a
      // different string: a full title in aria-label behind a shortened one on
      // screen failed WCAG 2.5.3 (label in name) for every long title. The
      // full title stays in the tooltip.
    }, shown, el('span', { class: 'sr-only', text: ` at ${job.company || 'company on posting'} (opens the posting in a new tab)` }));
    cell.append(link);
    if (aggregator) {
      // Sits on the META line, not on a line of its own under the role. It
      // qualifies where the link GOES, which is the same kind of fact as the
      // company and location it now sits beside — and a standalone line per
      // aggregator row cost a third of the row height on 48% of the board.
      aggChip = el('span', {
        class: 'chip agg',
        title: 'Aggregator listing — follow Apply through to the employer site, then save that direct URL here.',
        text: hostLabel(job.url),
      });
    }
  } else {
    // No URL means nothing to open — say so rather than render a dead link.
    cell.append(el('span', { class: 'rolelink none', title, text: shown }));
  }

  const meta = el('div', { class: 'namemeta' });
  meta.append(el('span', { class: 'co', text: job.company || 'Company on posting' }));
  if (job.remote) meta.append(' ', el('span', { class: 'rs', text: 'remote' }));
  if (job.location) meta.append(el('span', { class: 'faint', text: ` · ${job.location}` }));
  // WHERE YOU WILL APPLY — one slot, because the two facts are alternatives,
  // not additions. An aggregator listing has no employer ATS to name, and a
  // row that goes straight to Workday is not an aggregator. Naming whichever
  // one applies replaces a whole 92px column that read "—" on most rows.
  if (aggChip) meta.append(' ', aggChip);
  else if (job.atsPlatform) {
    meta.append(' ', el('span', {
      class: 'chip ats-flag',
      title: `Applications for this job are handled by ${job.atsPlatform}`,
      text: job.atsPlatform,
    }));
  }
  // Employment type, but only when it is worth a reader's attention. It had a
  // column of its own that said "Full-time" on almost every row — 85px of width
  // spent restating the default. Contract/part-time genuinely changes whether a
  // job is worth applying to, so THAT is what gets shown, next to the company
  // it qualifies rather than in a column of its own.
  const exception = typeException(job);
  if (exception) meta.append(' ', exception);
  // Only a closed posting is worth a flag on the row; "open" is the default.
  if (job.linkState === 'closed') {
    meta.append(' ', el('span', {
      class: 'chip bad', title: 'Its ATS no longer lists this job — it can no longer be applied to', text: 'posting closed',
    }));
  }
  cell.append(meta);
  const skills = skillLine(job);
  if (skills) cell.append(skills);
  return cell;
}

/** Employment types worth calling out; full-time and unknown are the silent default. */
export const NOTABLE_TYPES = { contract: 'contract', contract_to_hire: 'contract→hire', part_time: 'part-time' };

/**
 * A chip for a non-standard employment type, or null when there is nothing to
 * say. Returning null is the point: the old `typeChip` always rendered
 * something, including a bare "—" for the 'unknown' case.
 */
export function typeException(job) {
  const label = NOTABLE_TYPES[job.employmentCategory];
  if (!label) return null;
  return el('span', {
    class: 'chip bad type-flag',
    title: `Employment type: ${job.employmentLabel ?? job.employmentCategory}`,
    text: label,
  });
}

/**
 * Brands whose own capitalisation is not just "first letter upper" — naive
 * title-casing renders these as "Linkedin"/"Ziprecruiter", which reads as a bug.
 */
export const HOST_BRANDS = {
  linkedin: 'LinkedIn',
  ziprecruiter: 'ZipRecruiter',
  simplyhired: 'SimplyHired',
};

/** Short, human host label for a posting URL ("LinkedIn", "Indeed"). */
export function hostLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    const name = host.split('.')[0].toLowerCase();
    return HOST_BRANDS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return 'link'; }
}

/**
 * Hover text for the sponsorship badge: the prose the verdict was read from.
 *
 * A sponsorship verdict decides whether a job is worth applying to at all, and
 * it used to be shown as a bare word with nothing behind it. That is how six
 * Humana rows displayed a green "Confirmed" while their JDs said "This role is
 * not eligible for work visa sponsorship" — the badge asserted a conclusion no
 * one could check. Rows scored before the signals column existed simply have no
 * evidence to show, so they say so rather than implying the badge is verified.
 */
export function sponsorshipTitle(job) {
  const parts = [];
  const signals = job.sponsorshipSignals ?? [];
  if (signals.length) parts.push(`Read from the posting: "${signals.join('"; "')}"`);
  else if (job.sponsorship) parts.push('No recorded evidence — re-score this job to capture it.');
  if (job.sponsorshipGated) {
    parts.push('Strong fit parked by the sponsorship gate — verify the employer sponsors.');
  }
  if (job.sponsorship === 'Denied') {
    parts.push('The posting explicitly refuses sponsorship.');
  }
  return parts.join('\n');
}

/**
 * The sponsorship verdict AND the words it was read from, as real text.
 *
 * This was a `title=` tooltip and nothing else — reachable only by hovering a
 * mouse over a chip, so on a touch screen or with a screen reader the most
 * consequential claim on the board ("does this employer sponsor?") had no
 * evidence attached at all. That is exactly the shape of the failure this
 * tooltip was added for: six rows once showed a green "Confirmed" while their
 * postings said the role was not eligible for sponsorship, and only a hover
 * could reveal it. A verdict a user is expected to act on has to show its work
 * where the user is looking.
 */
export function sponsorshipEvidence(job) {
  const wrap = el('div', {});
  const verdict = job.sponsorship ?? 'unknown';
  wrap.append(el('div', { class: 'chiprow' },
    el('span', { class: `chip ${esc(job.sponsorship ?? '')}`, text: verdict }),
    job.sponsorshipGated
      ? el('span', { class: 'chip warn', text: 'parked until you verify' })
      : ''));

  const signals = job.sponsorshipSignals ?? [];
  if (signals.length) {
    wrap.append(el('div', { class: 'muted evidence-label', text: 'Read from the posting:' }));
    const list = el('ul', { class: 'plan evidence-quotes' });
    for (const signal of signals) list.append(el('li', {}, el('q', { text: signal })));
    wrap.append(list);
  } else if (job.sponsorship) {
    wrap.append(el('div', { class: 'muted', text: 'No recorded evidence — re-score this job to capture it.' }));
  }
  if (job.sponsorship === 'Denied') {
    wrap.append(el('div', { class: 'attention' },
      el('span', { class: 'mark', text: '!' }),
      el('div', { text: 'The posting explicitly refuses sponsorship.' })));
  }
  return wrap;
}

export function progressBar(progress) {
  if (!progress) return '';
  const wrap = el('div', {
    class: `bar${progress.offRamp ? ' off' : ''}`,
    title: progress.offRamp ? progress.stage : `${progress.stage} (${progress.percent}%)`,
  });
  const fill = el('i');
  fill.style.width = progress.offRamp ? '100%' : `${progress.percent}%`;
  wrap.append(fill);
  return wrap;
}

export const STATUS_LABELS = {
  // Deliberately NOT "Scored". These rows arrived as a title with no
  // description, so nothing has judged them; folding them into "Scored" put
  // 5,029 unread jobs inside a tile of 5,175.
  needs_description: 'Description not fetched',
  ready_for_submit: 'Ready for your review',
  needs_review: 'Review resume',
  approved: 'Ready to auto-fill',
  submitted: 'Submitted',
  submit_unverified: 'Verify submission',
  date_unconfirmed: 'Date unconfirmed',
  blocked: 'Needs you',
  failed: 'Failed',
};

export function statusLabel(job) {
  // The server's label is the one the tracker and Today use; the raw status
  // ("scored") only ever showed because this map lacked an entry for it.
  const raw = String(job.appStatus ?? '').replace(/_/g, ' ');
  return job.attention?.label || job.statusLabel || STATUS_LABELS[job.appStatus] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function renderPager(page) {
  const host = $('pager');
  host.textContent = '';
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);

  const count = el('span', { class: 'count' });
  count.append('Showing ', el('b', { text: `${fmt(from)}–${fmt(to)}` }), ' of ', el('b', { text: fmt(page.total) }));
  if (page.total > page.limit) count.append(el('span', { class: 'pg-of', text: ` · page ${page.page} of ${page.pages}` }));
  host.append(count);

  if (page.pages > 1) {
    host.append(
      // First/Last carry `pg-edge` so a phone can fold the pager to one line.
      el('button', { class: 'small pg-edge', 'data-action': 'page', 'data-page': '1', disabled: page.page <= 1, 'aria-label': 'First page' }, icon('chevs-l'), 'First'),
      el('button', { class: 'small', 'data-action': 'page', 'data-page': String(page.page - 1), disabled: page.page <= 1, 'aria-label': 'Previous page' }, icon('chev-l'), 'Prev'),
      el('button', { class: 'small', 'data-action': 'page', 'data-page': String(page.page + 1), disabled: page.page >= page.pages, 'aria-label': 'Next page' }, 'Next', icon('chev-r')),
      el('button', { class: 'small pg-edge', 'data-action': 'page', 'data-page': String(page.pages), disabled: page.page >= page.pages, 'aria-label': 'Last page' }, 'Last', icon('chevs-r')),
    );
  }
  if (state.selected.size) {
    host.append(el('span', { class: 'muted', text: `${state.selected.size} selected across pages` }));
  }
  announceBoard(page);
}

/**
 * Say out loud what the board now holds.
 *
 * Debounced, and silent when the count has not moved: every keystroke in the
 * search box reloads the board, and a live region that repeats "1,204 jobs"
 * five times while you type is worse than one that says nothing.
 */
export let announceTimer = null;
export let lastAnnounced = null;
export function announceBoard(page) {
  const tab = TABS.find(([key]) => key === state.activeTab);
  const scope = state.activeTab === 'all' ? '' : ` in ${tab ? tab[1] : state.activeTab}`;
  const filters = hasActiveFilters() ? ', filtered' : '';
  const message = page.total === 0
    ? `No jobs match${scope ? ` ${scope.trim()}` : ''}${filters}.`
    : `${fmt(page.total)} job${page.total === 1 ? '' : 's'}${scope}${filters}.`;
  if (message === lastAnnounced) return;
  lastAnnounced = message;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { $('boardAnnounce').textContent = message; }, 500);
}
