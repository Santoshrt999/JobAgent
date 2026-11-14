/**
 * Explore JobAgent: boot, the two views, and in-page navigation.
 *
 * Routes live in the hash so the page works from a static file path and a
 * link can point at one section:
 *   #/overview            the Product Overview
 *   #/overview/<stage>    one scene of the Overview (discover, score, ...)
 *   #/how                 the Technical Deep Dive
 *   #/how/<topic>         one Deep Dive section (see DEEP_TOPICS)
 */
import { renderOverview } from './overview.js';
import { renderDeep } from './deep.js';
import { prefersReducedMotion } from './dom.js';
import { sceneLanding, startMotion, stopMotion } from './motion.js';

const VIEWS = ['overview', 'how'];
const $ = (id) => document.getElementById(id);

const views = { overview: $('viewOverview'), how: $('viewHow') };
const switches = [...document.querySelectorAll('[data-view]')];
let deepReady = false;
let topicIds = [];
let currentView = null;

/* ───────────────────────── theme ───────────────────────── */

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function syncThemeControl() {
  const label = `Switch to ${currentTheme() === 'light' ? 'dark' : 'light'} theme`;
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.setAttribute('aria-label', label);
    button.title = label;
    button.dataset.showing = currentTheme();
  }
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('jobagent-theme', next); } catch { /* the choice lasts for this visit only */ }
  syncThemeControl();
}

/* ───────────────────────── routing ───────────────────────── */

function parseHash() {
  const [, view = 'overview', part = null] = location.hash.match(/^#\/([a-z]+)(?:\/([a-z-]+))?$/) ?? [];
  return { view: VIEWS.includes(view) ? view : 'overview', part };
}

function ensureDeep() {
  if (deepReady) return;
  topicIds = renderDeep(views.how);
  deepReady = true;
  watchTopics();
  watchReveals(views.how);
}

/** Mark the section in view in the table of contents, without adding history entries. */
function watchTopics() {
  const links = new Map([...views.how.querySelectorAll('.ex-toc a')].map((a) => [a.dataset.topic, a]));
  const visible = new Set();
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.dataset.topic);
      else visible.delete(entry.target.dataset.topic);
    }
    const active = topicIds.find((id) => visible.has(id));
    if (!active) return;
    for (const [id, link] of links) {
      if (id === active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    const link = links.get(active);
    const list = link?.closest('ol');
    // The "you are here" stop slides along the contents line to the section in view,
    // and the line fills behind it.
    if (list) {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      // The centre of the link's own stop (explore.css: top .62rem, 12px across).
      const centre = link.offsetTop + rem * 0.62 + 6;
      const inset = rem * 0.9;
      list.style.setProperty('--here', `${centre}px`);
      list.style.setProperty('--here-p', String(Math.max(0, Math.min(1, (centre - inset) / Math.max(1, list.offsetHeight - 2 * inset)))));
      list.dataset.here = '';
    }
    // Keep the active link in sight when the contents list itself scrolls (phones).
    if (list && list.scrollWidth > list.clientWidth) {
      list.scrollTo({ left: link.offsetLeft - list.clientWidth / 2 + link.offsetWidth / 2 });
    }
  }, { rootMargin: '-20% 0px -65% 0px' });
  for (const id of topicIds) {
    const el = $(`topic-${id}`);
    if (el) spy.observe(el);
  }
}

/**
 * Sections draw themselves in when they are first scrolled to. They are fully
 * visible without this (the default styles are the finished state), so a
 * browser with no IntersectionObserver, or a reader who prefers reduced
 * motion, simply sees the page.
 */
function watchReveals(root) {
  const targets = [...root.querySelectorAll('[data-reveal]')];
  if (typeof IntersectionObserver !== 'function') return;
  document.documentElement.dataset.reveals = 'on';
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.dataset.reveal = 'in';
      // Components with a move of their own (the score's count, the resume's
      // reorder) start it from this event, so it happens where it can be seen.
      entry.target.dispatchEvent(new CustomEvent('ex:reveal'));
      seen.unobserve(entry.target);
      // Once played, a reveal is retired, so hiding and showing a view (switching
      // pages) does not replay the animations keyed on it.
      setTimeout(() => { entry.target.dataset.reveal = 'done'; }, 3200);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0 });
  for (const el of targets) seen.observe(el);
}

/**
 * Which line the reader is on: the header's progress rule takes its colour
 * from the chapter crossing the middle of the window. Chapters overlap while
 * one slides over another, so the one in front (the later one) wins.
 */
function watchHere(root) {
  if (typeof IntersectionObserver !== 'function') return;
  const chapters = [...root.querySelectorAll('.ex-chapter')];
  const crossing = new Set();
  const lineOf = (el) => (el.classList.contains('ex-gate') ? 'signal' : el.classList.contains('ex-never') ? 'board' : (el.dataset.line ?? ''));
  const here = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) crossing.add(entry.target);
      else crossing.delete(entry.target);
    }
    const front = chapters.findLast((el) => crossing.has(el));
    if (front) document.documentElement.dataset.here = lineOf(front);
  }, { rootMargin: '-50% 0px -49% 0px' });
  for (const el of chapters) here.observe(el);
}

/**
 * Switch views with a sideways slide where the browser can (View Transitions):
 * forward to How it works slides left, back to the Overview slides right. The
 * header is named on its own, so it stays put while the page moves.
 */
function navigate(state, options) {
  const order = (v) => VIEWS.indexOf(v);
  if (!currentView || state.view === currentView || typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
    show(state, options);
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = order(state.view) > order(currentView) ? 'forward' : 'back';
  const t = document.startViewTransition(() => show(state, options));
  t.finished.finally(() => { delete root.dataset.vt; });
}

function show({ view, part }, { fromLink = false } = {}) {
  currentView = view;
  if (view === 'how') ensureDeep();
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  for (const button of switches) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  // Named `page`, not `view`: `[data-view]` is how the two nav buttons are found.
  document.documentElement.dataset.page = view;
  document.title = view === 'how' ? 'How JobAgent works' : 'Explore JobAgent';
  // The Overview's choreography measures the laid-out page, so it runs only
  // while the Overview is on screen, and starts before any jump to a section.
  if (view === 'overview') startMotion(views.overview);
  else stopMotion();

  const prefix = view === 'how' ? 'topic' : 'station';
  const target = part ? $(`${prefix}-${part}`) : null;
  if (target) {
    // A link followed inside the page glides there; opening the page on a section lands on it at once.
    scrollToTop(target, { instant: !fromLink });
    // Move focus with the jump, so the next Tab continues from the section.
    if (fromLink) $(`${prefix}-${part}-${view === 'how' ? 'title' : 'name'}`)?.focus({ preventScroll: true });
  } else if (fromLink) {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

/**
 * Bring a section's top to the top of the window, below the header, honouring
 * the CSS scroll-padding and scroll-behavior (so it glides unless the reader
 * prefers reduced motion).
 */
function scrollToTop(el, { instant = false } = {}) {
  const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  // A scene that holds while it plays is entered a little way in, with its first moment under way.
  window.scrollTo({ top: Math.max(0, sceneLanding(el) ?? el.getBoundingClientRect().top + window.scrollY - pad), behavior: instant ? 'instant' : 'auto' });
}

function go(view) {
  const now = parseHash();
  if (now.view === view && !now.part) return;
  location.hash = `#/${view}`;
}

/* ───────────────────────── boot ───────────────────────── */

renderOverview(views.overview);
watchReveals(views.overview);
watchHere(views.overview);

for (const button of switches) button.addEventListener('click', () => go(button.dataset.view));
for (const button of document.querySelectorAll('.theme-toggle')) button.addEventListener('click', toggleTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeControl);
window.addEventListener('hashchange', () => navigate(parseHash(), { fromLink: true }));

// Publish the header's real height, so sticky parts and jump targets clear it.
const topbar = document.querySelector('.ex-top');
const syncTop = () => document.documentElement.style.setProperty('--top-h', `${Math.round(topbar.getBoundingClientRect().height)}px`);
new ResizeObserver(syncTop).observe(topbar);
syncTop();

syncThemeControl();
show(parseHash());
// A link straight to one section is measured before the typeface has loaded,
// and the text reflows when it arrives. Align it again then, unless the
// reader has already scrolled somewhere of their own.
{
  const { view, part } = parseHash();
  const landed = window.scrollY;
  if (part) {
    document.fonts?.ready.then(() => {
      const target = $(`${view === 'how' ? 'topic' : 'station'}-${part}`);
      if (target && Math.abs(window.scrollY - landed) < 2) scrollToTop(target, { instant: true });
    });
  }
}
document.documentElement.dataset.ready = 'true';
// The headline rises out of its masks on load (scenes.css); the route near the
// end of the page sets off when it is first scrolled to (overview.js).
const still = prefersReducedMotion();
// The entrance is played once. Showing the Overview again after visiting
// How it works must not replay it, so it is switched off once it has run.
setTimeout(() => { document.documentElement.dataset.intro = 'done'; }, still ? 0 : 2400);
