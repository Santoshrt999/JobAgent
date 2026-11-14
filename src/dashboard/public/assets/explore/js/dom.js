/**
 * Small DOM helpers shared by every Explore component. No framework: the page
 * is static content plus a few interactive diagrams, and the dashboard's CSP
 * (`script-src 'self'`) rules out inline handlers anyway.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element. `attrs` keys: `class`, `text`, `dataset`, `on<Event>`
 * listeners, boolean attributes (true adds, false/null omits), anything else
 * as an attribute. Children may be nodes, strings, arrays, or null.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Text with inline code: `backticks` become <code>. Used for content strings
 * that name a file, a command or an environment variable.
 */
export function rich(text) {
  const parts = String(text ?? '').split(/(`[^`]+`)/g);
  return parts.filter(Boolean).map((part) => (
    part.startsWith('`') && part.endsWith('`') ? h('code', { text: part.slice(1, -1) }) : part
  ));
}

/** Text where {braces} mark a term to emphasize. `strong` decides whether they are bolded. */
export function marked(text, { strong = true } = {}) {
  const parts = String(text ?? '').split(/(\{[^}]+\})/g);
  return parts.filter(Boolean).map((part) => {
    if (!(part.startsWith('{') && part.endsWith('}'))) return part;
    const term = part.slice(1, -1);
    return strong ? h('strong', { class: 'ex-kw', text: term }) : term;
  });
}

/** One icon set: 24px grid, 1.7 stroke, round caps, the same as the dashboard's. */
const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M8.5 5.5v13M15.5 5.5v13',
  note: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5.5M12 7.6v.4',
  stop: 'M7.5 7.5h9v9h-9z',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3M6 11h12v9H6z',
  mail: 'M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6',
};

export function icon(name, { size = 16, label = null } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `ex-ic ex-ic-${name}`);
  svg.setAttribute('focusable', 'false');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

/** Create an SVG element. Attributes are set verbatim; children are appended. */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child) el.append(child);
  return el;
}

/** Does the person prefer reduced motion? Read at call time, so a change is respected. */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Count a number from `from` to `to` in `el`, easing out. Settles on the exact
 * final text, so a reader (and a test) never sees a rounded in-between value
 * once it stops. Instant when the reader prefers reduced motion.
 */
export function countTo(el, to, { from = 0, duration = 900 } = {}) {
  cancelAnimationFrame(el.exCount ?? 0);
  if (prefersReducedMotion() || from === to) { el.textContent = String(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 4;
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) el.exCount = requestAnimationFrame(step);
  };
  el.exCount = requestAnimationFrame(step);
}

let uid = 0;
/** A document-unique id with a readable prefix. */
export function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}
