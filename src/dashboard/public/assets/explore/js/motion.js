/**
 * Explore JobAgent: choreography.
 *
 * scenes.js builds every picture in its finished state. This file plays each
 * one from its "before" to that state, so motion only ever shows what changed:
 * postings merge, a score adds up, bullets change order, a form fills and
 * stops, an application moves a stage.
 *
 * Three modes, chosen by the window and the reader's motion setting:
 *
 *   pinned  a wide, tall window. The chapters are a stack of sheets. Each
 *           sheet holds (CSS sticky, see scenes.css) while the scroll position
 *           scrubs its picture, then the next sheet rises over it, tilted a
 *           little, and settles flat while the held one sinks into shade.
 *           A sheet is never emptied before it is covered, so there is always
 *           something on screen and the colour changes at a physical edge.
 *   flow    a phone or a short window. Nothing holds; the same timeline plays
 *           once when its picture is scrolled to.
 *   none    reduced motion, or the library did not load. Nothing here runs
 *           and the page is simply the finished pictures.
 *
 * Scrolling itself is never taken over: the page scrolls natively, so the
 * keyboard, find-in-page and links to a section behave as they always do. The
 * scrubbed timelines trail the scrollbar by a fraction of a second, which is
 * what makes them glide on a stepped mouse wheel.
 *
 * GSAP and ScrollTrigger are vendored (assets/vendor/gsap) and loaded by
 * index.html before this module: the page's Content Security Policy allows
 * no script from another origin.
 */
const html = document.documentElement;
const gsap = globalThis.gsap;
const ScrollTrigger = globalThis.ScrollTrigger;

/** Below this the pictures would have to shrink past easy reading, so the chapters flow instead. */
const WIDE = '(min-width: 1180px) and (min-height: 700px)';
const MOVING = '(prefers-reduced-motion: no-preference)';
/** How far behind the scrollbar a scrubbed picture follows, in seconds. */
const TRAIL = 0.8;

/** Flow-mode pictures that have already played; they are not replayed on a return visit. */
const played = new Set();
let media = null;
let introPlayed = false;

const topH = () => parseFloat(getComputedStyle(html).getPropertyValue('--top-h')) || 60;
const all = (root, selector) => [...root.querySelectorAll(selector)];

/* ───────────────────────── the five pictures ───────────────────────── */

/*
 * Each builder adds its moves to `tl` and returns the time each beat starts,
 * in the order of the stage's `beats` (content-overview.js). `k` scales
 * distances: 1 on a pinned stage, smaller where the picture is narrow.
 */

/** Discover: postings arrive in depth, copies merge, mismatches step back, the rest line up. */
function discover(section, tl, k) {
  const plane = section.querySelector('.ex-plane');
  const rows = all(section, '.ex-board-row');
  const copies = all(section, '.ex-board-copy');
  const outs = rows.map((row) => row.querySelector(':scope > .ex-board-out'));
  const scatter = [
    { x: -60, y: -40, z: -120, r: -4 }, { x: 80, y: -8, z: 90, r: 3 }, { x: -100, y: 10, z: -280, r: 6 },
    { x: 50, y: 40, z: -40, r: -5 }, { x: -20, y: 64, z: 120, r: 3 },
  ];
  const at = (i) => scatter[i % scatter.length];

  gsap.set(plane, { rotationX: 18 * k, rotationY: -16 * k });
  gsap.set(outs, { autoAlpha: 0 });
  tl.from(all(section, '.ex-feeder'), { autoAlpha: 0, y: -12, duration: 0.5, stagger: 0.07 }, 0)
    .fromTo(rows,
      { x: (i) => at(i).x * k, y: (i) => at(i).y * k, z: (i) => at(i).z * k - 800, rotation: (i) => at(i).r, scale: 0.84, opacity: 0.2 },
      { z: (i) => at(i).z * k, opacity: 1, duration: 1.5, stagger: 0.16, ease: 'power3.out' }, 0.1)
    // Merge: the two extra copies of one role slide onto it and are gone.
    .fromTo(copies,
      { x: (i) => [150, -130][i] * k, y: (i) => [-60, 54][i] * k, rotation: (i) => [5, -7][i], autoAlpha: 1 },
      { x: 0, y: 0, rotation: 0, duration: 1.1, stagger: 0.12, ease: 'power3.inOut' }, 2.6)
    .to(copies, { autoAlpha: 0, duration: 0.3 }, 3.85)
    .to(outs[1], { autoAlpha: 1, duration: 0.4 }, 3.85)
    // Filter: each mismatch is labelled with its reason and steps back.
    .to(outs[2], { autoAlpha: 1, duration: 0.4 }, 4.8)
    .to(rows[2], { z: `-=${220 * k}`, opacity: 0.55, duration: 0.9 }, 4.8)
    .to(outs[3], { autoAlpha: 1, duration: 0.4 }, 5.4)
    .to(rows[3], { z: `-=${220 * k}`, opacity: 0.55, duration: 0.9 }, 5.4)
    .to(outs[4], { autoAlpha: 1, duration: 0.4 }, 6)
    .to(outs[0], { autoAlpha: 1, duration: 0.4 }, 6.5)
    .to(rows[0], { z: `+=${80 * k}`, duration: 0.7 }, 6.5)
    // Organize: the field flattens into one list.
    .to(plane, { rotationX: 0, rotationY: 0, duration: 1.7, ease: 'power2.inOut' }, 7.5)
    .to(rows, { x: 0, y: 0, z: 0, rotation: 0, scale: 1, opacity: 1, duration: 1.5, stagger: 0.08, ease: 'power3.inOut' }, 7.5)
    .to({}, { duration: 0.6 });
  return [0, 2.6, 4.8, 7.5];
}

/** Score: matched skills light up and feed their bar, the rest are weighed, the total lands on a tier. */
function score(section, tl) {
  const card = section.querySelector('.ex-scorecard');
  const num = card.querySelector('.ex-score-num');
  const bars = all(card, '.ex-bar-fill');
  const skills = card.querySelector('[data-row="coreSkills"] .ex-bar-fill');
  const count = { p: 0 };
  // The number shown is always the chosen posting's total times how far the
  // scene has played, so a preset picked mid-scene still counts to its own score.
  const paint = () => {
    card.dataset.scrub = '';
    num.textContent = String(Math.round(Number(num.dataset.total) * count.p));
  };

  tl.fromTo(all(card, '.ex-hit'), { '--hit': 0 }, { '--hit': 1, duration: 0.45, stagger: 0.45, ease: 'none' }, 0.2)
    .fromTo(skills, { '--reveal': 0 }, { '--reveal': 1, duration: 2.4, ease: 'none' }, 0.3)
    .fromTo(bars.filter((bar) => bar !== skills), { '--reveal': 0 }, { '--reveal': 1, duration: 0.8, stagger: 0.24 }, 3)
    .fromTo(count, { p: 0 }, { p: 1, duration: 5.6, ease: 'none', onUpdate: paint }, 0.3)
    .fromTo(card.querySelector('.ex-ruler-mark'), { '--reveal': 0 }, { '--reveal': 1, duration: 5.6, ease: 'none' }, 0.3)
    .fromTo(card.querySelector('.ex-tier'), { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.5, ease: 'power3.out' }, 6.2)
    .fromTo(card.querySelector('.ex-score-note'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 6.6)
    .fromTo(card.querySelector('.ex-meaning'), { autoAlpha: 0, x: 28 }, { autoAlpha: 1, x: 0, duration: 0.7 }, 8.1)
    .fromTo(card.querySelector('.ex-score-presets'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 9)
    .to({}, { duration: 0.6 });
  return [0, 3, 6.1, 8];
}

/**
 * Tailor: the posting's terms, the tailored copy rising beside the master,
 * bullets into their new order, emphasis, the gap. While a bullet moves it is
 * lifted off the sheet, so sentences pass over one another like cards and
 * never through each other.
 */
function tailor(section, tl, k) {
  const master = section.querySelector('.ex-sheet-master');
  const copy = section.querySelector('.ex-sheet-tailored');
  const rows = all(copy, '.ex-sheet-bullet');
  const wants = all(section, '.ex-want');
  const found = wants.filter((el) => !el.classList.contains('is-gap'));
  const gapChip = wants.filter((el) => el.classList.contains('is-gap'));
  // Where a bullet sat in the master's order, as a distance from where it sits now.
  const fromMaster = (i) => rows[Number(rows[i].dataset.was)].offsetTop - rows[i].offsetTop;
  // The bullet that travels furthest crosses over the others.
  const order = rows.map((_, i) => i).sort((a, b) => Math.abs(fromMaster(b)) - Math.abs(fromMaster(a)));

  gsap.set(found, { '--found': 0 });
  gsap.set(gapChip, { '--gap': 0 });
  rows.forEach((row, i) => gsap.set(row, { zIndex: rows.length - order.indexOf(i) }));
  tl.from(wants, { autoAlpha: 0, y: -14, duration: 0.45, stagger: 0.16 }, 0.1)
    .from(master, { autoAlpha: 0, y: 40 * k, duration: 1.2, ease: 'power3.out' }, 0)
    .fromTo(copy, { autoAlpha: 0, y: 90 * k }, { autoAlpha: 1, y: 0, duration: 1.5, ease: 'power3.out' }, 0.7)
    .fromTo(rows, { y: fromMaster, '--lift': 0 }, { y: 0, duration: 1.4, stagger: 0.22, ease: 'power3.inOut' }, 2.6)
    .to(rows, { '--lift': 1, duration: 0.5, stagger: 0.22, ease: 'power2.out' }, 2.6)
    .to(rows, { '--lift': 0, duration: 0.6, stagger: 0.22, ease: 'power2.in' }, 3.4)
    .fromTo(all(copy, '.ex-sheet-moved'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, stagger: 0.12 }, 4.5)
    .fromTo(copy.querySelector('.ex-sheet-skills'), { opacity: 0.25 }, { opacity: 1, duration: 0.6 }, 4.6)
    .fromTo(all(copy, '.ex-kw'), { '--kw': 0 }, { '--kw': 1, duration: 0.5, stagger: 0.5, ease: 'none' }, 5.4)
    .to(found, { '--found': 1, duration: 0.5, stagger: 0.5, ease: 'none' }, 5.4)
    .to(gapChip, { '--gap': 1, duration: 0.5, ease: 'none' }, 7.6)
    .fromTo(section.querySelector('.ex-gap'), { autoAlpha: 0, y: 22 }, { autoAlpha: 1, y: 0, duration: 0.7 }, 7.9)
    .to({}, { duration: 0.9 });
  return [0, 2.5, 5.3, 7.5];
}

/** Fill: a scan names each field, each is matched to a source, answers are typed and checked, then it stops. */
function fill(section, tl, k) {
  const win = section.querySelector('.ex-window');
  const form = section.querySelector('.ex-form');
  const fields = all(form, '.ex-field');
  const kinds = fields.map((f) => f.querySelector('.ex-field-kind'));
  const froms = fields.map((f) => f.querySelector('.ex-field-from'));
  const halt = form.querySelector('.ex-halt');

  gsap.set(froms, { autoAlpha: 0 });
  gsap.set(fields, { '--lit': 0 });
  tl.fromTo(win, { y: 50 * k, rotationX: 8 * k }, { y: 0, rotationX: 0, duration: 2, ease: 'power3.out' }, 0)
    .fromTo(form.querySelector('.ex-scanline'), { y: 0, autoAlpha: 1 }, { y: () => form.offsetHeight, duration: 2.2, ease: 'none' }, 0.2)
    .to(form.querySelector('.ex-scanline'), { autoAlpha: 0, duration: 0.2 }, 2.3)
    .fromTo(kinds, { autoAlpha: 0, x: 10 }, { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.38 }, 0.4)
    .to(fields, { '--lit': 1, duration: 0.3, stagger: 0.38, ease: 'none' }, 0.4)
    // Map: what the field is gives way to where its answer comes from.
    .to(kinds, { autoAlpha: 0, y: -8, duration: 0.25, stagger: 0.32 }, 2.8)
    .to(froms, { autoAlpha: 1, duration: 0.3, stagger: 0.32 }, 2.95)
    .to({}, { duration: 0.1 });
  // Fill and check: one field after another, each read back once typed.
  fields.forEach((field, i) => {
    const t = 5 + i * 0.5;
    const value = field.querySelector('.ex-field-value');
    if (value) {
      tl.fromTo(value, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.42, ease: 'none' }, t)
        .fromTo(field.querySelector('.ex-field-ok'), { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.22 }, t + 0.42);
    } else {
      tl.fromTo(field.querySelector('.ex-field-ask'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4 }, t);
    }
  });
  tl.fromTo(halt, { autoAlpha: 0, y: 34 }, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 7.9)
    .fromTo(halt.querySelector('.ex-band-lamp'), { scale: 0 }, { scale: 1, duration: 0.5, ease: 'power3.out' }, 8.2)
    .to({}, { duration: 0.9 });
  return [0, 2.7, 4.9, 7.8];
}

/** Track: events are recorded, a reply arrives as a suggestion, and the application moves when you confirm. */
function track(section, tl) {
  const events = all(section, '.ex-event');
  const app = section.querySelector('.ex-app');
  const stages = all(section, '.ex-stage');
  const now = stages.findIndex((s) => s.classList.contains('is-current'));
  const of = (beat) => events.filter((e) => e.dataset.beat === String(beat));
  // The application starts one stage back from where the finished picture has
  // it: beside it on a wide board, above it where the stages stand in a column.
  // Measured on screen, where the picture may be scaled to fit, and moved in its own unscaled space.
  const box = (i) => stages[i].getBoundingClientRect();
  const fit = () => Number(section.querySelector('.ex-demo').style.getPropertyValue('--fit')) || 1;
  const back = { x: () => (box(now - 1).left - box(now).left) / fit(), y: () => (box(now - 1).top - box(now).top) / fit() };

  gsap.set(stages[now], { '--on': 0 });
  tl.fromTo(of(0), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.7 }, 0.3)
    .fromTo(app.querySelector('.ex-app-chip'), { autoAlpha: 0, scale: 0.7 }, { autoAlpha: 1, scale: 1, duration: 0.4 }, 2)
    .fromTo(of(1), { autoAlpha: 0, x: 90 }, { autoAlpha: 1, x: 0, duration: 0.9, ease: 'power3.out' }, 3.2)
    .fromTo(app, back, { x: 0, y: 0, duration: 1.7, ease: 'power3.inOut' }, 5.7)
    .to(app, { scale: 1.06, duration: 0.85, ease: 'power2.out' }, 5.7)
    .to(app, { scale: 1, duration: 0.85, ease: 'power2.in' }, 6.55)
    .to(stages[now], { '--on': 1, duration: 1, ease: 'none' }, 6.3)
    .fromTo(of(2), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 7.4)
    .to({}, { duration: 1 });
  return [0, 3.1, 5.6];
}

const SCENES = { discover, score, tailor, fill, track };

/** A signal: the line draws up to the stop, the posting runs along it and waits, the lamp is lit. */
function signal(section, tl) {
  const track = section.querySelector('.ex-gate-track');
  const token = track.querySelector('.ex-gate-token');
  tl.from(all(section, '.ex-gate-title .ex-w'), { yPercent: 60, autoAlpha: 0, duration: 0.8, stagger: 0.18, ease: 'power3.out' }, 0)
    .from(section.querySelector('.ex-gate-head'), { autoAlpha: 0, y: 40, duration: 0.8, ease: 'power3.out' }, 0.2)
    .from(track.querySelector('.ex-gate-rail'), { scaleX: 0, duration: 1.6, ease: 'power2.inOut' }, 0.4)
    .from(token, { x: () => -token.offsetLeft, duration: 1.6, ease: 'power2.inOut' }, 0.4)
    .from(section.querySelector('.ex-gate-lamp.is-stop'), { scale: 0.2, autoAlpha: 0.3, duration: 0.5, ease: 'power3.out' }, 1.7)
    .from(track.querySelector('.ex-gate-ahead'), { autoAlpha: 0, duration: 0.4 }, 1.9)
    .from(section.querySelector('.ex-gate-text'), { autoAlpha: 0, y: 24, duration: 0.7 }, 2)
    .to({}, { duration: 0.8 });
}

/**
 * Open the beat whose moment is playing; the others fold to their names
 * (scenes.css). Returns the function that brings the list up to date.
 */
function followBeats(tl, beats, marks) {
  return () => {
    const now = tl.time();
    const on = marks.reduce((found, mark, i) => (now >= mark - 0.05 ? i : found), 0);
    beats.forEach((beat, i) => beat.classList.toggle('is-on', i === on));
  };
}

/**
 * Scale each picture to the room its held sheet has, so a short window shows
 * the whole of it. Measured before ScrollTrigger measures anything else.
 */
function fitPictures(root) {
  for (const pic of all(root, '.ex-scene-pic')) {
    const demo = pic.querySelector('.ex-demo');
    demo.style.setProperty('--fit', '1');
    demo.style.removeProperty('margin-bottom');
    const fit = Math.min(1, pic.clientHeight / demo.offsetHeight, pic.clientWidth / demo.offsetWidth);
    demo.style.setProperty('--fit', fit.toFixed(3));
    // It is scaled from its top edge; giving back the height the scale removes keeps it centred.
    if (fit < 1) demo.style.marginBottom = `${(-(1 - fit) * demo.offsetHeight).toFixed(1)}px`;
  }
}

/* ───────────────────────── the sheets ───────────────────────── */

/**
 * The stack. Each sheet's picture is scrubbed from the moment it is half way
 * up the window until the next sheet starts to rise over it; then the next one
 * peels in, tilted at its leading corner, and the held sheet sinks back into
 * shade beneath it.
 */
function sheets(root, pinned) {
  const chapters = all(root, '.ex-sheet-chapter');
  chapters.forEach((section, index) => {
    const stage = section.querySelector('.ex-plate');
    const isScene = section.classList.contains('ex-scene');
    const id = section.dataset.scene;
    if (!pinned) {
      const key = id ?? section.id;
      if (played.has(key)) return;
      const tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.out' }, onComplete: () => played.add(key) });
      if (isScene) SCENES[id](section, tl, 0.4);
      else signal(section, tl);
      tl.timeScale(2.2);
      ScrollTrigger.create({ trigger: isScene ? section.querySelector('.ex-scene-pic') : stage, start: 'top 74%', once: true, onEnter: () => tl.play() });
      return;
    }

    // The next sheet starts to rise when this section's bottom is one stage
    // below the window's foot (the next section overlaps it by one stage).
    const playEnd = () => `bottom ${innerHeight + stage.offsetHeight}px`;
    let follow = null;
    const tl = gsap.timeline({
      defaults: { ease: 'power2.out' },
      onUpdate: () => follow?.(),
      scrollTrigger: { trigger: section, start: () => `top ${Math.round(innerHeight * 0.58)}px`, end: playEnd, scrub: TRAIL, invalidateOnRefresh: true },
    });
    if (isScene) {
      follow = followBeats(tl, all(section, '.ex-beat'), SCENES[id](section, tl, 1));
      follow();
      tl.fromTo(section.querySelector('.ex-scene-rail'), { scaleX: 0 }, { scaleX: 1, duration: tl.duration(), ease: 'none' }, 0);
    } else {
      signal(section, tl);
    }

    // Peeling in: the sheet arrives tilted at its leading corner and lands flat.
    gsap.fromTo(stage, { rotation: index ? 2.2 : 1.4, yPercent: 0 }, {
      rotation: 0, ease: 'none',
      scrollTrigger: { trigger: section, start: 'top bottom', end: () => `top ${topH()}px`, scrub: 0.4, invalidateOnRefresh: true },
    });
    // Covered: the held sheet sinks back and darkens as the next one lands on it.
    const next = chapters[index + 1] ?? root.querySelector('.ex-never');
    if (next) {
      gsap.timeline({ scrollTrigger: { trigger: next, start: 'top bottom', end: () => `top ${topH()}px`, scrub: 0.4, invalidateOnRefresh: true } })
        .fromTo(stage, { scale: 1 }, { scale: 0.92, ease: 'none' }, 0)
        .fromTo(stage.querySelector('.ex-shade'), { opacity: 0 }, { opacity: 0.62, ease: 'none' }, 0);
    }
  });

  // The last cover: Never rises over the held Track sheet the same way.
  const last = root.querySelector('.ex-never');
  if (pinned && last) {
    gsap.fromTo(last, { rotation: 2.2 }, { rotation: 0, ease: 'none', scrollTrigger: { trigger: last, start: 'top bottom', end: () => `top ${topH()}px`, scrub: 0.4, invalidateOnRefresh: true } });
  }
}

/**
 * The chapter rail: shown while the sheets play, filled as far as the reader
 * has come, with the chapter in front named beside it.
 */
function rail(root) {
  const nav = root.querySelector('.ex-rail');
  const chapters = all(root, '.ex-sheet-chapter');
  if (!nav || !chapters.length) return () => {};
  const stops = all(nav, '.ex-rail-stop, .ex-rail-signal');
  const fill = nav.querySelector('.ex-rail-fill');
  const label = nav.querySelector('.ex-rail-now');
  const nameOf = (el) => (el.classList.contains('ex-gate') ? el.querySelector('.ex-gate-title').textContent : el.querySelector('.ex-scene-name').textContent);
  let front = -1;
  const update = () => {
    const line = topH() + 2;
    let i = 0;
    chapters.forEach((el, k) => { if (el.getBoundingClientRect().top <= line + innerHeight * 0.35) i = k; });
    if (i === front) return;
    front = i;
    stops.forEach((el, k) => {
      el.classList.toggle('is-here', k === i);
      el.classList.toggle('is-past', k < i);
    });
    nav.dataset.line = chapters[i].dataset.line ?? '';
    nav.dataset.signal = chapters[i].classList.contains('ex-gate') ? 'true' : 'false';
    label.textContent = nameOf(chapters[i]);
  };
  const shown = ScrollTrigger.create({
    trigger: chapters[0], start: 'top 40%',
    endTrigger: root.querySelector('.ex-never') ?? chapters[chapters.length - 1], end: 'top 60%',
    onToggle: (self) => nav.classList.toggle('is-on', self.isActive),
    onUpdate: (self) => { fill.style.transform = `scaleX(${self.progress.toFixed(4)})`; update(); },
    onRefresh: update,
  });
  update();
  return () => { shown.kill(); nav.classList.remove('is-on'); fill.style.removeProperty('transform'); };
}

/* ───────────────────────── the other chapters ───────────────────────── */

/**
 * The hero's field of postings arrives from depth, turns with the pointer, and
 * flies past as the page moves on, leaving the example posting in front.
 */
function hero(root, pinned) {
  const section = root.querySelector('.ex-hero');
  const space = section.querySelector('.ex-crowd-space');
  const cards = all(space, '.ex-fcard');
  const ours = space.querySelector('.is-ours');
  const tilt = { x: 6, y: -14 };
  gsap.set(space, { rotationX: tilt.x, rotationY: tilt.y });
  // Hand each card's resting place (set in CSS from its custom properties) to GSAP in its own terms.
  for (const card of cards) gsap.set(card, { z: Number(card.dataset.depth), rotationY: parseFloat(card.style.getPropertyValue('--r')) });
  if (!introPlayed) {
    introPlayed = true;
    gsap.from(cards.filter((card) => card !== ours), { autoAlpha: 0, z: '-=600', duration: 1.6, stagger: { each: 0.06, from: 'random' }, ease: 'power3.out', delay: 0.35 });
    gsap.from(ours, { autoAlpha: 0, y: 40, z: '-=300', duration: 1.4, ease: 'power3.out', delay: 0.9 });
  }
  if (!pinned) return null;
  const scroll = { trigger: section, start: 'top top', end: 'bottom top', scrub: TRAIL };
  for (const card of cards) {
    if (card === ours) continue;
    const depth = Math.abs(Number(card.dataset.depth)) / 800;
    gsap.to(card, { z: `+=${380 + 220 * depth}`, yPercent: -40 - 90 * depth, opacity: 0.08, ease: 'none', scrollTrigger: scroll });
  }
  gsap.to(ours, { z: '+=140', yPercent: -18, ease: 'none', scrollTrigger: scroll });
  gsap.to(section.querySelector('.ex-hero-title'), { yPercent: -14, ease: 'none', scrollTrigger: scroll });
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return null;
  const rx = gsap.quickTo(space, 'rotationX', { duration: 0.9, ease: 'power3.out' });
  const ry = gsap.quickTo(space, 'rotationY', { duration: 0.9, ease: 'power3.out' });
  const move = (event) => {
    const box = section.getBoundingClientRect();
    ry(tilt.y + ((event.clientX - box.left) / box.width - 0.5) * 14);
    rx(tilt.x - ((event.clientY - box.top) / box.height - 0.5) * 10);
  };
  const rest = () => { rx(tilt.x); ry(tilt.y); };
  section.addEventListener('pointermove', move);
  section.addEventListener('pointerleave', rest);
  return () => { section.removeEventListener('pointermove', move); section.removeEventListener('pointerleave', rest); };
}

/** The problem is read at the reader's pace: each word lights as it is scrolled to. */
function problem(root) {
  for (const say of all(root, '.ex-problem .ex-say')) {
    gsap.fromTo(all(say, '.ex-w'), { opacity: 0.14 }, { opacity: 1, stagger: 0.1, ease: 'none', scrollTrigger: { trigger: say, start: 'top 82%', end: 'bottom 55%', scrub: 0.5 } });
  }
  rise(all(root, '.ex-contrast li, .ex-problem-who'));
}

/** Parts that simply arrive, once, as they are scrolled to. */
function rise(items) {
  if (!items.length) return;
  gsap.set(items, { autoAlpha: 0, y: 30 });
  ScrollTrigger.batch(items, {
    start: 'top 90%', once: true,
    onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 1, stagger: 0.1, ease: 'power3.out', overwrite: true }),
  });
}

/** Under the hood: the network draws west to east and its stations arrive in the same order. */
function hood(root, pinned) {
  const map = root.querySelector('.ex-hoodmap');
  const x = (el) => Number(el.style.getPropertyValue('--x'));
  const nodes = all(map, '.ex-hood-node').sort((a, b) => x(a) - x(b));
  const tl = gsap.timeline({
    scrollTrigger: pinned ? { trigger: map, start: 'top 84%', end: 'center 50%', scrub: TRAIL } : { trigger: map, start: 'top 76%', once: true },
  });
  tl.fromTo(map.querySelector('.ex-net-svg'), { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 2, ease: 'none' })
    .from(nodes, { autoAlpha: 0, duration: 0.25, stagger: 0.075 }, 0.1)
    .from(nodes.map((node) => node.querySelector('.ex-hood-dot')), { scale: 0.3, duration: 0.3, stagger: 0.075, ease: 'power3.out' }, 0.1)
    .from(all(map, '.ex-hood-gate'), { autoAlpha: 0, y: 8, duration: 0.3, stagger: 0.25 }, 1.35);
  rise(all(root, '.ex-hood-head > *, .ex-hood-facts li'));
}

/* ───────────────────────── lifecycle ───────────────────────── */

/**
 * Start the Overview's choreography. Call when the Overview is on screen:
 * every distance is measured from the laid-out page.
 */
export function startMotion(root) {
  if (media || !gsap || !ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true });
  media = gsap.matchMedia();
  media.add({ pinned: `${WIDE} and ${MOVING}`, still: '(prefers-reduced-motion: reduce)', any: 'all' }, (context) => {
    const { pinned, still } = context.conditions;
    const mode = still ? 'none' : pinned ? 'pinned' : 'flow';
    // The layout follows the mode (scenes.css), so it is set before anything is measured.
    html.dataset.motion = mode;
    if (mode === 'none') return undefined;
    const undo = hero(root, pinned);
    const fit = () => fitPictures(root);
    if (pinned) {
      fit();
      ScrollTrigger.addEventListener('refreshInit', fit);
    }
    problem(root);
    sheets(root, pinned);
    const unrail = pinned ? rail(root) : () => {};
    rise(all(root, '.ex-never-list li, .ex-does-list li'));
    hood(root, pinned);
    return () => {
      undo?.();
      unrail();
      ScrollTrigger.removeEventListener('refreshInit', fit);
      for (const demo of all(root, '.ex-scene-pic > .ex-demo')) { demo.style.removeProperty('--fit'); demo.style.removeProperty('margin-bottom'); }
      for (const beat of all(root, '.ex-beat')) beat.classList.remove('is-on');
    };
  });
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
}

/** Stop it and put every picture back to its finished state (the Overview is being hidden). */
export function stopMotion() {
  media?.revert();
  media = null;
  delete html.dataset.motion;
}

/** Where a link to a chapter should land: with its sheet in place and its first moment under way. */
export function sceneLanding(section) {
  if (html.dataset.motion !== 'pinned' || !section.classList.contains('ex-sheet-chapter')) return null;
  const stage = section.querySelector('.ex-plate');
  return section.getBoundingClientRect().top + window.scrollY - topH() + stage.offsetHeight * 0.12;
}
