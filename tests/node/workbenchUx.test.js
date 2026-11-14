/**
 * Behaviour of the 2026-09 dashboard upgrade, asserted against the shipped
 * source (the dashboard has no bundler and no DOM test harness; the same style
 * as workbenchUi.test.js). Each block names the problem it guards against.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css').replace(/\r\n?/g, '\n');
const jsDir = new URL('../../src/dashboard/public/assets/js/', import.meta.url);
// Every module, in a stable order, so assertions do not care which file a
// function lives in.
const app = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => readFileSync(new URL(f, jsDir), 'utf8')).join('\n');

describe('the detail rail survives refreshes (U1)', () => {
  it('reconciles keyed sections instead of clearing the rail', () => {
    expect(app).toContain('reconcileDetail(current, sections)');
    // Never moves a kept node: detaching blurs whatever it holds.
    expect(app).toContain('if (prev && keepSection(prev, key)) placed = prev;');
    // Kept while you are typing, choosing or inside an open menu; a button
    // that only holds focus after a press does not freeze its section.
    expect(app).toContain("if (key === 'notes' && note.isDirty()) return true;");
    expect(app).toContain(`return active.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')`);
    expect(app).toContain("|| Boolean(active.closest('details[open]'));");
    expect(app).toContain('function carryOpenDetails');
    expect(app).toContain("el('details', { 'data-key': 'technical' })");
    // The link-check result is state, not DOM, so a redraw keeps it.
    expect(app).toContain('state.linkHealth.set(id, { tone, text });');
  });

  it('autosaves the note on a debounce, on blur, and when leaving the job', () => {
    expect(app).toContain('const NOTE_DEBOUNCE_MS');
    expect(app).toContain("if (event.target.id === 'noteBox') saveNote();");
    expect(app).toContain('if (id !== state.selectedId) flushNote();');
    expect(app).toContain('keepalive: true');
    for (const label of ["saved: 'Saved'", "dirty: 'Unsaved changes'", "saving: 'Saving…'"]) {
      expect(app).toContain(label);
    }
  });

  it('puts board focus back on the same row and control after a re-render', () => {
    expect(app).toContain('function captureRowFocus');
    expect(app).toMatch(/function renderRows\(jobs\) \{\s*const body = \$\('rows'\);\s*const focus = captureRowFocus\(\);/);
    expect(app).toContain('restoreRowFocus(focus);');
  });
});

describe('the detail is on screen at every width (U2)', () => {
  it('lets the rail stick, capped to the viewport', () => {
    expect(css).toContain('.layout > aside { align-self: stretch;');
    const rail = css.slice(css.indexOf('.rail-sticky {'));
    expect(rail).toMatch(/max-height: calc\(100vh - var\(--topbar-h/);
    expect(rail).toMatch(/overflow: auto/);
  });

  it('opens a modal sheet at <=1240px, with focus moved in and returned to the row', () => {
    expect(html).toContain('<dialog id="dlgDetail" class="detail-sheet"');
    expect(app).toContain("matchMedia('(max-width: 1240px)')");
    expect(app).toContain('if (user && isSheetLayout()) openDetailSheet(id);');
    expect(app).toContain("$('dlgDetailTitle').focus();");
    expect(app).toContain('(sheetReturnId && jobAnchor(sheetReturnId))?.focus();');
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*dialog\.detail-sheet/);
  });

  it('debounces keyboard-driven selection', () => {
    expect(app).toContain('selectJob(next, { defer: 120 })');
  });
});

describe('a click costs one write and one board read (U3)', () => {
  it('patches the row and rail from the decision response, then reloads only the board page', () => {
    const decide = app.slice(app.indexOf('async function decide(id, decision)'), app.indexOf('async function simpleAction'));
    expect(decide).toContain('applyDecisionLocally(id');
    expect(decide).toContain('scheduleRefresh()');
    expect(decide).not.toContain('refreshAll');
    const schedule = app.slice(app.indexOf('function scheduleRefresh('), app.indexOf('async function refreshAll'));
    expect(schedule).toContain('scheduleBoardReload(delay)');
    expect(schedule).not.toContain('loadSections');
    expect(schedule).not.toContain('loadProfileFlag');
  });

  it('fetches stats single-flight and at most once a minute unless forced', () => {
    expect(app).toContain('const STATS_MIN_INTERVAL_MS = 60_000;');
    expect(app).toContain('if (statsInFlight) return statsInFlight;');
    expect(app).toContain('if (!force && wait > 0)');
    // A stale (cached) response is labelled and refetched soon.
    expect(app).toContain('if (stats.stale)');
    expect(app).toContain('Showing cached numbers — recalculating');
  });

  it('reads sections only while Discovery health is open, one section at a time', () => {
    expect(app).toContain("if ($('analytics').hidden) return;");
    expect(app).toContain("api('/api/sections?only=blockedByReason')");
  });

  it('asks for slim board rows', () => {
    expect(app).toContain("params.set('fields', 'board');");
  });

  it('keeps one poll chain and backs off in a hidden tab', () => {
    expect(app).toContain('const gen = ++pollGen;');
    expect(app).toContain('if (gen !== pollGen) return;');
    expect(app).toContain('const HIDDEN_POLL_MS = 30_000;');
    expect(app).toContain("document.addEventListener('visibilitychange'");
  });

  it('shows how fresh the board is', () => {
    expect(html).toContain('id="boardStatus"');
    for (const text of ['Refreshing…', 'Updated just now', 's ago']) expect(app).toContain(text);
  });
});

describe('menus follow the menu-button pattern (U5)', () => {
  it('moves focus into the menu and around it with the keyboard', () => {
    expect(app).toContain('function openMenu(pop');
    expect(app).toContain("(focus === 'last' ? items.at(-1) : items[0])?.focus();");
    for (const key of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Escape'", "'Tab'"]) {
      expect(app).toContain(`event.key === ${key}`);
    }
    // Escape returns focus to the trigger; leaving the menu closes it.
    expect(app).toContain('closeMenu(pop, { returnFocus: true });');
    expect(app).toContain("wrap.addEventListener('focusout'");
  });

  it('keeps menu semantics valid', () => {
    expect(html).toContain('<hr role="separator">');
    expect(html).not.toMatch(/<hr>/);
    expect(html).toContain('id="columnToggles" role="group"');
  });

  it('returns focus to the trigger when a menu item opens a dialog', () => {
    expect(app).toContain("const menu = from?.closest?.('.menu-pop');");
  });
});

describe('Today is the landing view (U7)', () => {
  it('offers Today and the full board as one switch, remembering the choice', () => {
    expect(html).toContain('data-action="set-view" data-view="today"');
    expect(html).toContain('data-action="set-view" data-view="board"');
    expect(html).toContain('data-action="set-view" data-view="applications"');
    expect(html).toContain('id="todayView"');
    expect(html).toContain('id="boardView"');
    expect(app).toContain("savePreference('view', view)");
    expect(app).toContain("setView(['board', 'applications'].includes(readPreference('view')) ? readPreference('view') : 'today', { save: false });");
  });

  it('reads /api/today and falls back to todaysPriorities without failed rows', () => {
    expect(app).toContain("apiOptional('/api/today')");
    expect(app).toContain("api('/api/sections?only=todaysPriorities')");
    expect(app).toContain(".filter((row) => row.appStatus !== 'failed')");
    expect(app).toContain('.slice(0, 10)');
  });

  it('maps every nextAction kind to one primary button', () => {
    const act = app.slice(app.indexOf('async function todayAct'), app.indexOf('/* ─────────────────────── setup checklist'));
    for (const kind of ['prepare', 'approve', 'autofill', 'answer', 'submit', 'fix_setup']) {
      expect(act).toContain(`case '${kind}'`);
    }
    // review (and anything unknown) opens the job in the rail AT the part the
    // button names — reselecting an already-open job changed nothing on screen.
    expect(act).toContain('default: await revealInDetail(id);');
  });

  it('shows system notices with a copyable fix, and gates Auto-fill on a missing browser', () => {
    expect(html).toContain('id="systemNotices"');
    expect(app).toContain("'data-action': 'copy-text'");
    expect(app).toContain("notices.some((n) => n.code === 'browser_unavailable')");
    expect(app).toContain('function autofillBlockedReason');
    // Every Auto-fill entry point consults it.
    expect(app).toContain('const blocked = autofillBlockedReason();');
    expect(app).toContain("if (autofillBlockedReason()) { toast(autofillBlockedReason(), 'bad'); return; }");
  });

  it('says what to do next when there is nothing to do', () => {
    expect(app).toContain('Nothing needs you right now');
    expect(app).toContain("'data-phase': 'discover', text: 'Find new jobs'");
  });

  it('renames the stage tab that used to share the name', () => {
    expect(app).toContain("['today', 'Priority', true]");
  });
});

describe('run history (U8)', () => {
  it('is reachable from the More menu and from the run pill popover', () => {
    expect(html).toContain('id="dlgRuns"');
    expect(html).toMatch(/role="menuitem" data-action="open-runs"/);
    const details = app.slice(app.indexOf('function renderRunDetails'), app.indexOf('function applyRunGate'));
    expect(details).toContain("'data-action': 'open-runs'");
  });

  it('reads both the documented shape and raw run_log rows, and hides on 404', () => {
    expect(app).toContain("apiOptional('/api/runs?limit=20')");
    for (const key of ['raw.startedAt ?? raw.started_at', "pick('found', 'jobs_found')", 'parseJsonList(raw.errors)', 'raw.perSource']) {
      expect(app).toContain(key);
    }
    expect(app).toContain("for (const node of document.querySelectorAll('[data-action=\"open-runs\"]')) node.hidden = true;");
  });

  it('never shows a negative duration', () => {
    expect(app).toContain('Number.isFinite(duration) && duration >= 0 ? duration : null');
  });

  it('shows progress with elapsed seconds in slow dialogs', () => {
    expect(app).toContain('function slowProgress(host, message)');
  });
});

describe('closing a job can be undone, and can say why (U9)', () => {
  it('offers undo for a single Reject/Archive, not only for batches', () => {
    const fn = app.slice(app.indexOf('function announceDecision'), app.indexOf('function offerUndo'));
    expect(fn).toContain("decision !== 'rejected' && decision !== 'archived'");
    expect(fn).toContain('offerUndo(');
    expect(fn).toContain('reasonFor: { jobIds: [id], decision }');
    expect(app).toContain('closes ? { reasonFor: { jobIds: [...done], decision } } : {}');
  });

  it('offers the eight reason chips and posts the contract fields', () => {
    for (const key of ['salary', 'location', 'seniority', 'sponsorship', 'stack', 'company', 'stale', 'other']) {
      expect(app).toContain(`['${key}', `);
    }
    expect(app).toContain("const body = { decision, reason, ...(reasonNote ? { reasonNote } : {}) };");
    expect(app).toContain("postJson('/api/decide-batch', { jobIds, ...body })");
  });

  it('does not let the undo toast expire under the pointer or focus', () => {
    expect(app).toContain("node.addEventListener('focusin', hold);");
    expect(app).toContain("node.addEventListener('pointerenter', hold);");
  });

  it('shows a recorded decision reason in the rail', () => {
    expect(app).toContain('if (job.decisionReason)');
  });
});

describe('numbers say what they count (U10)', () => {
  const card = app.slice(app.indexOf('function renderSponsorship'), app.indexOf('function renderAnalytics'));

  it('uses sponsorshipOpen and keeps never-evaluated jobs out of the verdicts', () => {
    expect(card).toContain('const open = stats.sponsorshipOpen;');
    expect(card).toContain('open.notEvaluated');
    expect(card).toContain('not evaluated — closed before classification');
    // Unclassified is never a row on the scale, and never "unknown".
    expect(app).toContain("const SPONSORSHIP_SCALE = ['Confirmed', 'Likely', 'Unconfirmed', 'Denied'];");
    expect(card).not.toContain('still unknown');
  });

  it('keeps whole-store numbers out of the activity row, one click away', () => {
    // The row says what changed; the corpus total lives in the data-quality
    // dialog, and the row's link to it names that total in its tooltip.
    const facts = app.slice(app.indexOf('const HEALTH_FACTS'), app.indexOf('function statNode'));
    expect(facts).not.toContain("label: 'in store'");
    const health = app.slice(app.indexOf('export function renderHealth'), app.indexOf('export function renderTabs'));
    expect(health).toContain("'data-action': 'open-data-quality'");
    expect(health).toContain('jobs stored in total');
  });

  it('uses the server grade label instead of re-deriving a fit label', () => {
    expect(app).toContain('return job.grade?.label ?? fitLabel(job.fit);');
    expect(app).toContain('(${verdictLabel(j)})');
  });
});

describe('phones get the screen back (U11)', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 720px) {\n  .topbar { position: static; }'));

  it('stops the header and the pager from sticking, and folds the pager to one line', () => {
    expect(phone).toContain('.topbar { position: static; }');
    expect(phone).toContain('.pagerbar { position: static; flex-wrap: nowrap;');
    expect(phone).toContain('.pager .pg-edge, .pager .pg-of');
    expect(app).toContain("class: 'small pg-edge'");
  });

  it('clamps the card meta line and top-aligns cards', () => {
    expect(css).toMatch(/\.namemeta \{\s*white-space: normal; display: -webkit-box; -webkit-box-orient: vertical;\s*-webkit-line-clamp: 2;/);
    expect(css).toContain('#board tr.job { align-items: flex-start; }');
  });

  it('keeps the run pill text from running under its buttons', () => {
    expect(css).toMatch(/\.run-main \{[^}]*align-items: stretch;[^}]*overflow: hidden;/);
  });
});

describe('one design system (U12)', () => {
  it('uses a six-step type scale and no ad-hoc font sizes', () => {
    for (const step of ['xs', 'sm', 'md', 'lg', 'xl', '2xl']) expect(css).toContain(`--fs-${step}:`);
    const raw = css.match(/font(?:-size)?: *[0-9.]+(?:px|rem|em)/g) ?? [];
    expect(raw).toEqual([]);
  });

  it('frosts only the header, on a sibling layer, and never the filter or pager bars', () => {
    // The filter bar and pager stay solid: they sit over the board itself and
    // a blur there costs a recomposite on every scroll for no legibility gain.
    // The header was solid for the same reason until the glass refinement
    // (2026-11) gave floating layers one material. Its frost lives on
    // `.topbar::before`, never on `.topbar`: an element with backdrop-filter
    // is a backdrop root, which would stop the menus inside the header from
    // blurring the page they open over.
    for (const selector of ['.topbar {', '.filterbar {', '.pagerbar {']) {
      const rule = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
      expect(rule, selector).not.toContain('backdrop-filter');
    }
    expect(css).toMatch(/\.topbar::before \{[^}]*backdrop-filter: var\(--blur\)/);
    expect(css).not.toMatch(/\.(filterbar|pagerbar)[^{]*\{[^}]*backdrop-filter/);
  });

  it('says what slow dialogs are doing, with elapsed time', () => {
    expect(app).toContain("slowProgress(body, 'Building the report — reading the whole database…')");
    expect(app).toContain("slowProgress(body, 'Running the system checks");
    expect(app).toContain("slowProgress(body, 'Reading your master resume");
  });

  it('lists failing health checks on Today, linked to the dialog that fixes them', () => {
    expect(html).toContain('id="setupChecklist"');
    expect(app).toContain("'profile-placeholders': { action: 'open-profile'");
    expect(app).toContain("resume: { action: 'open-master'");
    expect(app).toContain("(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))");
  });

  it('offers the profile and master resume wherever auto-fill can stall', () => {
    expect(app).toContain('const setupLinks = () => [');
    expect(app).toContain('...setupLinks()');
  });
});

describe('the front end is ES modules (U13)', () => {
  const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  const source = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, jsDir), 'utf8')]));

  it('loads one entry module and no monolith', () => {
    expect(html).toContain('<script type="module" src="/assets/js/main.js"></script>');
    expect(files).not.toContain('app.js');
    for (const f of ['api.js', 'state.js', 'dom.js', 'board.js', 'detail.js', 'today.js', 'runs.js', 'dialogs.js', 'menus.js', 'analytics.js', 'main.js']) {
      expect(files).toContain(f);
    }
  });

  it('imports only names another module exports', () => {
    const exported = new Map();
    for (const [file, text] of Object.entries(source)) {
      for (const m of text.matchAll(/^export (?:async )?(?:function\*?|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
        exported.set(`${file}:${m[1]}`, true);
      }
    }
    for (const [file, text] of Object.entries(source)) {
      for (const m of text.matchAll(/^import \{ ([^}]+) \} from '\.\/([\w-]+\.js)';$/gm)) {
        for (const name of m[1].split(',').map((n) => n.trim())) {
          expect(exported.has(`${m[2]}:${name}`), `${file} imports ${name} from ${m[2]}`).toBe(true);
        }
      }
    }
  });

  it('keeps load-time work in the entry module', () => {
    // Everything else only declares, or registers listeners; boot calls live
    // in main.js, which runs after every other module has evaluated — so a
    // circular import can never hit a binding in its temporal dead zone.
    expect(source['main.js']).toContain('refreshAll({ force: true })');
    for (const [file, text] of Object.entries(source)) {
      if (file === 'main.js') continue;
      expect(text, file).not.toMatch(/^refreshAll\(|^pollRun\(|^setView\(/m);
    }
  });
});
