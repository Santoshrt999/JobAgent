/**
 * Explore JobAgent says what the code does. These tests hold it to that.
 *
 * The page (src/dashboard/public/assets/explore/) is a product overview and a
 * technical deep dive written from the source code. Prose drifts; so each part
 * of it that restates something the code defines is compared with the code:
 *
 *   - every repository path it cites exists;
 *   - its source list is the adapter registry, no more and no fewer;
 *   - its lifecycle diagram is src/lifecycle.js;
 *   - its command list is the CLI's command table;
 *   - its MCP tool list and API routes are the ones registered;
 *   - its Score Lab gives the same total and tier as the real scorer.
 *
 * A failure here means the page is now wrong, not that the test is fussy.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ADAPTERS } from '../../src/search/index.js';
import { adapterKind } from '../../src/search/sources.js';
import { LIFECYCLE_VALUES, TRANSITIONS } from '../../src/lifecycle.js';
import { COMMAND_TABLE } from '../../src/index.js';
import { scoreJob, PREFERRED_SKILL_CREDIT, STRUCTURAL_WEIGHTS, DEFAULT_TRACK_PENALTY } from '../../src/scoring/scorer.js';
import { explainScore } from '../../src/scoring/explainScore.js';
import { DEFAULT_ELIGIBILITY_PENALTY } from '../../src/scoring/eligibility.js';
import { FIXTURE_VERIFIED_AUTO_APPLY_ATS } from '../../src/apply/autoApplyEligibility.js';

import {
  STATUS, JOURNEY, GATES, SOURCES, SOURCE_GROUPS, SOURCE_MODES, CAPABILITIES, CAPABILITY_AREAS,
} from '../../src/dashboard/public/assets/explore/js/content-overview.js';
import {
  ARCH_LAYERS, ARCH_NODES, TRACES, LIFECYCLE_GROUPS, LIFECYCLE_STATES, LIFECYCLE_TRANSITIONS,
  API_GROUPS, CLI_GROUPS, MCP_TOOLS, DEEP_TOPICS,
} from '../../src/dashboard/public/assets/explore/js/content-deep.js';
import {
  SCORE_MODEL, DEFAULT_INPUTS, PRESETS, scoreInputs, freshnessFactor,
} from '../../src/dashboard/public/assets/explore/js/score-model.js';

const ROOT = process.cwd();
const EXPLORE = join(ROOT, 'src', 'dashboard', 'public', 'assets', 'explore');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const exploreSources = () => readdirSync(join(EXPLORE, 'js')).map((f) => [f, readFileSync(join(EXPLORE, 'js', f), 'utf8')]);

describe('Explore JobAgent: content matches the code', () => {
  it('cites only files that exist in the repository', () => {
    // Any quoted or backticked string that looks like a tracked path. Runtime
    // outputs (data/, logs/, reports/, resumes/output) are written by the app
    // and are not in the repository, so they are not checked.
    const PATH = /['"`]((?:src|config|scripts|tests|extension|\.github)\/[\w./-]+\.[a-z]+|[\w-]+\.(?:sh|cmd|ps1|ini)|eslint\.config\.js|vitest\.config\.js|jsconfig\.json|\.gitignore)['"`]/g;
    const cited = new Map();
    for (const [file, text] of exploreSources()) {
      for (const match of text.matchAll(PATH)) cited.set(match[1], file);
    }
    expect(cited.size).toBeGreaterThan(120);
    const missing = [...cited].filter(([path]) => !existsSync(join(ROOT, path))).map(([path, file]) => `${path} (cited in ${file})`);
    expect(missing).toEqual([]);
  });

  it('lists exactly the source adapters the search layer registers', () => {
    expect(SOURCES.map((s) => s.id).sort()).toEqual(Object.keys(ADAPTERS).sort());
    const groups = new Set(SOURCE_GROUPS.map((g) => g.id));
    for (const source of SOURCES) {
      expect(groups.has(source.group), source.id).toBe(true);
      expect(Object.keys(SOURCE_MODES), source.id).toContain(source.mode);
      // "Links you supply" is exactly the URL readers and the manual source.
      const kind = adapterKind(source.id);
      expect(source.group === 'urls', `${source.id} is a ${kind} adapter`).toBe(kind === 'url-reader' || kind === 'manual');
    }
  });

  it('marks as "on by default" only sources the shipped config enables', () => {
    const shipped = JSON.parse(read('config', 'jobboards.json')).sources;
    for (const source of SOURCES) {
      const enabled = shipped.some((s) => s.adapter === source.id && s.enabled === true);
      if (source.mode === 'on') expect(enabled, `${source.id} is described as on by default`).toBe(true);
      if (source.mode === 'key') expect(enabled, `${source.id} is described as needing a key`).toBe(false);
    }
  });

  it('draws the lifecycle exactly as src/lifecycle.js defines it', () => {
    expect(LIFECYCLE_STATES.map((s) => s.id).sort()).toEqual([...LIFECYCLE_VALUES].sort());
    expect(LIFECYCLE_TRANSITIONS).toEqual(TRANSITIONS);
    const groups = new Set(LIFECYCLE_GROUPS.map((g) => g.id));
    for (const state of LIFECYCLE_STATES) expect(groups.has(state.group), state.id).toBe(true);
  });

  it('lists every CLI command, and none that does not exist', () => {
    const real = COMMAND_TABLE.filter((c) => !c.hidden && c.kind !== 'help').map((c) => c.name).sort();
    const listed = CLI_GROUPS.flatMap((g) => g.commands.map(([name]) => name)).sort();
    expect(listed).toEqual(real);
  });

  it('lists the MCP tools the server registers', () => {
    const source = read('src', 'mcp', 'server.js');
    const block = source.match(/MCP_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
    expect([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...MCP_TOOLS]);
  });

  it('names only API routes the server answers', () => {
    const routes = ['server.js', ...readdirSync(join(ROOT, 'src', 'dashboard', 'routes')).map((f) => join('routes', f))]
      .map((f) => read('src', 'dashboard', f)).join('\n');
    for (const route of API_GROUPS.flatMap((g) => g.routes)) {
      const [method, path] = route.split(' ');
      expect(['GET', 'POST']).toContain(method);
      if (path.includes('/:id')) {
        // Per-job routes are matched by a pattern; the action name after the id must be handled.
        const action = path.split('/:id')[1].replace(/^\//, '');
        if (action) expect(routes, route).toContain(action);
      } else {
        expect(routes, route).toContain(`'${path}'`);
      }
    }
  });

  it('describes final auto-submit as experimental, and it is unreachable from the dashboard', () => {
    const autoSubmit = CAPABILITIES.find((c) => c.name === 'Final auto-submit');
    expect(autoSubmit.status).toBe('experimental');
    const frontEnd = readdirSync(join(ROOT, 'src', 'dashboard', 'public', 'assets', 'js'))
      .map((f) => read('src', 'dashboard', 'public', 'assets', 'js', f)).join('\n');
    expect(frontEnd).not.toContain('auto-submit-batch');
    // "Refused on every ATS until one is verified live" is true while this list ships empty.
    expect(JSON.parse(read('config', 'verified_live_ats.json')).verified).toEqual([]);
    const note = TRACES.find((t) => t.id === 'autofill').notes.find((n) => n.title === 'Which ATSs are covered').items[0].toLowerCase();
    for (const ats of FIXTURE_VERIFIED_AUTO_APPLY_ATS) expect(note).toContain(ats);
  });

  it('prints only true facts under the route stops', () => {
    for (const stop of [...JOURNEY, ...GATES]) expect(stop.fact, stop.id ?? stop.after).toMatch(/\S/);
    // The one number on the route is the number of source adapters.
    const discover = JOURNEY.find((s) => s.id === 'discover').fact;
    expect(Number(discover.match(/\d+/)[0])).toBe(Object.keys(ADAPTERS).length);
  });

  it('is internally consistent: statuses, topics and relations all resolve', () => {
    const topics = new Set(DEEP_TOPICS.map((t) => t.id));
    for (const stage of JOURNEY) expect(topics.has(stage.topic), stage.id).toBe(true);
    for (const gate of GATES) expect(JOURNEY.some((s) => s.id === gate.after)).toBe(true);
    for (const cap of CAPABILITIES) {
      expect(Object.keys(STATUS), cap.name).toContain(cap.status);
      expect(CAPABILITY_AREAS, cap.name).toContain(cap.area);
      expect(topics.has(cap.topic), cap.name).toBe(true);
    }
    // All four states are in use, so the legend never describes an empty set.
    for (const status of Object.keys(STATUS)) expect(CAPABILITIES.some((c) => c.status === status), status).toBe(true);
    for (const trace of TRACES) expect(topics.has(trace.id), trace.id).toBe(true);

    const nodeIds = new Set(ARCH_NODES.map((n) => n.id));
    const layers = new Set(ARCH_LAYERS.map((l) => l.id));
    expect(nodeIds.size).toBe(ARCH_NODES.length);
    for (const node of ARCH_NODES) {
      expect(layers.has(node.layer), node.id).toBe(true);
      expect(node.files.length, node.id).toBeGreaterThan(0);
      for (const to of node.talks) expect(nodeIds.has(to), `${node.id} -> ${to}`).toBe(true);
    }
  });

  it('uses the product’s plain punctuation: no em dashes in the copy', () => {
    for (const [file, text] of exploreSources()) {
      if (!file.startsWith('content-')) continue;
      expect(text, file).not.toMatch(/—/);
    }
  });
});

/* ───────────────────────── Score Lab parity ───────────────────────── */

const NOW = new Date('2026-06-15T12:00:00Z');
const SKILLS = ['python', 'sql', 'spark', 'airflow', 'kafka', 'dbt', 'snowflake', 'databricks'];

/** A scoring config with exactly the lab's weights, categories and thresholds. */
function scoringFromModel() {
  const from = { titleFit: 'targetTitles', coreSkills: 'technicalStack', domainFit: 'industries' };
  return {
    weights: { ...SCORE_MODEL.weights, eligibility: SCORE_MODEL.penalties.eligibility, payFit: SCORE_MODEL.penalties.payFit },
    tiers: { ...SCORE_MODEL.tiers },
    categories: SCORE_MODEL.categories.map((c) => ({
      id: c.id, label: c.label, weight: c.weight, fullAt: c.fullAt, from: from[c.id], ...(c.id === 'titleFit' ? { match: 'title' } : {}),
    })),
    keywords: {},
    sponsorshipGate: { allowApplyWhen: ['Confirmed', 'Likely', 'Approved'] },
    freshness: {},
  };
}

/** Build a real posting and candidate with the properties the lab's inputs describe. */
function realCase(inputs) {
  const x = { ...DEFAULT_INPUTS, ...inputs };
  const required = SKILLS.slice(0, x.skillsFound - x.skillsPreferredOnly);
  const preferred = SKILLS.slice(x.skillsFound - x.skillsPreferredOnly, x.skillsFound);
  const level = { match: 'Senior ', up1: 'Lead ', up2: 'Principal ', up3: 'Director of ', down1: '', down2: 'Associate ', unstated: '' }[x.seniority];
  const lines = [
    'Requirements:',
    ...required.map((skill) => `- Hands-on work with ${skill}.`),
    x.domainMatch ? '- Our customers are in insurance.' : '- Our customers are in logistics.',
    x.eligibility === 'ineligible' ? '- Requires 10+ years of experience.' : '',
    x.eligibility === 'stretch1' ? '- Requires 6+ years of experience.' : '',
    x.eligibility === 'stretch2' ? '- Requires 7+ years of experience.' : '',
    preferred.length ? '\nNice to have:' : '',
    ...preferred.map((skill) => `- ${skill}`),
  ].filter(Boolean);
  const job = {
    // "II" is how a title states the mid level, one step below senior.
    title: `${level}${x.titleMatch ? 'Data Engineer' : 'Quality Inspector'}${x.seniority === 'down1' ? ' II' : ''}`,
    jdText: lines.join('\n'),
    location: { remote: 'Remote', onsite_ok: 'Austin, TX', onsite_unwanted: 'Austin, TX', unknown: '' }[x.location],
    source: x.directAts ? 'greenhouse' : 'adzuna',
    postedAt: x.ageDays === null ? null : new Date(NOW.getTime() - x.ageDays * 86_400_000).toISOString(),
  };
  const candidate = {
    targetTitles: ['data engineer'],
    technicalStack: { core: SKILLS },
    domainExperience: ['insurance'],
    seniority: 'senior',
    yearsExperience: 5,
    locationPreferences: x.location === 'onsite_ok' ? { remote: true, onsite: true } : { remote: true, onsite: false, hybrid: false },
    workAuthorization: { requiresSponsorship: x.needsSponsorship },
  };
  return { job, candidate, sponsorship: { status: x.sponsorship } };
}

function realVerdict(inputs) {
  const scoring = scoringFromModel();
  const { job, candidate, sponsorship } = realCase(inputs);
  const score = scoreJob(job, { scoring, sponsorship, candidate, now: NOW, freshnessModel: SCORE_MODEL.freshness });
  const { tier } = explainScore(score, scoring, { candidate });
  return { total: score.total, tier, breakdown: score.breakdown };
}

describe('Explore JobAgent: the Score Lab agrees with the real scorer', () => {
  it('restates the scorer’s constants', () => {
    expect(SCORE_MODEL.preferredCredit).toBe(PREFERRED_SKILL_CREDIT);
    expect(SCORE_MODEL.penalties.eligibility).toBe(DEFAULT_ELIGIBILITY_PENALTY);
    expect(SCORE_MODEL.penalties.trackFit).toBe(DEFAULT_TRACK_PENALTY);
    expect(Object.keys(SCORE_MODEL.weights).sort()).toEqual([...STRUCTURAL_WEIGHTS].sort());
    const shipped = JSON.parse(read('config', 'scoring.json'));
    expect(SCORE_MODEL.tiers).toEqual(shipped.tiers);
    for (const key of STRUCTURAL_WEIGHTS) expect(SCORE_MODEL.weights[key], key).toBe(shipped.weights[key]);
    // The lab's weights sum to 100, which is what lets points read as a score.
    const max = SCORE_MODEL.categories.reduce((s, c) => s + c.weight, 0) + Object.values(SCORE_MODEL.weights).reduce((s, w) => s + w, 0);
    expect(max).toBe(100);
    expect(freshnessFactor(0, SCORE_MODEL.freshness)).toBe(1);
    expect(freshnessFactor(7, SCORE_MODEL.freshness)).toBe(0.5);
    expect(freshnessFactor(45, SCORE_MODEL.freshness)).toBe(0);
  });

  const scenarios = [
    ['the default inputs', {}],
    ...PRESETS.map((preset) => [`preset "${preset.name}"`, preset.inputs]),
    ['no skills found at all', { skillsFound: 0, skillsPreferredOnly: 0 }],
    ['every skill found, industry named', { skillsFound: 8, skillsPreferredOnly: 0, domainMatch: true, sponsorship: 'Confirmed' }],
    ['a title that does not match', { titleMatch: false }],
    ['no sponsorship needed, posting silent', { needsSponsorship: false, sponsorship: 'Unconfirmed', skillsFound: 7, skillsPreferredOnly: 0 }],
    ['one step up', { seniority: 'up1' }],
    ['two steps up', { seniority: 'up2' }],
    ['three steps up', { seniority: 'up3' }],
    ['one step below', { seniority: 'down1' }],
    ['two steps below', { seniority: 'down2' }],
    ['level not stated', { seniority: 'unstated' }],
    ['on site and accepted', { location: 'onsite_ok' }],
    ['on site and unwanted', { location: 'onsite_unwanted' }],
    ['location unknown', { location: 'unknown' }],
    ['an aggregator link', { directAts: false }],
    ['posted at the edge of the window', { ageDays: 7 }],
    ['posted three weeks ago', { ageDays: 21 }],
    ['no posting date', { ageDays: null }],
    ['one year short', { eligibility: 'stretch1' }],
    ['two years short', { eligibility: 'stretch2' }],
    ['far short of the stated years', { eligibility: 'ineligible', skillsFound: 8, skillsPreferredOnly: 0, domainMatch: true, sponsorship: 'Confirmed' }],
  ];

  for (const [name, inputs] of scenarios) {
    it(`gives the real total and tier for ${name}`, () => {
      const lab = scoreInputs(inputs);
      const real = realVerdict(inputs);
      expect({ total: lab.total, tier: lab.tier }, JSON.stringify(real.breakdown)).toEqual({ total: real.total, tier: real.tier });
    });
  }

  it('holds a strong score in Queue for the two reasons the scorer does', () => {
    const gated = scoreInputs(PRESETS.find((p) => p.id === 'gated').inputs);
    expect(gated.rawTier).not.toBe('Queue');
    expect([gated.tier, gated.held]).toEqual(['Queue', 'sponsorship']);
    const floor = scoreInputs(PRESETS.find((p) => p.id === 'floor').inputs);
    expect([floor.tier, floor.held]).toEqual(['Queue', 'eligibility']);
    // Pay only ever subtracts.
    expect(scoreInputs({ payShortfall: 0.25 }).raw).toBe(scoreInputs({}).raw - SCORE_MODEL.penalties.payFit);
  });
});
