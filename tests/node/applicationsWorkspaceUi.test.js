/**
 * P1B-2 — the Applications workspace as shipped: markup, the safety of every
 * card action, the Today follow-up group, and the stage tab that now agrees
 * with the board. DOM-bound modules are checked as source, like
 * uiModernization.test.js; the board views are exercised against a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { openDatabase } from '../../src/logging/db.js';
import { BOARD_VIEWS, listBoardJobs } from '../../src/dashboard/data.js';

// Windows checkouts get CRLF (.gitattributes text=auto); the assertions below are written against LF.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
const js = (f) => read(`../../src/dashboard/public/assets/js/${f}`);
const workspace = js('workspace.js');

describe('markup', () => {
  it('mounts the workspace inside the Applications view with a Board/List switch', () => {
    expect(html).toContain('<section class="workspace" id="workspace" aria-label="Applications by stage" hidden>');
    expect(html).toMatch(/id="appsLayout" role="group" aria-label="Layout" hidden/);
    expect(html).toContain('data-action="set-apps-layout" data-layout="kanban" aria-pressed="true">Board</button>');
    expect(html).toContain('data-action="set-apps-layout" data-layout="list" aria-pressed="false">List</button>');
    expect(html).toContain('id="wsAnnounce" class="sr-only" role="status" aria-live="polite"');
  });
});

describe('a drag is a request, never an authorization', () => {
  it('never approves, fills-to-submit or marks a submission from the workspace module', () => {
    for (const forbidden of ['/approve', 'mark-submitted', 'auto-submit', 'approve-batch', 'assist-batch']) {
      expect(workspace).not.toContain(forbidden);
    }
    // The only writes it makes are outcomes and follow-ups, which the server validates.
    const posts = [...workspace.matchAll(/postJson\(`([^`]+)`/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, ':id'));
    expect(posts.sort()).toEqual(['/api/jobs/:id/follow-up', '/api/jobs/:id/outcome', '/api/jobs/:id/undo-outcome']);
  });

  it('sends an unsubmitted card dropped on "Applied" to the human submit dialog', () => {
    expect(workspace).toContain("targets.applied = 'submit';");
    expect(workspace).toContain("if (what === 'submit') { openSubmitDialog(id); return; }");
  });

  it('opens the job, not an approval, from a card awaiting review', () => {
    expect(read('../../src/dashboard/data.js')).toContain(
      "case APP_STATUS.NEEDS_REVIEW: return { kind: 'review', label: 'Review resume' };");
  });

  it('gives every drag a keyboard and touch path, and closes the menu on Escape', () => {
    expect(workspace).toContain("'data-action': 'ws-move-menu'");
    expect(workspace).toContain("'aria-haspopup': 'menu'");
    expect(workspace).toContain("if (event.key === 'Escape') { event.preventDefault(); closeMoveMenu({ returnFocus: true }); return; }");
    expect(workspace).toMatch(/class: 'ws-card-title', 'data-action': 'ws-open'/);
  });
});

describe('Today follow-ups', () => {
  it('has its own group after "Finish applications", with a Done shortcut', () => {
    const today = js('today.js');
    const finish = today.indexOf("{ key: 'finish'");
    const follow = today.indexOf("{ key: 'followup', title: 'Follow up'");
    expect(follow).toBeGreaterThan(finish);
    expect(follow).toBeLessThan(today.indexOf("{ key: 'decide'"));
    expect(today).toContain("if (kind === 'followup') return 'followup';");
    expect(today).toContain("'data-action': 'ws-followup', 'data-op': 'done'");
  });
});

describe('navigation', () => {
  it('only an explicit view-switch click resets an application stage to all jobs', () => {
    expect(js('actions.js')).toContain("'set-view': (target) => setView(target.dataset.view, { nav: true }),");
    expect(js('today.js')).toContain("if (view === 'board' && appTab && nav) {");
  });

  it('shows the list, not the board, for a deep link onto one stage', () => {
    expect(js('today.js')).toContain('state.appsDeepLink = true;');
    expect(workspace).toContain("return state.appsLayout === 'list' || state.appsDeepLink ? 'list' : 'kanban';");
  });
});

describe('"Needs you" tab agrees with the board column', () => {
  it('counts unverified submissions in needs_you while blocked keeps its narrower meaning', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'stuck', title: 'A', status: 'assist_blocked', score: 70, tier: 'Apply' });
    db.upsertJob({ id: 'unsure', title: 'B', status: 'submit_unverified', score: 70, tier: 'Apply' });
    const ids = (view) => listBoardJobs(db, { view }).map((r) => r.id).sort();
    expect(ids('needs_you')).toEqual(['stuck', 'unsure']);
    expect(ids('blocked')).toEqual(['stuck']);
    expect(Object.keys(BOARD_VIEWS)).toContain('needs_you');
    expect(js('filters.js')).toContain("['needs_you', 'Needs you', true],");
    db.close();
  });
});

describe('styling', () => {
  it('fits all seven stages on a laptop as two phase bands, one row when wide', () => {
    expect(css).toContain('.band-prepare .ws-cols { --ws-cols: 3; }');
    expect(css).toContain('@container wsboard (min-width: 1560px)');
  });

  it('respects reduced motion and gates hover to fine pointers', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\.ws-card, \.ws-col/);
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\n {2}\.ws-card:hover/);
  });
});
