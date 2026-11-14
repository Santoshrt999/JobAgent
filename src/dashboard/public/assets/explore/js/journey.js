/**
 * The Line: one example posting followed along the route.
 *
 * `buildRoute` is the diagram under the headline. A token (the posting) runs
 * the line by itself and is held at each of the two signals until the reader
 * clears it, which is the product's rule made physical: automation up to a
 * human gate, and no further.
 *
 * The tier ruler is shared by the Score scene (scenes.js) and the Score Lab.
 * The five scenes the posting calls at are built in scenes.js.
 */
import { h, prefersReducedMotion } from './dom.js';
import { JOURNEY, GATES, EXAMPLE_JOB } from './content-overview.js';
import { SCORE_MODEL, scoreInputs } from './score-model.js';

/** Which line each stage runs on. Find is blue, Apply is green, Track is magenta. */
export const LINE_OF = Object.freeze({ discover: 'find', score: 'find', tailor: 'apply', fill: 'apply', track: 'track' });

/** How long the token rests at a station before moving on, in milliseconds. */
const DWELL_MS = 1250;

const example = scoreInputs();
const slug = (text) => String(text).toLowerCase().replace(/\s+/g, '-');

/* ───────────────────────── the route ───────────────────────── */

/** The stops of the route in order: five stations with a signal after Tailor and after Fill. */
function routeStops() {
  const stops = [];
  for (const stage of JOURNEY) {
    stops.push({ kind: 'station', id: stage.id, name: stage.name, fact: stage.fact, line: LINE_OF[stage.id] });
    const gate = GATES.find((g) => g.after === stage.id);
    if (gate) stops.push({ kind: 'signal', id: gate.after, name: gate.label, fact: gate.fact, detail: gate.detail, line: LINE_OF[stage.id] });
  }
  return stops;
}

const STATION_STATUS = Object.freeze({
  discover: `Found on ${EXAMPLE_JOB.source}, ${EXAMPLE_JOB.posted}.`,
  score: `Scored ${example.total}. Tier: ${example.tier}.`,
  tailor: 'Resume tailored. Packet ready for review.',
  fill: 'Form filled in your own browser.',
  track: 'Submitted by you. Now tracking replies.',
});

const SIGNAL_COPY = Object.freeze({
  tailor: { waiting: 'Held at the signal. Nothing is filled until you approve.', action: 'Approve' },
  fill: { waiting: 'Held at the signal. The final click is always yours.', action: 'Submit' },
});

/**
 * @returns {{ root: HTMLElement, start: () => void, reset: () => void }}
 */
export function buildRoute() {
  const stops = routeStops();
  let at = 0;
  let timer = null;
  let started = false;

  const state = h('span', { class: 'ex-route-state' });
  const again = h('button', { type: 'button', class: 'ex-route-again', hidden: true, onClick: () => reset() }, 'Run it again');
  // The token is the posting itself, carrying its title along the line.
  // Decorative: the status line below says the same thing in words.
  const token = h('span', { class: 'ex-route-token', 'aria-hidden': 'true' }, h('span', { class: 'ex-route-tag', text: EXAMPLE_JOB.title }));

  const items = stops.map((stop, index) => {
    const next = stops[index + 1];
    const base = { class: `ex-stop ex-stop-${stop.kind}`, dataset: { line: stop.line, next: next ? next.line : '' }, style: `--n:${index}` };
    if (stop.kind === 'station') {
      return h('li', base, h('a', { class: 'ex-stop-link', href: `#/overview/${stop.id}` },
        h('span', { class: 'ex-stop-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'ex-stop-name', text: stop.name })),
      h('span', { class: 'ex-stop-fact', text: stop.fact }));
    }
    const copy = SIGNAL_COPY[stop.id];
    // The signal is a real button named for what pressing it does. It is
    // disabled until the token is standing at it.
    const button = h('button', {
      type: 'button', class: 'ex-signal-btn', disabled: true, title: stop.detail,
      onClick: () => clear(index),
    }, h('span', { class: 'ex-signal-lamp', 'aria-hidden': 'true' }), h('span', { class: 'ex-signal-action', text: copy.action }));
    stop.button = button;
    return h('li', base, button, h('span', { class: 'ex-signal-name', text: stop.name }), h('span', { class: 'ex-stop-fact', text: stop.fact }));
  });

  const root = h('div', { class: 'ex-route', dataset: { state: 'idle' }, style: `--stops:${stops.length}` },
    // The token sits beside the list, not in it: a list may only hold items.
    h('div', { class: 'ex-route-track' }, h('ol', { class: 'ex-route-line' }, items), token),
    h('p', { class: 'ex-route-status' },
      h('span', { class: 'ex-route-job' }, h('b', { text: EXAMPLE_JOB.title }), ` ${EXAMPLE_JOB.company}`),
      h('span', { class: 'ex-route-live', role: 'status' }, state),
      again),
    h('p', { class: 'ex-route-note', text: 'An example posting. Clear each signal to let it through.' }));

  function paint() {
    const stop = stops[at];
    const waiting = stop.kind === 'signal' && !stop.cleared;
    // Held at a signal, the token stands just short of it.
    root.style.setProperty('--at', String(waiting ? at - 0.4 : at));
    root.dataset.line = stop.line;
    items.forEach((item, index) => {
      item.classList.toggle('is-passed', index < at);
      item.classList.toggle('is-here', index === at);
    });
    // Idle until it is first started (overview.js starts it when it is scrolled to).
    root.dataset.state = !started ? 'idle' : waiting ? 'held' : at === stops.length - 1 ? 'done' : 'running';
    state.textContent = stop.kind === 'signal' ? SIGNAL_COPY[stop.id].waiting : STATION_STATUS[stop.id];
    for (const s of stops) {
      if (s.kind !== 'signal') continue;
      s.button.disabled = !(s === stop && waiting);
      s.button.classList.toggle('is-clear', Boolean(s.cleared));
    }
    again.hidden = at !== stops.length - 1;
  }

  function advance() {
    clearTimeout(timer);
    const stop = stops[at];
    // A signal that has not been cleared holds the token. Nothing here times out.
    if (at >= stops.length - 1 || (stop.kind === 'signal' && !stop.cleared)) return;
    timer = setTimeout(() => {
      at += 1;
      paint();
      advance();
    }, prefersReducedMotion() ? 700 : DWELL_MS);
  }

  function clear(index) {
    const stop = stops[index];
    if (index !== at || stop.cleared) return;
    stop.cleared = true;
    paint();
    advance();
    // Clearing a signal disables its button, which would drop keyboard focus
    // on the page body; hand it to the next thing the reader can act on.
    queueMicrotask(() => {
      const next = stops.slice(index + 1).find((s) => s.kind === 'signal');
      if (document.activeElement === document.body) (next?.button.disabled === false ? next.button : again.hidden ? root.querySelector('.ex-stop-link') : again).focus();
    });
  }

  function reset() {
    clearTimeout(timer);
    for (const s of stops) s.cleared = false;
    at = 0;
    paint();
    advance();
  }

  function start() {
    if (started) return;
    started = true;
    paint();
    advance();
  }

  // A tab left in the background should not run the line unseen.
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (started) advance(); });

  paint();
  return { root, start, reset };
}

/* ───────────────────────── shared pieces ───────────────────────── */

/**
 * Move an existing ruler to a new score: the marker slides, the current tier's
 * name changes. The Overview's presets use this; the Score Lab rebuilds its
 * ruler on every input because it is a tool, and a tool should not make you wait.
 */
export function setRuler(ruler, total) {
  const t = SCORE_MODEL.tiers;
  ruler.querySelector('.ex-ruler-mark').style.setProperty('--at', String(total));
  const bands = [0, t.nearMiss, t.queue, t.apply, t.priority, 100];
  ruler.querySelectorAll('.ex-ruler-names span').forEach((span, i) => {
    span.classList.toggle('is-current', total >= bands[i] && (total < bands[i + 1] || bands[i + 1] === 100));
  });
  ruler.setAttribute('aria-label', ruler.getAttribute('aria-label').replace(/^Score \d+/, `Score ${total}`));
}

/** The five tiers on one line, with a marker at the score. Shared with the Score Lab. */
export function tierRuler(total) {
  const t = SCORE_MODEL.tiers;
  const bands = [
    ['Discard', 0, t.nearMiss], ['Near miss', t.nearMiss, t.queue], ['Queue', t.queue, t.apply],
    ['Apply', t.apply, t.priority], ['Priority', t.priority, 100],
  ];
  return h('div', { class: 'ex-ruler', role: 'img', 'aria-label': `Score ${total} on the tier scale: Near miss from ${t.nearMiss}, Queue from ${t.queue}, Apply from ${t.apply}, Priority from ${t.priority}.` },
    h('div', { class: 'ex-ruler-track' },
      bands.map(([name, from, to]) => h('span', { class: `ex-ruler-band ex-band-${slug(name)}`, style: `flex-grow:${to - from}` })),
      h('span', { class: 'ex-ruler-mark', style: `--at:${total}` })),
    // The thresholds, then each tier named under the middle of its band. Near
    // miss and Apply are only ten points wide, so they sit a row lower.
    h('div', { class: 'ex-ruler-nums', 'aria-hidden': 'true' }, bands.slice(1).map(([, from]) => h('span', { style: `--at:${from}`, text: String(from) }))),
    h('div', { class: 'ex-ruler-names', 'aria-hidden': 'true' }, bands.map(([name, from, to], index) => h('span', {
      class: `${index % 2 ? 'is-low' : ''}${total >= from && (total < to || to === 100) ? ' is-current' : ''}`,
      style: `--at:${(from + to) / 2}`, text: name,
    }))));
}
