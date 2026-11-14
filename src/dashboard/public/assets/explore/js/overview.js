/**
 * The Product Overview, told in the order a first-time reader needs it:
 *
 *   1. the claim, over a morning of postings with one brought to the front
 *   2. the problem, read at the reader's pace
 *   3. five chapter sheets the example posting passes through, with the two
 *      signals only a person can clear between them
 *   4. what JobAgent never does
 *   5. what it is made of, and where its postings come from
 *   6. the whole line, run by the reader's own hand
 *   7. the register of what is built, and the next step
 *
 * A chapter rail (pinned layout only) shows where the reader is on the line.
 */
import { h, icon, prefersReducedMotion } from './dom.js';
import { statusBadge } from './ui.js';
import { buildRoute, LINE_OF } from './journey.js';
import { buildScenes, heroField, hood, never, problem } from './scenes.js';
import { CAPABILITIES, CAPABILITY_AREAS, GATES, HERO, JOURNEY, SOURCES, STATUS } from './content-overview.js';

function hero() {
  const proof = [`${SOURCES.length} ${HERO.proof[0]}`, ...HERO.proof.slice(1)];
  return h('section', { class: 'ex-chapter ex-hero', 'aria-labelledby': 'heroTitle' },
    h('h1', { id: 'heroTitle', class: 'ex-hero-title' },
      // Each line rises out of its own mask on load; the outer span is the mask.
      h('span', { class: 'ex-line' }, h('span', { text: 'All the work.' })), ' ',
      // The full stop is drawn as the line's signal lamp: the call is the
      // moment the line is held for you. The real "." stays for assistive tech.
      h('span', { class: 'ex-line ex-hero-call' }, h('span', {}, 'Your call',
        h('span', { class: 'sr-only', text: '.' }), h('span', { class: 'ex-lamp', 'aria-hidden': 'true' })))),
    heroField(),
    h('div', { class: 'ex-hero-foot' },
      h('p', { class: 'ex-lede', text: HERO.lede }),
      h('div', { class: 'ex-actions' },
        h('a', { class: 'ex-btn ex-btn-solid', href: '#/overview/discover' }, HERO.primary, icon('arrow', { size: 16 })),
        h('a', { class: 'ex-btn', href: '#/how' }, HERO.secondary))),
    h('ul', { class: 'ex-hero-proof' }, proof.map((text) => h('li', { text }))));
}

/**
 * The chapter rail: the line itself, as a small pill at the foot of the
 * window while the chapters play. Each station is a link to its chapter; the
 * two signals sit between them. motion.js moves the fill and marks the
 * chapter in view.
 */
function rail() {
  const items = [];
  for (const stage of JOURNEY) {
    items.push(h('li', { class: 'ex-rail-stop', dataset: { stop: stage.id, line: LINE_OF[stage.id] } },
      h('a', { href: `#/overview/${stage.id}`, 'aria-label': stage.name }, h('span', { class: 'ex-rail-dot', 'aria-hidden': 'true' }))));
    if (GATES.some((g) => g.after === stage.id)) items.push(h('li', { class: 'ex-rail-signal', 'aria-hidden': 'true' }));
  }
  return h('nav', { class: 'ex-rail', 'aria-label': 'Chapters', dataset: { ground: 'ink' } },
    h('span', { class: 'ex-rail-now', 'aria-hidden': 'true' }),
    h('div', { class: 'ex-rail-line' }, h('span', { class: 'ex-rail-fill', 'aria-hidden': 'true' }), h('ol', {}, items)));
}

/** The whole line, once more, run by the reader: the posting waits at each signal for their click. */
function runIt(route) {
  const section = h('section', { class: 'ex-chapter ex-run', id: 'run', 'aria-labelledby': 'runTitle' },
    h('div', { class: 'ex-run-head' },
      h('h2', { id: 'runTitle', class: 'ex-big', tabindex: '-1', text: 'Now run the line yourself.' }),
      h('p', { class: 'ex-lede', text: 'The posting moves on its own until it reaches a signal. Then it waits for you, as it does in the dashboard.' })),
    h('div', { class: 'ex-platform' }, route.root));
  // It sets off when it is first seen, not while the reader is still at the top.
  if (typeof IntersectionObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      setTimeout(() => route.start(), prefersReducedMotion() ? 0 : 450);
    }, { rootMargin: '0px 0px -25% 0px' });
    seen.observe(route.root);
  } else {
    route.start();
  }
  return section;
}

/** The register: every capability, grouped by area, with how finished it is. */
function ledger() {
  let filter = 'all';
  const counts = Object.fromEntries(Object.keys(STATUS).map((key) => [key, CAPABILITIES.filter((c) => c.status === key).length]));
  const buttons = [['all', 'Everything', CAPABILITIES.length], ...Object.entries(STATUS).map(([key, meta]) => [key, meta.label, counts[key]])]
    .map(([id, text, n]) => h('button', {
      type: 'button', class: 'ex-chip', 'aria-pressed': String(id === 'all'), dataset: { status: id },
      onClick: () => { filter = id; paint(); },
    }, text, h('span', { class: 'ex-count', text: String(n) })));
  const note = h('p', { class: 'ex-ledger-note', role: 'status' });
  const groups = CAPABILITY_AREAS.map((area, index) => {
    const rows = CAPABILITIES.filter((c) => c.area === area);
    const tally = h('span', { class: 'ex-ledger-tally' });
    const list = h('ul', { class: 'ex-ledger-rows' });
    // The first area starts open so the page shows what a row looks like.
    const el = h('details', { class: 'ex-ledger-group', open: index === 0 },
      h('summary', {}, h('span', { class: 'ex-ledger-area', text: area }), tally),
      list);
    return { area, rows, tally, list, el };
  });

  let painted = false;
  let settle = 0;
  function paint() {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.status === filter));
    // A filter change brings its rows in with a short rise; the first paint does not.
    section.classList.toggle('is-filtering', painted);
    clearTimeout(settle);
    if (painted) settle = setTimeout(() => section.classList.remove('is-filtering'), 900);
    painted = true;
    note.textContent = filter === 'all' ? 'Four states, used the same way everywhere on this page.' : `${STATUS[filter].label}: ${STATUS[filter].note}`;
    for (const group of groups) {
      const shown = group.rows.filter((c) => filter === 'all' || c.status === filter);
      group.el.hidden = shown.length === 0;
      // A filter is a question about rows, so matching groups open to answer it.
      if (filter !== 'all') group.el.open = true;
      group.tally.textContent = `${shown.length} ${shown.length === 1 ? 'capability' : 'capabilities'}`;
      group.list.replaceChildren(...shown.map((row, k) => h('li', { class: 'ex-ledger-row', style: `--k:${k}` },
        h('span', { class: 'ex-ledger-name', text: row.name }),
        h('span', { class: 'ex-ledger-what', text: row.what }),
        statusBadge(row.status),
        h('a', { class: 'ex-ledger-link', href: `#/how/${row.topic}`, 'aria-label': `How ${row.name} works` }, icon('arrow', { size: 14 })))));
    }
  }

  const section = h('section', { class: 'ex-chapter ex-ledger', id: 'ledger', 'aria-labelledby': 'ledgerTitle', dataset: { reveal: '' } },
    h('div', { class: 'ex-ledger-head' },
      h('h2', { id: 'ledgerTitle', class: 'ex-big', tabindex: '-1', text: 'What is built, and what is not yet' }),
      h('p', { class: 'ex-section-lede', text: 'A plain account of every capability and how finished it is. Optional features are complete and switched off. Planned ones do not exist yet.' }),
      h('div', { class: 'ex-chips', role: 'group', 'aria-label': 'Filter by status' }, buttons),
      note),
    h('div', { class: 'ex-ledger-body' }, groups.map((g) => g.el)));
  paint();
  return section;
}

function closing() {
  return h('section', { class: 'ex-chapter ex-close', 'aria-labelledby': 'closeTitle', dataset: { reveal: '' } },
    h('h2', { id: 'closeTitle', class: 'ex-close-title', text: 'It is already running on this computer.' }),
    h('div', { class: 'ex-close-side' },
      h('p', { class: 'ex-lede', text: 'This page came from the same local server that runs your job search. Nothing on it was fetched from the internet.' }),
      h('ol', { class: 'ex-next' }, ['Open the dashboard.', 'Press Find jobs.', 'Approve the packets you like.'].map((text) => h('li', { text }))),
      h('div', { class: 'ex-actions' },
        h('a', { class: 'ex-btn ex-btn-solid', href: '/' }, 'Open dashboard', icon('arrow', { size: 16 })),
        h('a', { class: 'ex-btn', href: '#/how' }, HERO.secondary))));
}

/** Build the whole Overview into `root`. Returns the route so the caller can reset it. */
export function renderOverview(root) {
  const route = buildRoute();
  root.replaceChildren(
    hero(),
    problem(),
    ...buildScenes(),
    never(),
    hood(),
    runIt(route),
    ledger(),
    closing(),
    rail());
  return route;
}
