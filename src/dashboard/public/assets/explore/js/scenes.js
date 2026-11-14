/**
 * The chapters of the Product Overview that are pictures: the field of
 * postings behind the headline, the problem, the five chapter sheets the
 * example posting passes through, the two signals only a person can clear,
 * what JobAgent never does, and the map under the hood.
 *
 * Everything here builds the FINISHED picture: the list already sorted, the
 * score already counted, the form already filled. That is what a reader with
 * reduced motion, a phone, or no script animation sees. The choreography that
 * plays each picture from its "before" to this state lives in motion.js and
 * only ever animates toward what is built here.
 *
 * The pictures are built from the illustrative data in content-overview.js,
 * and every score on the page comes from the model the Score Lab uses.
 */
import { h, icon, marked } from './dom.js';
import { statusBadge, topicLink } from './ui.js';
import { LINE_OF, setRuler, tierRuler } from './journey.js';
import { NET, NET_SIGNALS, NET_SIZE, netDrawing } from './deep.js';
import {
  JOURNEY, GATES, EXAMPLE_JOB, PROBLEM, HOOD, HERO_FIELD, BOUNDARIES, DISCOVER_DEMO, SCORE_EXCERPT, TAILOR_DEMO,
  FILL_DEMO, TRACK_DEMO, TRACK_STAGES, SOURCE_GROUPS, SOURCES, SOURCE_MODES,
} from './content-overview.js';
import { DEFAULT_INPUTS, PRESETS, scoreInputs } from './score-model.js';

/** The ground each chapter sheet is played on (tokens.css, Grounds). */
export const GROUND_OF = Object.freeze({ discover: 'night', score: 'ivory', tailor: 'forest', fill: 'mist', track: 'plum' });

const slug = (text) => String(text).toLowerCase().replace(/\s+/g, '-');
const points = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const two = (n) => String(n).padStart(2, '0');
const example = scoreInputs();

/** Each word in its own span, so a statement can be lit word by word. Spaces stay real text. */
function words(text) {
  return String(text).split(' ').flatMap((word, index) => [index ? ' ' : null, h('span', { class: 'ex-w', text: word })]);
}

/** An illustrative picture with its caption. */
function figure(className, children, caption = 'Illustrative example') {
  return h('figure', { class: `ex-demo ${className}` }, children, h('figcaption', { class: 'ex-demo-cap', text: caption }));
}

/* ───────────────────────── hero: a morning of postings ───────────────────────── */

/**
 * Where each card floats: left and top as a share of the field, depth in
 * pixels, and a turn. Placed by hand so no card covers the example posting's
 * score, and the field reads as a cloud with a clear front.
 */
const FIELD_AT = Object.freeze([
  { x: 4, y: 2, z: -520, r: -9 }, { x: 54, y: -2, z: -360, r: 7 }, { x: 26, y: 12, z: -760, r: 3 },
  { x: 66, y: 24, z: -180, r: 11 }, { x: -2, y: 40, z: -260, r: -13 }, { x: 48, y: 58, z: -620, r: -5 },
  { x: 64, y: 70, z: -380, r: 9 }, { x: 6, y: 72, z: -560, r: -7 }, { x: 34, y: 84, z: -260, r: 5 },
  { x: 58, y: 90, z: -720, r: -10 },
]);

/**
 * The field: one morning of postings in depth, with the example posting at
 * the front, scored. One picture to assistive technology.
 */
export function heroField() {
  const card = (posting, at, ours = false) => h('div', {
    class: `ex-fcard${ours ? ' is-ours' : ''}`,
    // Further away is softer, the way a lens focused on the front card sees the rest.
    style: `--x:${at.x}%;--y:${at.y}%;--z:${at.z}px;--r:${at.r}deg;--blur:${Math.max(0, (-at.z - 300) / 200).toFixed(1)}px`,
    dataset: { depth: String(at.z) },
  },
  h('span', { class: 'ex-fcard-src', text: posting.source }),
  h('span', { class: 'ex-fcard-title', text: posting.title }),
  h('span', { class: 'ex-fcard-co', text: posting.company }),
  ours
    ? h('span', { class: 'ex-fcard-score' },
      h('span', { class: 'ex-fcard-num', text: String(example.total) }),
      h('span', { class: `ex-tier ex-tier-${slug(example.tier)}`, text: example.tier }))
    : h('span', { class: 'ex-fcard-bars', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')));
  const cards = HERO_FIELD.map((posting, i) => card(posting, FIELD_AT[i % FIELD_AT.length]));
  const ours = card({ title: EXAMPLE_JOB.title, company: EXAMPLE_JOB.company, source: EXAMPLE_JOB.source }, { x: 22, y: 33, z: 90, r: -4 }, true);
  return h('div', {
    class: 'ex-crowd', role: 'img',
    'aria-label': `A morning of job postings from many boards. One, ${EXAMPLE_JOB.title} at ${EXAMPLE_JOB.company}, comes to the front with a score of ${example.total}: ${example.tier}.`,
  }, h('div', { class: 'ex-crowd-space' }, cards, ours));
}

/* ───────────────────────── the problem ───────────────────────── */

export function problem() {
  return h('section', { class: 'ex-chapter ex-problem', id: 'why', 'aria-labelledby': 'whyTitle' },
    h('h2', { class: 'ex-say', id: 'whyTitle', tabindex: '-1' },
      PROBLEM.lines.flatMap((line, index) => [index ? ' ' : null, h('span', { class: 'ex-say-line' }, words(line))])),
    h('p', { class: 'ex-say ex-say-turn' }, words(PROBLEM.turn)),
    h('ol', { class: 'ex-contrast', 'aria-label': 'Three ways to look for work' }, PROBLEM.contrast.map((row) => h('li', { class: row.ours ? 'is-ours' : null },
      h('span', { class: 'ex-contrast-who', text: row.who }),
      h('span', { class: 'ex-contrast-what', text: row.what })))),
    h('p', { class: 'ex-problem-who', text: PROBLEM.who }));
}

/* ───────────────────────── the chapter sheet ───────────────────────── */

/**
 * One chapter: a sheet that holds while its picture plays, then is covered by
 * the next. The stage carries the ground; the section is only its runway.
 * `layout` names the composition: split has the words on the left, split-flip
 * on the right.
 */
function scene(stage, index, layout, picture) {
  const beats = h('ol', { class: 'ex-beats' }, stage.beats.map((beat, i) => h('li', { class: 'ex-beat', dataset: { beat: String(i) } },
    h('span', { class: 'ex-beat-name' }, h('span', { class: 'ex-beat-n', 'aria-hidden': 'true', text: two(i + 1) }), beat.name, beat.status ? [' ', statusBadge(beat.status)] : null),
    h('span', { class: 'ex-beat-text', text: beat.text }))));
  return h('section', {
    class: `ex-chapter ex-scene ex-sheet-chapter ex-scene-${stage.id}`, id: `station-${stage.id}`, 'aria-labelledby': `station-${stage.id}-name`,
    dataset: { line: LINE_OF[stage.id], layout, scene: stage.id },
  }, h('div', { class: 'ex-scene-stage ex-plate', dataset: { ground: GROUND_OF[stage.id] } },
    // The sheet's corner: the chapter's name, where it falls, and the one fact it proves.
    h('div', { class: 'ex-chrome' },
      h('h2', { class: 'ex-scene-name', id: `station-${stage.id}-name`, tabindex: '-1' }, h('span', { class: 'ex-scene-dot', 'aria-hidden': 'true' }), stage.name),
      h('span', { class: 'ex-chrome-at' }, h('span', { class: 'ex-chrome-n', text: two(index + 1) }), h('span', { class: 'ex-chrome-of', text: ` of ${two(JOURNEY.length)}` })),
      h('span', { class: 'ex-chrome-fact', text: stage.fact })),
    h('div', { class: 'ex-scene-inner' },
      h('header', { class: 'ex-scene-head' },
        h('p', { class: 'ex-scene-claim', text: stage.title }),
        h('p', { class: 'ex-scene-body', text: stage.body })),
      h('div', { class: 'ex-scene-notes' },
        beats,
        h('p', { class: 'ex-yours' }, h('span', { class: 'ex-yours-label', text: 'Stays yours' }), stage.yours),
        topicLink(stage.topic, stage.more)),
      h('div', { class: 'ex-scene-pic' }, picture)),
    // How far this chapter has played, drawn as the line it runs on.
    h('span', { class: 'ex-scene-rail', 'aria-hidden': 'true' }),
    // The shade that falls on a sheet as the next one covers it.
    h('span', { class: 'ex-shade', 'aria-hidden': 'true' })));
}

/**
 * A gate between two chapters: a red sheet with a black signal head, set at
 * danger. The posting runs up the line and waits short of it. Nothing on the
 * line moves past this point until a person lets it.
 */
function gate(g, index) {
  const after = JOURNEY.find((s) => s.id === g.after);
  const id = `signal-${g.after}`;
  return h('section', {
    class: 'ex-chapter ex-gate ex-sheet-chapter', id, 'aria-labelledby': `${id}-title`,
    dataset: { line: LINE_OF[after.id], gate: g.after },
  }, h('div', { class: 'ex-gate-stage ex-plate', dataset: { ground: 'signal' } },
    h('div', { class: 'ex-chrome' },
      h('span', { class: 'ex-chrome-at' }, h('span', { class: 'ex-chrome-n', text: `Signal ${index + 1}` }), h('span', { class: 'ex-chrome-of', text: ` of ${GATES.length}` })),
      h('span', { class: 'ex-chrome-fact', text: g.fact })),
    h('div', { class: 'ex-gate-inner' },
      h('h2', { class: 'ex-gate-title', id: `${id}-title` }, words(`${g.label}.`)),
      h('div', { class: 'ex-gate-head', 'aria-hidden': 'true' },
        h('span', { class: 'ex-gate-lamp is-stop' }), h('span', { class: 'ex-gate-lamp is-clear' })),
      h('div', { class: 'ex-gate-track', 'aria-hidden': 'true' },
        h('span', { class: 'ex-gate-rail' }),
        h('span', { class: 'ex-gate-ahead' }),
        h('span', { class: 'ex-gate-stopline' }),
        h('span', { class: 'ex-gate-token' }, h('span', { class: 'ex-gate-tag', text: EXAMPLE_JOB.title }))),
      h('p', { class: 'ex-gate-text', text: g.detail })),
    h('span', { class: 'ex-shade', 'aria-hidden': 'true' })));
}

/* ───────────────────────── 1. Discover ───────────────────────── */

function discoverScene(stage, index) {
  const face = (row) => {
    const [source, ...rest] = row.meta.split(', ');
    return [
      h('span', { class: 'ex-board-src', text: source }),
      h('span', { class: 'ex-board-main' },
        h('span', { class: 'ex-board-title', text: row.title }),
        h('span', { class: 'ex-board-meta', text: `${row.company}, ${rest.join(', ')}` })),
    ];
  };
  const rows = DISCOVER_DEMO.map((row) => h('li', { class: `ex-board-row ex-board-${row.outcome}` },
    // The merged role first arrives as three separate postings. The two extra
    // copies are part of the animation only: the finished list has one row.
    row.outcome === 'merged' ? [1, 2].map(() => h('span', { class: 'ex-board-copy', 'aria-hidden': 'true' }, face(row))) : null,
    face(row),
    h('span', { class: 'ex-board-out', text: row.label })));
  const asked = SOURCES.filter((s) => s.mode === 'on').slice(0, 6);
  const board = figure('ex-board', [
    h('p', { class: 'ex-feeders' }, h('span', { class: 'ex-feeders-label', text: 'Asked in one run' }),
      asked.map((s) => h('span', { class: 'ex-feeder', text: s.name })),
      h('a', { class: 'ex-feeder ex-feeder-more', href: '#sources', text: `and ${SOURCES.length - asked.length} more` })),
    h('div', { class: 'ex-plane-wrap' }, h('ul', { class: 'ex-board-rows ex-plane' }, rows)),
  ]);
  // A link inside the page, not a route: bring the list into view and move focus to it.
  board.querySelector('.ex-feeder-more').addEventListener('click', (event) => {
    event.preventDefault();
    const target = document.getElementById('sources');
    target?.scrollIntoView({ block: 'start' });
    target?.querySelector('h3')?.focus({ preventScroll: true });
  });
  return scene(stage, index, 'split', board);
}

/** Where the postings come from: every adapter, by kind, filterable. */
function sourcesBlock() {
  let mode = 'all';
  const chips = [];
  const count = h('p', { class: 'ex-feed-count', role: 'status' });
  const filters = [['all', 'All sources'], ...Object.entries(SOURCE_MODES)].map(([id, text]) => h('button', {
    type: 'button', class: 'ex-chip', 'aria-pressed': String(id === 'all'), dataset: { mode: id },
    onClick: () => { mode = id; paint(); },
  }, id === 'all' ? null : h('span', { class: `ex-mode ex-mode-${id}`, 'aria-hidden': 'true' }), text));
  function paint() {
    for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    for (const { el, source } of chips) el.classList.toggle('is-muted', mode !== 'all' && source.mode !== mode);
    const shown = mode === 'all' ? SOURCES.length : SOURCES.filter((s) => s.mode === mode).length;
    count.textContent = `${shown} of ${SOURCES.length} source adapters`;
  }
  const block = h('div', { class: 'ex-sources', id: 'sources', role: 'region', 'aria-labelledby': 'sourcesTitle', dataset: { line: 'find' } },
    h('div', { class: 'ex-feeds' },
      h('div', { class: 'ex-feeds-head' },
        h('h3', { class: 'ex-h3', id: 'sourcesTitle', tabindex: '-1', text: 'Where the postings come from' }),
        h('p', { class: 'ex-feeds-lede', text: 'Public endpoints only. JobAgent never logs in to a job board, and sources that need an account stay off until you add your own key.' }),
        h('div', { class: 'ex-chips', role: 'group', 'aria-label': 'Filter sources' }, filters),
        count),
      h('div', { class: 'ex-feed-groups' }, SOURCE_GROUPS.map((group) => h('div', { class: 'ex-feed' },
        h('h3', { class: 'ex-feed-name', text: group.name }),
        h('ul', { class: 'ex-feed-list' }, SOURCES.filter((s) => s.group === group.id).map((source) => {
          const el = h('li', { class: 'ex-source' },
            h('span', { class: `ex-mode ex-mode-${source.mode}`, 'aria-hidden': 'true' }),
            h('span', { class: 'ex-source-name', text: source.name }),
            h('span', { class: 'sr-only', text: `, ${SOURCE_MODES[source.mode]}` }));
          chips.push({ el, source });
          return el;
        })))))));
  paint();
  return block;
}

/* ───────────────────────── 2. Score ───────────────────────── */

/** Posting text where {braces} mark a profile skill found in it. */
function hits(text) {
  return String(text).split(/(\{[^}]+\})/g).filter(Boolean).map((part) => (
    part.startsWith('{') ? h('strong', { class: 'ex-hit', text: part.slice(1, -1) }) : part));
}

function scoreScene(stage, index) {
  const number = h('span', { class: 'ex-score-num' });
  const tier = h('span', { class: 'ex-tier' });
  const note = h('p', { class: 'ex-score-note', role: 'status' });
  const rulerSlot = h('div', { class: 'ex-score-ruler' });
  const other = h('p', { class: 'ex-posting-other' });
  let ruler = null;
  const rows = scoreInputs(DEFAULT_INPUTS).rows.map((row) => {
    const fill = h('span', { class: 'ex-bar-fill' });
    const num = h('span', { class: 'ex-bar-num' });
    return { id: row.id, fill, num, el: h('li', { class: 'ex-bar', dataset: { row: row.id } },
      h('span', { class: 'ex-bar-label', text: row.label }),
      h('span', { class: 'ex-bar-track', 'aria-hidden': 'true' }, fill), num) };
  });
  const buttons = PRESETS.map((preset) => h('button', {
    type: 'button', class: 'ex-chip', 'aria-pressed': 'false', dataset: { preset: preset.id },
    onClick: () => show(preset),
  }, preset.name));

  const card = figure('ex-scorecard', [
    h('div', { class: 'ex-posting' },
      h('p', { class: 'ex-posting-title', text: EXAMPLE_JOB.title }),
      h('p', { class: 'ex-posting-co', text: `${EXAMPLE_JOB.company}, ${EXAMPLE_JOB.location}` }),
      h('div', { class: 'ex-posting-text' },
        h('p', {}, h('span', { class: 'ex-posting-label', text: 'Requirements' }), hits(SCORE_EXCERPT.requires)),
        h('p', {}, h('span', { class: 'ex-posting-label', text: 'Nice to have' }), hits(SCORE_EXCERPT.prefers))),
      other),
    h('div', { class: 'ex-score-main' },
      h('div', { class: 'ex-score-figure' }, number, h('span', { class: 'ex-score-side' }, h('span', { class: 'ex-score-of', text: 'out of 100' }), tier)),
      rulerSlot,
      note),
    h('ul', { class: 'ex-bars' }, rows.map((r) => r.el)),
    h('p', { class: 'ex-meaning' }, statusBadge('optional'), h('span', { class: 'ex-meaning-name', text: SCORE_EXCERPT.meaning.label }), h('span', { class: 'ex-meaning-note', text: SCORE_EXCERPT.meaning.note })),
    h('div', { class: 'ex-score-presets' },
      h('span', { class: 'ex-score-presets-label', id: 'scorePresets', text: 'Try a different posting' }),
      h('div', { class: 'ex-chips', role: 'group', 'aria-labelledby': 'scorePresets' }, buttons)),
  ], 'Illustrative example, computed by the same arithmetic as the real scorer.');

  function show(preset) {
    const result = scoreInputs({ ...DEFAULT_INPUTS, ...preset.inputs });
    // motion.js counts to `data-total` while the scene plays; a choice made
    // here is shown at once, and takes the picture out of the scrub's hands.
    number.dataset.total = String(result.total);
    number.textContent = String(result.total);
    delete card.dataset.scrub;
    card.dataset.preset = preset.id;
    tier.textContent = result.tier;
    tier.className = `ex-tier ex-tier-${slug(result.tier)}`;
    note.textContent = result.held
      ? `Scored as ${result.rawTier}, held in Queue. ${result.heldReason}`
      : 'Every point has a reason you can read on the job.';
    note.classList.toggle('is-held', Boolean(result.held));
    other.textContent = preset.id === PRESETS[0].id ? '' : `Another posting: ${preset.name.toLowerCase()}.`;
    if (ruler) setRuler(ruler, result.total);
    else rulerSlot.replaceChildren(ruler = tierRuler(result.total));
    for (const row of rows) {
      const r = result.rows.find((x) => x.id === row.id);
      row.fill.style.setProperty('--v', (r.points / r.weight).toFixed(3));
      row.num.textContent = `${points(r.points)} / ${r.weight}`;
    }
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.preset === preset.id));
  }
  show(PRESETS[0]);

  return scene(stage, index, 'split-flip', card);
}

/* ───────────────────────── 3. Tailor ───────────────────────── */

function tailorScene(stage, index) {
  const ordinal = ['1st', '2nd', '3rd', '4th'];
  const master = TAILOR_DEMO.bullets;
  const tailored = [...master].sort((a, b) => a.rank - b.rank);
  const sheet = (title, list, { strong }) => h('div', { class: `ex-sheet${strong ? ' ex-sheet-tailored' : ' ex-sheet-master'}` },
    h('p', { class: 'ex-sheet-tab' }, title, strong ? null : h('span', { class: 'ex-sheet-lock' }, icon('lock', { size: 13 }), 'Read-only')),
    h('p', { class: 'ex-sheet-role', text: 'Data Engineer, Contoso Health' }),
    h('ul', { class: 'ex-sheet-bullets' }, list.map((b) => {
      const was = master.indexOf(b);
      const now = list.indexOf(b);
      return h('li', { class: 'ex-sheet-bullet', dataset: { bullet: b.id, was: String(was) } },
        h('span', { class: 'ex-sheet-text' }, marked(b.text, { strong })),
        strong && was !== now ? h('span', { class: 'ex-sheet-moved', text: `was ${ordinal[was]}` }) : null);
    })),
    h('p', { class: 'ex-sheet-skills' }, h('span', { class: 'ex-sheet-label', text: 'Skills' }),
      (strong ? TAILOR_DEMO.skills.tailored : TAILOR_DEMO.skills.master).join(', ')));

  const spread = figure('ex-spread', [
    h('p', { class: 'ex-wanted' }, h('span', { class: 'ex-wanted-label', text: 'The posting asks for' }),
      TAILOR_DEMO.wanted.map((term) => h('span', { class: `ex-want${term === TAILOR_DEMO.gap ? ' is-gap' : ''}`, text: term }))),
    h('div', { class: 'ex-sheets' },
      sheet('Master resume', master, { strong: false }),
      sheet('Tailored for this job', tailored, { strong: true })),
    h('p', { class: 'ex-gap' }, icon('note', { size: 16 }),
      h('span', {}, h('strong', { text: TAILOR_DEMO.gap }), ' is in the posting and not in this resume. It is reported as a gap and never added.')),
  ], 'Illustrative example. The same four bullets on both sheets, in a different order.');

  // Pointing at a bullet shows where the same sentence sits on the other sheet.
  spread.addEventListener('pointerover', (event) => {
    const id = event.target.closest?.('[data-bullet]')?.dataset.bullet;
    for (const el of spread.querySelectorAll('[data-bullet]')) el.classList.toggle('is-linked', Boolean(id) && el.dataset.bullet === id);
  });
  spread.addEventListener('pointerleave', () => { for (const el of spread.querySelectorAll('.is-linked')) el.classList.remove('is-linked'); });

  return scene(stage, index, 'split', spread);
}

/* ───────────────────────── 4. Fill ───────────────────────── */

function fillScene(stage, index) {
  const form = figure('ex-formfig', h('div', { class: 'ex-window' },
    h('p', { class: 'ex-window-bar' },
      h('span', { class: 'ex-window-url', text: `${EXAMPLE_JOB.company} application, on ${EXAMPLE_JOB.source}` }),
      h('span', { class: 'ex-window-note', text: 'In a browser window you can watch' })),
    h('div', { class: 'ex-form' },
      h('span', { class: 'ex-scanline', 'aria-hidden': 'true' }),
      FILL_DEMO.map((field) => h('div', { class: `ex-field ex-field-${field.state}` },
        h('span', { class: 'ex-field-label', text: field.label }),
        // What the field was recognised as gives way to where its answer comes from.
        h('span', { class: 'ex-field-tag' },
          h('span', { class: 'ex-field-kind', 'aria-hidden': 'true', text: field.kind }),
          h('span', { class: 'ex-field-from', text: field.from })),
        h('span', { class: 'ex-field-box' }, field.state === 'ask'
          ? h('span', { class: 'ex-field-ask', text: 'Left for you' })
          : [h('span', { class: 'ex-field-value', text: field.value }), h('span', { class: 'ex-field-ok' }, icon('check', { size: 15, label: 'Checked after typing' }))]))),
      h('div', { class: 'ex-halt' },
        h('span', { class: 'ex-halt-text' }, h('span', { class: 'ex-band-lamp', 'aria-hidden': 'true' }), 'JobAgent stops here'),
        h('span', { class: 'ex-halt-button', text: 'Submit application' }),
        h('span', { class: 'ex-halt-yours', text: 'Your click' })))));
  return scene(stage, index, 'split-flip', form);
}

/* ───────────────────────── 5. Track ───────────────────────── */

function trackScene(stage, index) {
  const { names, to } = TRACK_STAGES;
  const app = h('div', { class: 'ex-app' },
    h('span', { class: 'ex-app-title', text: EXAMPLE_JOB.title }),
    h('span', { class: 'ex-app-co', text: EXAMPLE_JOB.company }),
    h('span', { class: 'ex-app-chip', text: 'Follow-up due Thu' }));
  const board = h('ol', { class: 'ex-stages', 'aria-label': 'Outcome' }, names.map((text, i) => h('li', {
    class: `ex-stage${i === to ? ' is-current' : i < to ? ' is-past' : ''}`, 'aria-current': i === to ? 'step' : null,
  }, h('span', { class: 'ex-stage-name', text }), h('span', { class: 'ex-stage-slot' }, i === to ? app : null))));
  const history = h('ol', { class: 'ex-history' }, TRACK_DEMO.map((event) => h('li', { class: 'ex-event', dataset: { beat: String(event.beat) } },
    h('span', { class: 'ex-event-when', text: event.when }),
    h('span', { class: 'ex-event-what' }, event.beat === 1 ? [icon('mail', { size: 15 }), ' '] : null, event.what),
    h('span', { class: `ex-event-who${event.who === 'You' ? ' is-you' : ''}`, text: event.who }))));
  return scene(stage, index, 'split', figure('ex-trackfig', [board, history]));
}

const BUILDERS = { discover: discoverScene, score: scoreScene, tailor: tailorScene, fill: fillScene, track: trackScene };

/** The five chapters in order, with a signal after Tailor and after Fill. */
export function buildScenes() {
  const sections = [];
  JOURNEY.forEach((stage, index) => {
    sections.push(BUILDERS[stage.id](stage, index));
    const g = GATES.find((x) => x.after === stage.id);
    if (g) sections.push(gate(g, GATES.indexOf(g)));
  });
  return sections;
}

/* ───────────────────────── never ───────────────────────── */

/** What JobAgent will not do, set as large as the claims it answers. */
export function never() {
  return h('section', { class: 'ex-chapter ex-never', id: 'boundaries', 'aria-labelledby': 'neverTitle', dataset: { ground: 'ink' } },
    h('div', { class: 'ex-never-inner' },
      h('div', { class: 'ex-never-side' },
        h('h2', { id: 'neverTitle', class: 'ex-never-word', tabindex: '-1', text: 'Never.' }),
        h('p', { class: 'ex-never-lede', text: 'What JobAgent will not do. Each line is a rule in the code with a test behind it, not a setting you could switch off by accident.' }),
        topicLink('security', 'How these are enforced')),
      h('ul', { class: 'ex-never-list' }, BOUNDARIES.never.map((text) => {
        const [first, ...rest] = text.split('. ');
        return h('li', {}, h('span', { class: 'ex-never-rule', text: rest.length ? `${first}.` : first }),
          rest.length ? h('span', { class: 'ex-never-more', text: rest.join('. ') }) : null);
      })),
      h('div', { class: 'ex-does' },
        h('h3', { class: 'ex-h3', text: 'What it does on its own' }),
        h('ul', { class: 'ex-does-list' }, BOUNDARIES.does.map((text) => h('li', {}, icon('check', { size: 16 }), h('span', { text })))))));
}

/* ───────────────────────── under the hood ───────────────────────── */

/**
 * The system map as a picture: the Deep Dive's own network, drawn with the
 * same coordinates, so the teaser cannot show an architecture the real
 * diagram does not. The interactive one is a click away.
 */
export function hood() {
  const [w, hgt] = NET_SIZE;
  const stations = Object.entries(NET).map(([id, at]) => h('span', {
    class: 'ex-hood-node', dataset: { line: at.line.split(' ')[0], node: id, ...(at.up ? { up: '' } : {}) }, style: `--x:${at.x};--y:${at.y}`,
  }, h('span', { class: 'ex-hood-dot' }), h('span', { class: 'ex-hood-name', text: at.short })));
  const gates = NET_SIGNALS.map((s) => h('span', { class: 'ex-hood-gate', style: `--x:${s.x};--y:${s.y}`, text: s.label }));
  const map = h('div', {
    class: 'ex-hoodmap', role: 'img', style: `--w:${w};--h:${hgt}`,
    'aria-label': 'The system map: postings come in along the Find line to the database, the Apply line runs from the pipeline through tailoring, your two approvals and the browser to the application site, and the Track line carries outcomes. Every way in shares one local server.',
  }, netDrawing(), stations, gates);
  return h('section', { class: 'ex-chapter ex-hood', id: 'hood', 'aria-labelledby': 'hoodTitle' },
    h('div', { class: 'ex-hood-head' },
      h('h2', { class: 'ex-big ex-hood-title', id: 'hoodTitle', tabindex: '-1', text: HOOD.title }),
      h('div', { class: 'ex-hood-side' },
        h('p', { class: 'ex-lede', text: HOOD.body }),
        h('a', { class: 'ex-btn ex-btn-solid', href: '#/how' }, HOOD.cta, icon('arrow', { size: 16 })))),
    map,
    h('ul', { class: 'ex-hood-facts' }, HOOD.facts.map((fact) => h('li', {},
      h('span', { class: 'ex-hood-fact', text: fact.name }), h('span', { class: 'ex-hood-fact-text', text: fact.text })))),
    sourcesBlock());
}
