/**
 * The Technical Deep Dive: a table of contents beside a long, sectioned read.
 * Every section is built from content-deep.js, so the words and the diagrams
 * share one source.
 */
import { h, rich, svg } from './dom.js';
import { fileList, flow, notesBlock, relationMap, statusBadge } from './ui.js';
import { buildScoreLab } from './scorelab.js';
import {
  ARCH_LAYERS, ARCH_NODES, STACK, RUN_STEPS, TRACES, LIFECYCLE_GROUPS, LIFECYCLE_STATES, LIFECYCLE_TRANSITIONS,
  DATA_TABLES, DATA_NOTES, SECURITY, API_GROUPS, CLI_GROUPS, MCP_TOOLS, QUALITY, DEEP_TOPICS,
} from './content-deep.js';
import { SCORE_MODEL } from './score-model.js';

/** A Deep Dive section. Its heading takes focus when a link jumps to it. */
function section(id, title, lede, ...children) {
  return h('section', { class: 'ex-topic', id: `topic-${id}`, 'aria-labelledby': `topic-${id}-title`, dataset: { topic: id, reveal: '' } },
    h('h2', { class: 'ex-h2', id: `topic-${id}-title`, tabindex: '-1', text: title }),
    lede ? h('p', { class: 'ex-section-lede' }, rich(lede)) : null,
    children);
}

/**
 * Where each part sits on the network diagram (a 980 by 520 grid), the short
 * name its station carries, and the line it is on. The drawing below and these
 * coordinates are one design: change them together.
 *
 *   y  60  profile and config (grey) above the scorer, and the optional inbox branch
 *   y 170  the Find line (blue) into the database, then the Track line (magenta)
 *   y 300  the Apply line (green), leaving the pipeline for the tailor, the
 *          packet, the two signals, the browser and the employer's site
 *   y 440  the control line (grey): every way in. The local server rises to
 *          the junction where the pipeline's branch turns.
 */
export const NET = Object.freeze({
  profile: { x: 420, y: 60, short: 'Profiles', line: 'control', up: true },
  config: { x: 560, y: 60, short: 'Config', line: 'control', up: true },
  inbox: { x: 770, y: 60, short: 'Inbox reader', line: 'track', up: true },
  mail: { x: 910, y: 60, short: 'Your mailbox', line: 'track', up: true },
  boards: { x: 70, y: 170, short: 'Job boards', line: 'find' },
  search: { x: 210, y: 170, short: 'Search', line: 'find' },
  pipeline: { x: 350, y: 170, short: 'Pipeline', line: 'find apply control', up: true },
  scoring: { x: 490, y: 170, short: 'Scoring', line: 'find control' },
  db: { x: 630, y: 170, short: 'Database', line: 'find track' },
  tracking: { x: 770, y: 170, short: 'Tracking', line: 'track' },
  files: { x: 910, y: 170, short: 'Documents', line: 'track' },
  model: { x: 70, y: 300, short: 'Model provider', line: 'apply' },
  llm: { x: 210, y: 300, short: 'LLM assist', line: 'apply' },
  resume: { x: 440, y: 300, short: 'Tailoring', line: 'apply' },
  packets: { x: 550, y: 300, short: 'Packets', line: 'apply' },
  automation: { x: 720, y: 300, short: 'Browser assist', line: 'apply' },
  sites: { x: 910, y: 300, short: 'Application sites', line: 'apply' },
  launcher: { x: 70, y: 440, short: 'Launchers', line: 'control' },
  dashboard: { x: 210, y: 440, short: 'Dashboard', line: 'control' },
  server: { x: 350, y: 440, short: 'Local server', line: 'control' },
  cli: { x: 490, y: 440, short: 'Command line', line: 'control' },
  mcp: { x: 630, y: 440, short: 'MCP server', line: 'control' },
  extension: { x: 770, y: 440, short: 'Extension', line: 'control' },
});
export const NET_SIZE = Object.freeze([980, 520]);
export const NET_SIGNALS = Object.freeze([{ x: 635, y: 300, label: 'You approve' }, { x: 815, y: 300, label: 'You submit' }]);
const NET_LINES = Object.freeze([
  { id: 'find', name: 'Find', note: 'postings in, verdicts stored' },
  { id: 'apply', name: 'Apply', note: 'tailor, packet, fill, with two signals' },
  { id: 'track', name: 'Track', note: 'outcomes, exports, replies' },
  { id: 'control', name: 'Control', note: 'ways in, profile and config' },
]);

/** The drawn lines of the network. Decorative: the stations are real buttons laid over it. */
export function netDrawing() {
  const path = (line, d, extra = {}) => svg('path', { class: `ex-net-line ex-net-${line}`, d, 'data-line': line, ...extra });
  return svg('svg', { class: 'ex-net-svg', viewBox: `0 0 ${NET_SIZE[0]} ${NET_SIZE[1]}`, 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'none' },
    // Control: profile and config feed the scorer; every way in shares one
    // line, and the local server rises to join the pipeline's branch.
    path('control', 'M420 60 H560 M490 60 V170'),
    path('control', 'M70 440 H770 M350 440 V300'),
    // Optional branches are dashed.
    path('track', 'M910 60 H770 V170', { 'data-optional': '' }),
    path('apply', 'M70 300 H350', { 'data-optional': '' }),
    path('find', 'M70 170 H630'),
    path('track', 'M630 170 H910'),
    path('apply', 'M350 170 V300 H910'),
    // Which way work flows: a light runs along a line while it is the one being followed.
    [['find', 'M70 170 H630'], ['track', 'M630 170 H910'], ['apply', 'M350 170 V300 H910']]
      .map(([line, d]) => svg('path', { class: 'ex-net-pulse', d, 'data-line': line, pathLength: 100 })),
    svg('circle', { class: 'ex-net-junction', cx: 350, cy: 300, r: 7 }),
    NET_SIGNALS.map((s) => svg('rect', { class: 'ex-net-signal', x: s.x - 9, y: s.y - 9, width: 18, height: 18, rx: 3, transform: `rotate(45 ${s.x} ${s.y})` })));
}

function systemMap() {
  const names = (list) => list.map((node) => node.name).join(', ');
  const map = relationMap({
    label: 'System map',
    groups: ARCH_LAYERS,
    nodes: ARCH_NODES.map((node) => ({ ...node, group: node.layer })),
    outgoing: (id) => ARCH_NODES.find((node) => node.id === id)?.talks ?? [],
    initial: 'pipeline',
    words: { out: 'It calls or reads', in: 'Calls it' },
    net: {
      size: NET_SIZE,
      place: (id) => NET[id] ?? null,
      drawing: netDrawing(),
      extras: NET_SIGNALS.map((s) => h('span', { class: 'ex-net-gate', 'aria-hidden': 'true', style: `--x:${s.x};--y:${s.y}`, text: s.label })),
    },
    detail: (node, related, select) => h('div', { class: 'ex-detail' },
      h('div', { class: 'ex-detail-main' },
        h('div', { class: 'ex-detail-head' }, h('h3', { class: 'ex-h3', text: node.name }), node.status ? statusBadge(node.status) : null),
        h('p', { class: 'ex-detail-role', text: node.role }),
        h('p', { class: 'ex-detail-body' }, rich(node.detail))),
      h('div', { class: 'ex-detail-side' },
        related.out.length ? h('div', { class: 'ex-detail-rel' },
          h('span', { class: 'ex-files-label', text: 'Calls or reads' }),
          h('div', { class: 'ex-detail-jumps' }, related.out.map((n) => h('button', { type: 'button', class: 'ex-chip ex-chip-sm', onClick: () => select(n.id), 'aria-label': `Show ${n.name}` }, n.name)))) : null,
        related.in.length ? h('p', { class: 'ex-detail-in' }, h('span', { class: 'ex-files-label', text: 'Called by' }), ' ', names(related.in)) : null,
        fileList(node.files, { label: 'Lives in' }))),
  });

  // The network draws itself west to east the first time it is seen.
  map.dataset.reveal = '';

  // Follow one line: the others step back so a single workflow can be read end to end.
  const board = map.querySelector('.ex-map-board');
  const lineButtons = [{ id: '', name: 'All lines' }, ...NET_LINES].map((line) => h('button', {
    type: 'button', class: `ex-chip ex-linekey${line.id ? ` ex-linekey-${line.id}` : ''}`, 'aria-pressed': String(line.id === ''),
    title: line.note ?? null,
    onClick: () => {
      if (line.id) board.dataset.focus = line.id; else delete board.dataset.focus;
      for (const b of lineButtons) b.setAttribute('aria-pressed', String(b.dataset.line === line.id));
    },
    dataset: { line: line.id },
  }, line.id ? h('span', { class: 'ex-linekey-swatch', 'aria-hidden': 'true' }) : null, line.name));
  map.querySelector('.ex-map-main').prepend(h('div', { class: 'ex-chips ex-net-keys', role: 'group', 'aria-label': 'Follow one line' }, lineButtons));
  return map;
}

function stackTable() {
  const kinds = { core: 'Always', optional: 'Only if enabled', dev: 'Development' };
  return h('div', { class: 'ex-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Technology stack' },
    h('table', { class: 'ex-table' },
      h('thead', {}, h('tr', {}, ['Part', 'What is used', 'Why', 'Loaded'].map((text) => h('th', { scope: 'col', text })))),
      h('tbody', {}, STACK.map((row) => h('tr', {},
        h('th', { scope: 'row', text: row.part }),
        h('td', {}, rich(row.what)),
        h('td', { class: 'ex-dim' }, rich(row.why)),
        h('td', {}, h('span', { class: `ex-kind ex-kind-${row.kind}`, text: kinds[row.kind] })))))));
}

function trace(t) {
  return section(t.id, t.title, t.summary,
    t.status ? h('p', { class: 'ex-topic-status' }, statusBadge(t.status)) : null,
    h('dl', { class: 'ex-facts' },
      h('div', {}, h('dt', { text: 'You see' }), h('dd', {}, rich(t.see))),
      h('div', {}, h('dt', { text: 'You get' }), h('dd', {}, rich(t.output)))),
    h('h3', { class: 'ex-h3 ex-flow-title', text: 'Behind the scenes' }),
    flow(t.steps, { label: `${t.title}: steps` }),
    t.notes?.length ? h('div', { class: 'ex-notes-group' }, t.notes.map(notesBlock)) : null);
}

function lifecycle() {
  const label = (id) => LIFECYCLE_STATES.find((s) => s.id === id)?.label ?? id;
  return relationMap({
    label: 'Job lifecycle',
    groups: LIFECYCLE_GROUPS,
    nodes: LIFECYCLE_STATES.map((state) => ({ ...state, name: state.label })),
    outgoing: (id) => LIFECYCLE_TRANSITIONS[id] ?? [],
    initial: 'prepared',
    words: { out: 'Can move to', in: 'Can come from' },
    detail: (node, related, select) => h('div', { class: 'ex-detail' },
      h('div', { class: 'ex-detail-head' }, h('h3', { class: 'ex-h3', text: node.label }), h('code', { class: 'ex-detail-id', text: node.id })),
      h('p', { class: 'ex-detail-body', text: node.note }),
      h('div', { class: 'ex-detail-rel' },
        h('span', { class: 'ex-files-label', text: 'Can move to' }),
        related.out.length
          ? h('div', { class: 'ex-detail-jumps' }, related.out.map((n) => h('button', { type: 'button', class: 'ex-chip ex-chip-sm', onClick: () => select(n.id), 'aria-label': `Show ${n.label}` }, n.label)))
          : h('span', { class: 'ex-dim', text: 'Nothing. This state is final.' })),
      related.in.length ? h('p', { class: 'ex-detail-in' }, h('span', { class: 'ex-files-label', text: 'Can come from' }), ' ', related.in.map((n) => label(n.id)).join(', ')) : null),
  });
}

function dataSection() {
  return [
    h('dl', { class: 'ex-deflist' }, DATA_TABLES.map((table) => h('div', {}, h('dt', {}, h('code', { text: table.name })), h('dd', { text: table.holds })))),
    h('ul', { class: 'ex-plainlist' }, DATA_NOTES.map((note) => h('li', {}, rich(note)))),
    fileList(['src/logging/db.js', 'src/logging/backup.js', 'src/logging/bundle.js', 'scripts/dbMaintenance.mjs'], { label: 'Lives in' }),
  ];
}

function securitySection() {
  return h('div', { class: 'ex-rules' }, SECURITY.map((rule) => h('details', { class: 'ex-notes ex-rule' },
    h('summary', {}, h('span', { class: 'ex-notes-title', text: rule.name })),
    h('p', { class: 'ex-rule-body' }, rich(rule.detail)),
    fileList(rule.files, { label: 'Enforced in' }))));
}

function interfacesSection() {
  return [
    h('h3', { class: 'ex-h3', text: 'HTTP API' }),
    h('p', { class: 'ex-section-lede', text: 'Served on 127.0.0.1 only. The most used routes, grouped by what they act on.' }),
    h('div', { class: 'ex-notes-group' }, API_GROUPS.map((group) => h('details', { class: 'ex-notes' },
      h('summary', {}, h('span', { class: 'ex-notes-title', text: group.name }), h('span', { class: 'ex-count', text: String(group.routes.length) })),
      h('ul', { class: 'ex-routes' }, group.routes.map((route) => {
        const [method, path] = route.split(' ');
        return h('li', {}, h('span', { class: `ex-method ex-method-${method.toLowerCase()}`, text: method }), h('code', { text: path }));
      }))))),
    fileList(['src/dashboard/server.js', 'src/dashboard/routes/boardRoutes.js', 'src/dashboard/routes/jobRoutes.js', 'src/dashboard/routes/batchRoutes.js', 'src/dashboard/routes/profileRoutes.js', 'src/dashboard/routes/systemRoutes.js', 'src/dashboard/routes/inboxRoutes.js'], { label: 'Routes live in' }),

    h('h3', { class: 'ex-h3', text: 'Command line' }),
    h('p', { class: 'ex-section-lede' }, rich('Run as `node src/index.js <command>` or the matching `npm run` script. No command submits an application.')),
    h('div', { class: 'ex-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Commands' },
      h('table', { class: 'ex-table' },
        h('thead', {}, h('tr', {}, ['Group', 'Command', 'What it does'].map((text) => h('th', { scope: 'col', text })))),
        h('tbody', {}, CLI_GROUPS.flatMap((group) => group.commands.map(([name, what], index) => h('tr', {},
          index === 0 ? h('th', { scope: 'rowgroup', rowspan: String(group.commands.length), class: 'ex-rowgroup', text: group.name }) : null,
          h('td', {}, h('code', { text: name })),
          h('td', { class: 'ex-dim', text: what }))))))),

    h('h3', { class: 'ex-h3' }, 'MCP server ', statusBadge('optional')),
    h('p', { class: 'ex-section-lede' }, rich('Start it with `npm run mcp`. It speaks over stdio, opens no port, and registers exactly these tools. A test fails if another one is ever added.')),
    h('ul', { class: 'ex-toollist' }, MCP_TOOLS.map((tool) => h('li', {}, h('code', { text: tool })))),

    h('h3', { class: 'ex-h3' }, 'Browser extension ', statusBadge('optional')),
    h('p', { class: 'ex-section-lede' }, rich('Load the `extension` folder as an unpacked extension in Chrome or Edge. It needs only the active tab, scripting and storage permissions, and may talk to localhost alone.')),
  ];
}

function qualitySection() {
  return h('dl', { class: 'ex-deflist' }, QUALITY.map((item) => h('div', {},
    h('dt', { text: item.name }),
    h('dd', {}, rich(item.detail), fileList(item.files, { label: 'See' })))));
}

/** Build the Deep Dive into `root`. Returns the topic ids, in order. */
export function renderDeep(root) {
  const t = SCORE_MODEL.tiers;
  const sections = {
    system: section('system', 'System map', 'Five ways in, one local server, an engine of plain modules, and your data on disk. Select any part to see what it does, what it calls, and where it lives in the repository.', systemMap()),
    stack: section('stack', 'Technology stack', 'Few dependencies, chosen so the app installs without a compiler and runs without a network.', stackTable()),
    run: section('run', 'One run, end to end', 'What happens between pressing Find jobs and seeing new rows. The same function runs from the dashboard, the command line and watch mode.', flow(RUN_STEPS, { label: 'Pipeline run: steps' })),
    scorelab: section('scorelab', 'Score lab', `The scoring arithmetic, live. Weights are those of a generated profile and sum to 100; the tiers start at ${t.nearMiss}, ${t.queue}, ${t.apply} and ${t.priority}. A test runs real postings through the real scorer and fails if this lab disagrees.`, buildScoreLab()),
    lifecycle: section('lifecycle', 'Job lifecycle', 'Every job has exactly one status. This is the pipeline’s own graph: a status move made by auto-fill or by you goes through one function that checks it and records an audit event. Two rules sit on top of it. You may mark any open job as submitted yourself, and an unexpected error can fail a job from any state. Select a state to see where it can go and how it is reached.', lifecycle()),
    data: section('data', 'Data and storage', 'One SQLite file per profile, four tables, and plain files beside it.', dataSection()),
    security: section('security', 'Security and privacy', 'The dashboard is a local web server, so it is defended like one.', securitySection()),
    interfaces: section('interfaces', 'API, CLI, MCP, extension', null, interfacesSection()),
    quality: section('quality', 'How it is tested', 'This page is covered too: its file references, lifecycle, command list and score model are checked against the code on every run.', qualitySection()),
  };
  for (const item of TRACES) sections[item.id] = trace(item);

  const links = DEEP_TOPICS.map((topic) => h('li', {}, h('a', { href: `#/how/${topic.id}`, dataset: { topic: topic.id }, text: topic.name })));
  root.replaceChildren(
    h('nav', { class: 'ex-toc', 'aria-label': 'Deep dive contents' }, h('ol', {}, links)),
    h('div', { class: 'ex-deep-body' },
      h('header', { class: 'ex-deep-head' },
        h('h1', { class: 'ex-display ex-display-sm', text: 'How JobAgent actually works' }),
        h('p', { class: 'ex-lede', text: 'The architecture, the algorithms and the data flow, traced from the source code. Each part names the files it lives in, so you can go from a sentence here to the function that does it.' })),
      DEEP_TOPICS.map((topic) => sections[topic.id])));
  return DEEP_TOPICS.map((topic) => topic.id);
}
