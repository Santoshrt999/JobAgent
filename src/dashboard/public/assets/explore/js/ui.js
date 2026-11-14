/**
 * Reusable pieces of the Explore page: status badges, file lists, the tab
 * pattern, the step-by-step flow and the relation map. Each returns a DOM node
 * and owns its own keyboard behaviour.
 */
import { h, icon, rich, nextId } from './dom.js';
import { STATUS } from './content-overview.js';

/** A status badge. The word carries the meaning; the colour only reinforces it. */
export function statusBadge(status) {
  const meta = STATUS[status];
  if (!meta) return null;
  return h('span', { class: `ex-status ex-status-${status}`, title: meta.note, text: meta.label });
}

/** The repository files a step or node lives in. */
export function fileList(files = [], { label = 'Runs in' } = {}) {
  if (!files.length) return null;
  return h('div', { class: 'ex-files' },
    h('span', { class: 'ex-files-label', text: label }),
    h('ul', { class: 'ex-files-list' }, files.map((file) => h('li', {}, h('code', { text: file })))));
}

/**
 * Wire the WAI-ARIA tabs keyboard pattern onto a list of tab buttons: arrows
 * move, Home and End jump, and only the selected tab is in the tab order.
 * Selection follows focus, which suits panels that render instantly.
 *
 * @param {HTMLElement[]} tabs
 * @param {(index: number, options: {focus: boolean}) => void} select
 * @param {{ vertical?: boolean }} [options]
 */
export function wireTabKeys(tabs, select, { vertical = false } = {}) {
  const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
  const next = vertical ? 'ArrowDown' : 'ArrowRight';
  tabs.forEach((tab, index) => {
    tab.addEventListener('keydown', (event) => {
      let target = null;
      if (event.key === next) target = (index + 1) % tabs.length;
      else if (event.key === prev) target = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = tabs.length - 1;
      if (target === null) return;
      event.preventDefault();
      select(target, { focus: true });
    });
  });
}

/**
 * A numbered flow: steps across the top, the selected step's explanation
 * below. Used for the pipeline run and for every feature trace.
 *
 * @param {Array<{name: string, detail: string, files?: string[], status?: string}>} steps
 * @param {{ label: string }} options accessible name of the step list
 */
export function flow(steps, { label }) {
  const id = nextId('flow');
  const panel = h('div', { class: 'ex-flow-panel', role: 'tabpanel', id: `${id}-panel`, tabindex: '0' });
  const tabs = steps.map((step, index) => h('button', {
    type: 'button', class: 'ex-flow-step', role: 'tab', id: `${id}-tab-${index}`,
    'aria-controls': `${id}-panel`, 'aria-selected': 'false', tabindex: '-1',
  }, h('span', { class: 'ex-flow-n', 'aria-hidden': 'true', text: String(index + 1) }), h('span', { class: 'ex-flow-name', text: step.name })));

  let current = -1;
  function select(index, { focus = false } = {}) {
    // The explanation slides in from the side of the step you moved to.
    if (current >= 0 && index !== current) slideIn(panel, index > current ? 'next' : 'prev');
    current = index;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.classList.toggle('is-done', i < index);
    });
    const step = steps[index];
    panel.setAttribute('aria-labelledby', tabs[index].id);
    panel.replaceChildren(
      h('p', { class: 'ex-flow-detail' }, rich(step.detail), step.status ? [' ', statusBadge(step.status)] : null),
      fileList(step.files),
    );
    if (focus) {
      tabs[index].focus();
      tabs[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  tabs.forEach((tab, index) => tab.addEventListener('click', () => select(index)));
  wireTabKeys(tabs, select);
  select(0);

  return h('div', { class: 'ex-flow' },
    h('div', { class: 'ex-flow-steps', role: 'tablist', 'aria-label': label }, tabs),
    panel);
}

/**
 * A relation map: grouped nodes where selecting one highlights what it leads
 * to and what leads to it. The lifecycle uses it as grouped rows. The system
 * map passes `net`, which lays the same buttons out as stations on a drawn
 * network at wide widths and falls back to the grouped rows on a phone, so
 * there is one set of controls and one keyboard order in both.
 *
 * @param {object} options
 * @param {string} options.label accessible name
 * @param {Array<{id: string, name: string, note?: string}>} options.groups
 * @param {Array<{id: string, group: string, name: string, status?: string}>} options.nodes
 * @param {(id: string) => string[]} options.outgoing ids the node leads to
 * @param {string} options.initial id selected at first
 * @param {(node: object, related: {out: object[], in: object[]}, select: (id: string) => void) => Node} options.detail
 * @param {{ out: string, in: string }} options.words legend words for the two relations
 * @param {{ size: [number, number], place: (id: string) => {x: number, y: number, short?: string, line?: string}|null,
 *   drawing: Node, extras?: Node[] }} [options.net] network layout
 */
export function relationMap({ label, groups, nodes, outgoing, initial, detail, words, net = null }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) for (const to of outgoing(node.id)) incoming.get(to)?.push(node.id);

  const buttons = new Map();
  const panel = h('div', { class: 'ex-map-detail', 'aria-live': 'polite' });

  function select(id, { focus = false } = {}) {
    const node = byId.get(id);
    if (!node) return;
    const out = new Set(outgoing(id));
    const inn = new Set(incoming.get(id));
    for (const [nodeId, button] of buttons) {
      const state = nodeId === id ? 'selected' : out.has(nodeId) ? 'out' : inn.has(nodeId) ? 'in' : 'none';
      button.dataset.rel = state;
      button.setAttribute('aria-pressed', String(nodeId === id));
    }
    if (buttons.size && panel.firstChild) slideIn(panel, 'swap');
    panel.replaceChildren(detail(node, {
      out: [...out].map((x) => byId.get(x)).filter(Boolean),
      in: [...inn].map((x) => byId.get(x)).filter(Boolean),
    }, (next) => select(next, { focus: true })));
    if (focus) buttons.get(id)?.focus();
  }

  const rows = groups.map((group) => {
    const members = nodes.filter((node) => node.group === group.id);
    return h('div', { class: 'ex-map-row' },
      h('div', { class: 'ex-map-group' },
        h('span', { class: 'ex-map-group-name', text: group.name }),
        group.note ? h('span', { class: 'ex-map-group-note', text: group.note }) : null),
      h('div', { class: 'ex-map-nodes' }, members.map((node) => {
        const at = net?.place(node.id) ?? null;
        const button = h('button', {
          type: 'button', class: 'ex-node', 'aria-pressed': 'false',
          dataset: { rel: 'none', node: node.id, ...(at?.line ? { line: at.line } : {}), ...(node.status && node.status !== 'shipped' ? { optional: '' } : {}), ...(at?.up ? { up: '' } : {}) },
          style: at ? `--x:${at.x};--y:${at.y}` : null,
          onClick: () => select(node.id),
        }, h('span', { class: 'ex-node-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'ex-node-name' }, h('span', { class: 'ex-node-full', text: node.name }), at?.short ? h('span', { class: 'ex-node-short', text: at.short }) : null),
        node.status && node.status !== 'shipped' ? h('span', { class: `ex-node-flag ex-status-${node.status}`, text: STATUS[node.status].label }) : null);
        buttons.set(node.id, button);
        return button;
      })));
  });

  const legend = h('p', { class: 'ex-map-legend' },
    h('span', { class: 'ex-key ex-key-selected', text: 'Selected' }),
    h('span', { class: 'ex-key ex-key-out', text: words.out }),
    h('span', { class: 'ex-key ex-key-in', text: words.in }));

  const board = h('div', { class: 'ex-map-board', style: net ? `--w:${net.size[0]};--h:${net.size[1]}` : null }, net ? net.drawing : null, rows, net?.extras ?? null);
  const root = h('div', { class: `ex-map${net ? ' ex-map-net' : ''}`, role: 'group', 'aria-label': label },
    h('div', { class: 'ex-map-main' }, board, legend),
    panel);
  select(initial);
  return root;
}

/**
 * Mark a panel whose content is about to be replaced, so the new content
 * arrives with a short directional slide. The mark is removed when the
 * animation ends: a panel that is hidden and shown again (switching views)
 * must not replay it.
 */
function slideIn(panel, dir) {
  panel.dataset.move = dir;
  const done = (event) => {
    if (event.target.parentElement !== panel) return;
    delete panel.dataset.move;
    panel.removeEventListener('animationend', done);
  };
  panel.addEventListener('animationend', done);
}

/** A link into the Technical Deep Dive. */
export function topicLink(topic, text = 'How this works') {
  return h('a', { class: 'ex-more', href: `#/how/${topic}` }, text, icon('arrow', { size: 14 }));
}

/** An expandable block of implementation notes. */
export function notesBlock(note) {
  return h('details', { class: 'ex-notes' },
    h('summary', {}, h('span', { class: 'ex-notes-title', text: note.title }), note.status ? statusBadge(note.status) : null),
    h('ul', { class: 'ex-notes-list' }, note.items.map((item) => h('li', {}, rich(item)))));
}
