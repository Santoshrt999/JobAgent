/**
 * Posting-age windows on the board.
 *
 * The segmented control and the filter share one allowlist (`POSTED_WINDOWS`).
 * They used to drift: the filter hardcoded `[3, 6, 24]` and SILENTLY IGNORED
 * anything else, so a chip offering a window the filter did not know would
 * render as active over a completely unfiltered board — the same class of lie
 * as a tab badge that disagrees with the rows it opens.
 *
 * 3d and 1w exist because of where the jobs actually are: one measured run held
 * 5 postings under 24 hours old and 4,439 under a week.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  POSTED_WINDOWS, boardPage, dashboardStats, BOARD_VIEWS, OPEN_ONLY_VIEWS, CLOSED_ROW_VIEWS,
} from '../../src/dashboard/data.js';

const HOUR = 3600_000;

/** Minimal in-memory stand-in for the Database wrapper the board reads. */
function fakeDb(jobs) {
  return {
    listJobsSummary: () => jobs,
    listJobs: () => jobs,
    listApprovals: () => [],
  };
}

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const job = (id, hoursAgo) => ({
  id,
  source: 'workday',
  company: 'Acme',
  title: 'Senior Data Engineer',
  url: `https://acme.wd1.myworkdayjobs.com/Careers/job/X/Y_${id}`,
  posted_at: hoursAgo === null ? null : at(hoursAgo),
  created_at: at(1),
  score: 80,
  tier: 'Queue',
  status: 'scored',
});

const JOBS = [
  job('h1', 1), // 1 hour
  job('h5', 5), // 5 hours
  job('h20', 20), // 20 hours
  job('d2', 48), // 2 days
  job('d5', 120), // 5 days
  job('d20', 480), // 20 days
  job('none', null), // undated
];

describe('POSTED_WINDOWS', () => {
  it('offers a week, which is where the jobs actually are', () => {
    expect(POSTED_WINDOWS).toContain(168);
  });

  it('is the single source of truth shared with the segmented control', () => {
    // Any button offering a window the filter does not honor would look active
    // over an unfiltered board.
    const html = readFileSync(join(process.cwd(), 'src/dashboard/public/index.html'), 'utf8');
    const offered = [...html.matchAll(/data-action="set-posted"\s+data-value="(\d+)"/g)]
      .map((m) => Number(m[1]));
    expect(offered.length).toBeGreaterThan(0);
    for (const v of offered) expect(POSTED_WINDOWS).toContain(v);
  });
});

describe('board filtering by posting age', () => {
  const db = fakeDb(JOBS);
  const total = (hours) => boardPage(db, { postedWithinHours: hours, limit: 100 }).total;

  it('narrows correctly at each offered window', () => {
    expect(total(3)).toBe(1); // h1
    expect(total(6)).toBe(2); // h1, h5
    expect(total(24)).toBe(3); // + h20
    expect(total(72)).toBe(4); // + d2
    expect(total(168)).toBe(5); // + d5
  });

  it('excludes undated jobs from every window', () => {
    // A job with no posting date cannot be claimed to be from the last week.
    for (const w of POSTED_WINDOWS) {
      const ids = boardPage(db, { postedWithinHours: w, limit: 100 }).jobs.map((j) => j.id);
      expect(ids).not.toContain('none');
    }
  });

  it('shows everything when no window is selected', () => {
    expect(boardPage(db, { limit: 100 }).total).toBe(JOBS.length);
    expect(boardPage(db, { postedWithinHours: '', limit: 100 }).total).toBe(JOBS.length);
  });

  it('accepts the value as a string, which is how the UI sends it', () => {
    expect(total('168')).toBe(5);
  });
});

// REGRESSION — SILENT FILTER DROP. The window was applied only when the value
// appeared in POSTED_WINDOWS, and IGNORED otherwise: an unrecognised value
// returned the full, unfiltered board while the UI still showed an active
// "Posted < 1 week ago" chip. Observed in production — a dashboard server
// started before 168 was added to the allowlist kept serving the old list, so
// selecting "1w" listed month-old postings under a chip claiming otherwise.
describe('posting-age window is honored, never silently dropped', () => {
  const db = fakeDb(JOBS);

  it('honors a window the presentation list does not happen to offer', () => {
    // 336h (2 weeks) is a perfectly usable window that POSTED_WINDOWS omits.
    expect(POSTED_WINDOWS).not.toContain(336);
    const total = boardPage(db, { postedWithinHours: 336, limit: 100 }).total;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(JOBS.length); // it actually filtered
    // Everything except the 480h job and the undated one.
    expect(total).toBe(5);
  });

  it('fails CLOSED on an unusable window rather than showing every row', () => {
    // An honest empty board beats silently returning the whole corpus under an
    // active filter chip.
    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity']) {
      expect(boardPage(db, { postedWithinHours: bad, limit: 100 }).total,
        `postedWithinHours=${bad}`).toBe(0);
    }
  });

  it('an empty value still means "no window", showing everything', () => {
    expect(boardPage(db, { postedWithinHours: '', limit: 100 }).total).toBe(JOBS.length);
  });
});

describe('location filters (state / city)', () => {
  const located = [
    { ...job('tx-dallas', 5), location: 'Dallas, TX' },
    { ...job('tx-austin', 5), location: 'Austin, Texas, United States of America' },
    { ...job('az', 5), location: 'Phoenix, AZ' },
    { ...job('remote', 5), location: 'Remote, United States' },
    { ...job('foreign', 5), location: 'Berlin, DE' },
  ];
  const db = fakeDb(located);
  const ids = (filters) => boardPage(db, { ...filters, limit: 100 }).jobs.map((j) => j.id).sort();

  it('matches a state by code and by spelled-out name', () => {
    expect(ids({ state: 'TX' })).toEqual(['tx-austin', 'tx-dallas']);
    expect(ids({ state: 'AZ' })).toEqual(['az']);
  });

  // A bare two-letter code is the one genuinely ambiguous case: "Berlin, DE"
  // reads as Delaware to usLocationSignal, which reports it with
  // strength:'abbreviation' precisely so a CALLER can outrank it with a foreign
  // country name (see the DESIGN NOTES in utils/usGeography.js — the module
  // stays config-free on purpose and does not do that weighing itself).
  //
  // The board does not re-implement that weighing, and deliberately so: the
  // US-only geography gate in scoring/exclusionFilter.js — which DOES consult
  // the configured nonUsCountryMarkers — has already discarded these rows long
  // before the board sees them. Measured against the real database: 43 rows
  // resolve to a US state only via a bare foreign country code, and ZERO of
  // them are reachable on the open board, because every one is closed. Both
  // the state filter and the byState coverage stat exclude closed rows.
  //
  // This test pins that LAYERING, so that if the upstream gate is ever
  // loosened, the board's exposure becomes visible here rather than silently
  // filing Toronto under California.
  it('relies on the upstream US-only gate for foreign two-letter codes, not on re-filtering', () => {
    const gateBypassed = fakeDb([{ ...job('berlin', 5), location: 'Berlin, DE', status: 'scored' }]);
    // Bare abbreviation with no gate in front of it: the board takes it at face value…
    expect(boardPage(gateBypassed, { state: 'DE', limit: 100 }).jobs.map((j) => j.id)).toEqual(['berlin']);
    // …but in the real pipeline that row is discarded, so it never reaches the
    // default board, which hides closed jobs.
    const gated = fakeDb([{ ...job('berlin', 5), location: 'Berlin, DE', status: 'discarded' }]);
    expect(boardPage(gated, { state: 'DE', limit: 100 }).total).toBe(0);
  });

  it('a spelled-out state name is always conclusive, gate or no gate', () => {
    const named = fakeDb([{ ...job('de-real', 5), location: 'Wilmington, Delaware, United States' }]);
    expect(boardPage(named, { state: 'DE', limit: 100 }).jobs.map((j) => j.id)).toEqual(['de-real']);
  });

  it('offers REMOTE as a location choice', () => {
    expect(ids({ state: 'REMOTE' })).toEqual(['remote']);
  });

  it('matches city case-insensitively as a substring of the LOCATION only', () => {
    expect(ids({ city: 'dallas' })).toEqual(['tx-dallas']);
    expect(ids({ city: 'Austin' })).toEqual(['tx-austin']);
  });

  it('does not let a city match bleed into company or title text', () => {
    const trap = fakeDb([
      { ...job('right', 5), company: 'Acme', location: 'Phoenix, AZ' },
      { ...job('wrong', 5), company: 'Phoenix Technologies', location: 'Boston, MA' },
    ]);
    expect(boardPage(trap, { city: 'phoenix', limit: 100 }).jobs.map((j) => j.id)).toEqual(['right']);
  });

  it('combines with the posting-age window', () => {
    const mixed = fakeDb([
      { ...job('tx-fresh', 5), location: 'Dallas, TX' },
      { ...job('tx-old', 480), location: 'Dallas, TX' },
    ]);
    expect(boardPage(mixed, { state: 'TX', postedWithinHours: 168, limit: 100 })
      .jobs.map((j) => j.id)).toEqual(['tx-fresh']);
  });

  it('an empty state/city means no location filter at all', () => {
    expect(ids({ state: '', city: '' })).toHaveLength(located.length);
  });
});

describe('header counts reconcile with the filter they open', () => {
  it('"posted 1w" equals the rows its chip opens', () => {
    const db = fakeDb(JOBS);
    const stats = dashboardStats(db, { now: new Date() });
    const rows = boardPage(db, { postedWithinHours: 168, limit: 100 }).total;
    expect(stats.totals.postedLast7d).toBe(rows);
  });

  it('"posted 24h" still equals the rows its chip opens', () => {
    const db = fakeDb(JOBS);
    const stats = dashboardStats(db, { now: new Date() });
    expect(stats.totals.postedLast24h).toBe(boardPage(db, { postedWithinHours: 24, limit: 100 }).total);
  });

  it('counts only actionable jobs, matching the board that hides closed ones', () => {
    const withClosed = fakeDb([...JOBS, { ...job('closed', 2), status: 'discarded' }]);
    const stats = dashboardStats(withClosed, { now: new Date() });
    expect(stats.totals.postedLast7d).toBe(boardPage(withClosed, { postedWithinHours: 168, limit: 100 }).total);
  });
});

/**
 * The board serves most requests from a base row set that EXCLUDES rows SQL can
 * prove are `discarded` (db.listOpenJobsSummary) — on real data that is ~98% of
 * the table, and reading it to render a page that hides it was what made every
 * filter click and row action block the server for seconds.
 *
 * That shortcut is only sound for a view whose predicate can never match a
 * closed row. `OPEN_ONLY_VIEWS` asserts which views those are; this test proves
 * the assertion rather than trusting it, by driving every listed predicate
 * against the full cartesian product of the fields those predicates read, once
 * per closed status. If someone adds a view that CAN surface a closed row and
 * lists it here, this fails instead of the board silently dropping its rows.
 */
describe('OPEN_ONLY_VIEWS is honest about which views hide closed rows', () => {
  const FIT = ['strong', 'medium', 'weak', 'no_fit', 'unscored'];
  const CLOSED = ['archived', 'rejected', 'discarded'];

  it('no listed view matches any closed row, for any field combination', () => {
    expect(OPEN_ONLY_VIEWS.size).toBeGreaterThan(0);
    const offenders = [];
    for (const key of OPEN_ONLY_VIEWS) {
      const pred = BOARD_VIEWS[key];
      expect(typeof pred, `${key} must be a real view`).toBe('function');
      for (const appStatus of CLOSED) {
        for (const fit of FIT) {
          for (const recommend of [true, false]) {
            for (const postedLast24h of [true, false]) {
              for (const sponsorshipGated of [true, false]) {
                const row = {
                  appStatus, fit, grade: { recommend }, postedLast24h, sponsorshipGated,
                };
                if (pred(row)) offenders.push(`${key} matched ${JSON.stringify(row)}`);
              }
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every view key is covered, so a new view cannot be forgotten', () => {
    // If a future view legitimately shows closed rows it must be REMOVED from
    // OPEN_ONLY_VIEWS (not just left out of the loop above) — this keeps the two
    // lists from drifting apart unnoticed.
    for (const key of Object.keys(BOARD_VIEWS)) {
      expect(OPEN_ONLY_VIEWS.has(key) !== CLOSED_ROW_VIEWS.has(key),
        `view "${key}" must be in exactly one of OPEN_ONLY_VIEWS and CLOSED_ROW_VIEWS`).toBe(true);
    }
  });

  it('a closed-row view shows only its own closed status', () => {
    expect([...CLOSED_ROW_VIEWS]).toEqual(['archived']);
    const pred = BOARD_VIEWS.archived;
    expect(pred({ appStatus: 'archived' })).toBe(true);
    for (const appStatus of ['rejected', 'discarded', 'scored', 'shortlisted', 'submitted']) {
      expect(pred({ appStatus }), appStatus).toBe(false);
    }
  });
});
