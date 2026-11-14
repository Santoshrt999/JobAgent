/**
 * Glass refinement (2026-11): the header's three menus, the docked bulk-action
 * bar, the checkbox, row states and the one glass material. The bulk-step
 * logic is pure and tested directly; DOM-bound modules are checked as shipped
 * source, like workbenchUi.test.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { bulkStepReasons, primaryBulkStep, RUN_BUSY } from '../../src/dashboard/public/assets/js/bulk.js';

// Windows checkouts get CRLF (.gitattributes text=auto); the assertions below are written against LF.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
const js = (f) => read(`../../src/dashboard/public/assets/js/${f}`);

const job = (appStatus, resumeStatus = 'none') => ({ appStatus, resumeStatus });

describe('bulk steps: what a selection allows', () => {
  it('promotes Approve when any packet awaits approval, even in a mixed selection', () => {
    const jobs = [job('scored'), job('needs_review', 'tailored'), job('approved', 'tailored')];
    expect(primaryBulkStep(jobs, bulkStepReasons(3, jobs))).toBe('approve');
  });

  it('promotes Auto-fill for approved jobs, but never while Auto-fill is unavailable', () => {
    const jobs = [job('approved', 'tailored')];
    expect(primaryBulkStep(jobs, bulkStepReasons(1, jobs))).toBe('autofill');
    const blocked = bulkStepReasons(1, jobs, { blocked: 'Playwright browser is not installed' });
    expect(blocked.autofill).toMatch(/Playwright/);
    expect(primaryBulkStep(jobs, blocked)).toBe('prepare');
    expect(primaryBulkStep(jobs, bulkStepReasons(1, jobs, { running: true }))).toBe('prepare');
  });

  it('defaults to Prepare for jobs with no packet', () => {
    const jobs = [job('scored'), job('shortlisted')];
    expect(primaryBulkStep(jobs, bulkStepReasons(2, jobs))).toBe('prepare');
  });

  it('rules out Approve only when every selected job is known to have no packet', () => {
    expect(bulkStepReasons(2, [job('scored'), job('scored')]).approve).toMatch(/prepare them first/);
    // One selected row is not loaded (another page): it might have a packet.
    expect(bulkStepReasons(3, [job('scored'), job('scored')]).approve).toBeNull();
    expect(bulkStepReasons(1, [job('scored', 'prepared')]).approve).toBeNull();
  });

  it('refuses Prepare and Auto-fill while a run holds the lock, and Compare below two', () => {
    const r = bulkStepReasons(1, [job('scored')], { running: true });
    expect(r.prepare).toBe(RUN_BUSY);
    expect(r.autofill).toBe(RUN_BUSY);
    expect(r.compare).toMatch(/2 to 4/);
    expect(bulkStepReasons(2, [job('scored'), job('scored')]).compare).toBeNull();
  });
});

describe('the bulk-action bar keeps every safeguard', () => {
  const bar = html.slice(html.indexOf('<div id="selbar"'), html.indexOf('<table id="board"'));

  it('dispatches only the existing batch actions — nothing that submits', () => {
    for (const action of ['batch-autofill', 'batch-prepare', 'batch-approve', 'batch-decide', 'compare', 'clear-selection']) {
      expect(bar, action).toContain(`data-action="${action}"`);
    }
    const actions = new Set([...bar.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]));
    expect([...actions].sort()).toEqual(
      ['batch-approve', 'batch-autofill', 'batch-decide', 'batch-prepare', 'clear-selection', 'compare', 'toggle-bulk-menu'],
    );
    expect(html).not.toMatch(/auto-submit/);
  });

  it('still confirms Auto-fill and still stops before Submit', () => {
    const autofill = js('selection.js').slice(js('selection.js').indexOf('export async function batchAutofill'));
    expect(autofill).toMatch(/if \(autofillBlockedReason\(\)\)/);
    expect(autofill).toMatch(/if \(state\.running\)/);
    expect(autofill).toContain('confirmAction(message');
    expect(autofill).toContain('It always stops before the final Submit button.');
    expect(js('actions.js')).toMatch(/'batch-autofill', 'batch-prepare', 'batch-approve', 'batch-decide', 'compare'/);
  });

  it('is a toolbar docked above the column headers while rows are ticked, and above the thumb on phones', () => {
    // Above the table, sticking under the top bar; the headers stick beneath
    // it while it is open, so names and sorting stay visible (audit
    // 2026-11-13: floating over the rows it blended into them). It takes no
    // room at rest; opening it scrolls the page so the clicked row stays put.
    const board = html.slice(html.indexOf('id="boardwrap"'), html.indexOf('<table id="board"'));
    expect(board).toContain('<div id="selbar" role="toolbar"');
    expect(board).not.toContain('selbar-idle');
    expect(css).toMatch(/#selbar \{\s*position: sticky; top: var\(--topbar-h, 51px\); z-index: 4;\s*height: 0; overflow: hidden;/);
    expect(css).toMatch(/#selbar\[data-open="true"\] \{\s*height: var\(--tbar-h\);/);
    expect(css).toContain('#boardwrap:has(#selbar[data-open="true"]) thead th { top: calc(var(--topbar-h, 51px) + var(--tbar-h)); }');
    expect(css).toMatch(/thead th \{[^}]*height: 40px/);
    expect(js('selection.js')).toContain('keepRowStill(() => { bar.dataset.open = open; })');
    // The pipeline is one stepper, in the order the work happens.
    const pipeline = bar.slice(bar.indexOf('selbar-pipeline'));
    expect(pipeline.indexOf('batch-prepare')).toBeLessThan(pipeline.indexOf('batch-approve'));
    expect(pipeline.indexOf('batch-approve')).toBeLessThan(pipeline.indexOf('batch-autofill'));
    expect(css).toMatch(/@media \(max-width: 860px\) \{\s*#selbar, #selbar\[data-open="true"\] \{\s*position: fixed;/);
    expect(css).toContain('body:has(#selbar[data-open="true"]) .layout { padding-bottom: 84px; }');
  });

  it('keeps the actions inert until something is selected, and the phone wrapper out of the way', () => {
    expect(css).toMatch(/#selbar \.selbar-inner \{[^}]*visibility: hidden; transform: translateY\(-2px\); pointer-events: none;/);
    expect(css).toMatch(/#selbar\[data-open="true"\] \.selbar-inner \{[^}]*pointer-events: auto;/);
    const phone = css.slice(css.indexOf('#selbar, #selbar[data-open="true"] {'));
    expect(phone.slice(0, phone.indexOf('}'))).toContain('pointer-events: none;');
  });

  it('folds secondary actions into an overflow menu when the bar is narrow', () => {
    expect(css).toContain('container: selbar / inline-size;');
    expect(css).toMatch(/@container selbar \(max-width: 760px\) \{[\s\S]*?\.selbar-more \{ display: inline-block; \}/);
    expect(js('menus.js')).toContain("bulkMenu: 'toggle-bulk-menu'");
    // Disabled buttons cannot be focused, so their reasons reach a screen reader via the toolbar description.
    expect(html).toContain('aria-describedby="selHint"');
    expect(html).toContain('id="selAnnounce" class="sr-only" role="status" aria-live="polite"');
  });
});

describe('header: three menus and a theme toggle', () => {
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));

  it('splits the old twenty-item menu by purpose without losing an item', () => {
    // Each menu up to its own closing tag (menu labels are <div>s too, one level deeper).
    const menu = (id) => header.slice(header.indexOf(`id="${id}"`), header.indexOf('\n      </div>', header.indexOf(`id="${id}"`)));
    for (const a of ['run" data-phase="prepare', 'open-add-url', 'run" data-phase="score', 'open-job-search', 'sweep-postings']) {
      expect(menu('mainMenu'), a).toContain(`data-action="${a}"`);
    }
    for (const a of ['open-runs', 'open-data-quality', 'open-health', 'open-reports', 'export-jobs', 'export-tracker']) {
      expect(menu('activityMenu'), a).toContain(`data-action="${a}"`);
    }
    for (const a of ['open-master', 'open-profile', 'open-documents', 'open-keys', 'toggle-theme']) {
      expect(menu('accountMenu'), a).toContain(`data-action="${a}"`);
    }
  });

  it('wires every menu trigger into the menu-button pattern', () => {
    for (const [pop, action] of [['activityMenu', 'toggle-activity-menu'], ['accountMenu', 'toggle-account-menu']]) {
      expect(js('menus.js')).toContain(`${pop}: '${action}'`);
      // The handler toggles its own menu (the Profile one also fetches the profile list on a cold start).
      // (The Activity one first settles which optional tools it lists.)
      expect(js('actions.js')).toMatch(new RegExp(`'${action}': (?:async )?\\(\\) => \\{?[\\s\\S]{0,400}?toggleMenu\\((?:\\$\\('${pop}'\\)|pop)\\)`));
      expect(header).toContain(`data-action="${action}" aria-haspopup="true"`);
    }
    expect(js('actions.js')).toMatch(/KEEP_MENU_OPEN = \[[\s\S]*'toggle-activity-menu', 'toggle-account-menu', 'toggle-bulk-menu'/);
  });

  it('labels icon buttons, and names the theme toggle by where it goes', () => {
    for (const m of header.matchAll(/<button[^>]*class="iconbtn[^"]*"[^>]*>/g)) {
      expect(m[0], m[0]).toMatch(/aria-label="[^"]+"/);
      expect(m[0], m[0]).toMatch(/title="[^"]+"/);
    }
    expect(js('main.js')).toContain("const label = `Switch to ${current === 'light' ? 'dark' : 'light'} theme`;");
    expect(js('actions.js')).toMatch(/savePreference\('theme', next\);\s*syncThemeControl\(\);/);
  });

  it('gives the theme button up on small phones, keeping its twin in the menu', () => {
    // `.menu-pop .only-narrow`, not `.only-narrow`: the base rule hiding it is
    // also !important and comes LATER, so an equally specific selector here
    // lost and the twins never appeared on a phone.
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.theme-toggle \{ display: none; \}\s*\.menu-pop \.only-narrow \{ display: flex !important; \}/);
  });
});

describe('checkboxes and row states', () => {
  it('draws the tick as a mask, not as positioned gradients', () => {
    expect(css).not.toMatch(/background-position: 4\.5px 8px/);
    expect(css).toContain('mask: var(--ic-tick) center / contain no-repeat;');
    expect(css).toMatch(/#selAll:indeterminate::after \{ -webkit-mask-image: var\(--ic-minus\); mask-image: var\(--ic-minus\); \}/);
    expect(css).toMatch(/@media \(forced-colors: active\) \{[\s\S]*?appearance: auto;/);
  });

  it('keeps a 32px target and a 3:1 resting edge', () => {
    expect(css).toMatch(/#board td\.check input\[type=checkbox\], #selAll, \.toggle input\[type=checkbox\][^{]*\{[^}]*width: var\(--h-md\); height: var\(--h-md\);/);
    expect(css).toContain('border: 1.5px solid var(--control-edge); background: transparent;');
  });

  it('tells ticked, opened and focused rows apart', () => {
    expect(css).toContain('tr.job:has(td.check input:checked) { background:');
    // A box-shadow on a collapsed-table <tr> is never painted: the rail is on the first cell.
    expect(css).toContain('tr.job[aria-current="true"] > td:first-child { box-shadow: inset 2px 0 0 var(--accent); }');
    expect(css).toContain('tr.job:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }');
  });
});

describe('one glass material, with fallbacks', () => {
  it('defines the glass tokens in both themes', () => {
    for (const token of ['--glass:', '--glass-strong:', '--glass-line:', '--glass-hi:', '--control-edge:', '--raised:']) {
      expect(css.match(new RegExp(token, 'g'))?.length, token).toBe(3); // dark + explicit light + system light
    }
  });

  it('blurs only where supported, and turns solid under reduced transparency', () => {
    expect(css).toMatch(/@supports \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{\s*\.menu-pop, \.ws-menu, \.run-details, \.toast \{/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce) {'));
    expect(reduced).toMatch(/backdrop-filter: none !important;/);
    expect(reduced).toContain('.topbar::before, #selbar .selbar-inner::before { display: none; }');
  });

  it('keeps dialogs solid, because they sit over a dark backdrop in both themes', () => {
    expect(css).toContain('dialog { background: var(--surface); }');
  });

  it('uses no colour emoji as icons in the dashboard scripts', () => {
    for (const f of ['detail.js', 'reports.js', 'selection.js']) {
      expect(js(f), f).not.toMatch(/text: '[^']*(⚡|📄|👁)/u);
    }
  });
});

/* ───────────── round 2: master resume, detail panel, forms ───────────── */

import { classifyResumeLine } from '../../src/dashboard/public/assets/js/format.js';

describe('master resume preview reads structure, not one profession\'s vocabulary', () => {
  const kinds = (lines) => {
    let before = true;
    return lines.map((line, index) => {
      const kind = classifyResumeLine(line, { beforeFirstHeading: before, index });
      if (kind === 'heading') before = false;
      return kind;
    });
  };

  it.each([
    ['nurse', ['Maria Lopez', 'Chicago, IL | maria@example.com', 'EXPERIENCE',
      'Registered Nurse, ICU | Mercy Hospital', 'Chicago, IL | June 2019 - Present',
      'Reduced patient wait times by 20% through a triage redesign.']],
    ['accountant', ['Sam Patel', 'sam@example.com · (555) 010-2000', 'Professional Experience',
      'Senior Accountant — Northwind Traders', 'Mar 2016 – Dec 2021',
      'Closed the books four days faster by automating reconciliations.']],
    ['teacher', ['Ada Brown', 'Portland, OR', 'TEACHING EXPERIENCE',
      'Grade 5 Teacher | Lincoln Elementary', 'Aug 2018 - Present',
      'Raised reading scores 15% with small-group instruction.']],
  ])('shapes a %s resume', (_who, lines) => {
    expect(kinds(lines)).toEqual(['name', 'contact', 'heading', 'role', 'when', 'item']);
  });

  it('caps the name-and-contact block at four lines when no heading comes early', () => {
    const lines = ['Jane Roe', 'jane@example.com', 'Summary sentence.', 'Another sentence.', 'Analyst | Contoso', '2019 - Present', 'LATE HEADING'];
    expect(kinds(lines).slice(4, 6)).toEqual(['role', 'when']);
  });

  it('shows the file path only behind a disclosure, unless the file is missing', () => {
    const master = read('../../src/dashboard/public/assets/js/master.js');
    expect(master).toContain("el('details', { class: 'mr-loc' }, el('summary', { text: 'File location' }), where)");
    expect(master).toMatch(/if \(master\.exists\) \{\s*body\.append\(el\('details', \{ class: 'mr-loc' \}/);
    // Panels are neutral; amber stays for genuine decisions.
    expect(master).not.toContain("class: 'evidence-note' })");
    expect(master).toContain("class: diff.drifted ? 'attention' : 'mr-block'");
    expect(master).not.toMatch(/profile stack|skill term\(s\)/);
  });
});

describe('job detail panel: flat sections, nothing said twice', () => {
  const detail = js('detail.js');

  it('divides sections with a rule instead of nesting cards', () => {
    expect(css).toMatch(/\.detail-panel > \.rail-sec \+ \.rail-sec \{\s*border-top: 1px solid var\(--line-soft\)/);
    expect(css).toContain('.fitcard { padding: 0; }');
    expect(css).toContain('.resume-card { padding: 0; margin: 0; }');
  });

  it('does not repeat a decision "Do this next" already offers', () => {
    expect(detail).toContain("const offered = new Set([...next.querySelectorAll('[data-action=\"decide\"]')].map((b) => b.dataset.decision));");
    expect(detail).toContain('(visible && !offered.has(decision) ? actions : more).append(');
  });

  it('names the application system once, and uses no emoji labels', () => {
    expect(detail).toContain("job.atsPlatform && job.atsPlatform !== job.source ? `applies on ${job.atsPlatform}` : null");
    expect(detail).not.toMatch(/🧾|👤|⬇ DOCX/u);
    expect(detail).toContain("['stack', 'Skills']");
  });
});

describe('one form-control language', () => {
  it('styles every field from one zero-specificity base, with a drawn select chevron', () => {
    expect(css).toMatch(/:where\(input:not\(\[type=checkbox\], \[type=radio\]/);
    expect(css).toMatch(/select \{\s*-webkit-appearance: none; appearance: none;[\s\S]*?background-image: var\(--select-chev\)/);
    expect(css.match(/--select-chev:/g)).toHaveLength(3);
    // Component rules use background-color, so the base chevron survives them.
    expect(css).not.toMatch(/\.filters select \{[^}]*\bbackground: /);
  });

  it('draws every dialog close button and greys a disabled primary', () => {
    expect(html).not.toContain('✕');
    expect(html.match(/class="small ghost dlg-close"/g).length).toBeGreaterThanOrEqual(14);
    expect(css).toMatch(/button\.primary:disabled, button\.primary:disabled:hover \{\s*opacity: 1;/);
  });
});

describe('Find jobs: one aligned control, in Liquid Glass', () => {
  it('lays the halves out as one flex unit on the icon buttons\' height', () => {
    // `.split` is also `.menu`, whose later `display: inline-block` used to win
    // and leave the chevron half 21px tall, 7px low and 4px apart.
    expect(css).toMatch(/\.split\.menu \{\s*display: inline-flex; align-items: stretch; height: var\(--h-md\);/);
    expect(html).not.toMatch(/class="[^"]*primary[^"]*split-(main|toggle)/);
    expect(html).toContain('class="ic split-chev"');
  });

  it('draws the glass on a layer, so the Find jobs menu keeps its own frost', () => {
    // An ancestor with backdrop-filter is a backdrop root: the menu inside
    // would blur only the button. The wrapper itself must never carry it.
    expect(css).toMatch(/\.split\.menu::before \{ -webkit-backdrop-filter: blur\(10px\) saturate\(190%\); backdrop-filter: blur\(10px\) saturate\(190%\); \}/);
    expect(css).not.toMatch(/\.split\.menu \{[^}]*backdrop-filter/);
    expect(css).toMatch(/\.split\.menu > \.split-main, \.split\.menu > \.split-toggle \{[^}]*background: transparent; color: var\(--text\);/);
  });

  it('has a solid fallback, a capsule focus ring and one press for the whole control', () => {
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.split\.menu::before \{[^}]*backdrop-filter: none;/);
    expect(css).toContain('.split.menu:has(> :focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }');
    expect(css).toMatch(/\.split\.menu:has\(> \.split-main:active:not\(:disabled\)\), \.split\.menu:has\(> \.split-toggle:active\) \{ transform: scale\(\.97\); \}/);
    // The pointer's light: non-inheriting, so moving it never restyles the menu.
    expect(css).toContain("@property --gx { syntax: '<percentage>'; inherits: false;");
    expect(js('main.js')).toMatch(/still\.matches[\s\S]*glass\.style\.setProperty\('--gx'/);
  });

  it('defines the glass in every theme block', () => {
    for (const token of ['--lg-fill', '--lg-tint-a', '--lg-tint-b', '--lg-edge', '--lg-rim', '--lg-shade', '--lg-spec', '--lg-hover', '--lg-drop']) {
      expect(css.match(new RegExp(`${token}:`, 'g'))?.length, token).toBe(3);
    }
  });

  it('does not print the empty-field count twice', () => {
    const profile = js('profile.js');
    expect(profile).not.toContain("el('b', { text: String(open + missing) })");
    expect(profile).toContain("el('b', { text: String(n) }), el('span', { class: 'l', text: words })");
  });
});
