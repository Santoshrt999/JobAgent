/**
 * The Score Lab: move one input, watch the score, the tier and the holds
 * change. The arithmetic lives in score-model.js, which a test keeps in step
 * with the real scorer.
 */
import { h, nextId } from './dom.js';
import { tierRuler } from './journey.js';
import { DEFAULT_INPUTS, PRESETS, SCORE_MODEL, normalizeInputs, scoreInputs } from './score-model.js';

function slug(text) {
  return String(text).toLowerCase().replace(/\s+/g, '-');
}

function points(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '');
}

export function buildScoreLab() {
  let inputs = normalizeInputs(DEFAULT_INPUTS);
  const controls = [];
  const out = h('div', { class: 'ex-lab-out', 'aria-live': 'polite' });

  function set(patch) {
    inputs = normalizeInputs({ ...inputs, ...patch });
    for (const sync of controls) sync();
    paint();
  }

  /* ── controls ── */

  function toggle(key, label) {
    const id = nextId('lab');
    const input = h('input', { type: 'checkbox', id, onChange: () => set({ [key]: input.checked }) });
    controls.push(() => { input.checked = Boolean(inputs[key]); });
    return h('div', { class: 'ex-ctl ex-ctl-toggle' }, input, h('label', { for: id, text: label }));
  }

  function range(key, label, { min, max, format, maxFrom = null }) {
    const id = nextId('lab');
    const value = h('output', { for: id, class: 'ex-ctl-value' });
    const input = h('input', { type: 'range', id, min: String(min), max: String(max), step: '1', onInput: () => set({ [key]: Number(input.value) }) });
    controls.push(() => {
      const top = maxFrom ? Math.max(0, inputs[maxFrom]) : max;
      input.max = String(top);
      input.disabled = top === 0 || (key === 'ageDays' && inputs.ageDays === null);
      input.value = String(inputs[key] ?? 0);
      value.textContent = format(inputs[key]);
    });
    return h('div', { class: 'ex-ctl ex-ctl-range' }, h('label', { for: id, text: label }), value, input);
  }

  function choice(key, label, options, { enabledWhen = null } = {}) {
    const id = nextId('lab');
    const select = h('select', { id, onChange: () => set({ [key]: coerce(select.value) }) },
      options.map(([value, text]) => h('option', { value: String(value), text })));
    controls.push(() => {
      select.value = String(inputs[key]);
      select.disabled = enabledWhen ? !enabledWhen() : false;
    });
    return h('div', { class: 'ex-ctl ex-ctl-select' }, h('label', { for: id, text: label }), select);
  }

  const coerce = (value) => (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);

  const dateUnknownId = nextId('lab');
  const dateUnknown = h('input', {
    type: 'checkbox', id: dateUnknownId,
    onChange: () => set({ ageDays: dateUnknown.checked ? null : 2 }),
  });
  controls.push(() => { dateUnknown.checked = inputs.ageDays === null; });

  const group = (title, ...children) => h('fieldset', { class: 'ex-lab-group' }, h('legend', { text: title }), children);

  const form = h('form', { class: 'ex-lab-form', 'aria-label': 'Score inputs', onSubmit: (event) => event.preventDefault() },
    group('The posting and your profile',
      toggle('titleMatch', 'The title contains one of your target titles'),
      range('skillsFound', 'Your skills found in the posting', { min: 0, max: SCORE_MODEL.profileSkills, format: (v) => `${v} of ${SCORE_MODEL.profileSkills}` }),
      range('skillsPreferredOnly', 'Of those, named only under “nice to have”', { min: 0, max: SCORE_MODEL.profileSkills, maxFrom: 'skillsFound', format: (v) => String(v) }),
      toggle('domainMatch', 'It names an industry you have worked in'),
      choice('seniority', 'Level, compared with yours', [
        ['match', 'Same level'], ['up1', 'One step up'], ['up2', 'Two steps up'], ['up3', 'Three or more up'],
        ['down1', 'One step below'], ['down2', 'Two or more below'], ['unstated', 'Not stated'],
      ])),
    group('Sponsorship',
      toggle('needsSponsorship', 'You need visa sponsorship'),
      choice('sponsorship', 'The posting reads as', [
        ['Confirmed', 'Confirmed: it says it sponsors'], ['Likely', 'Likely: a known sponsor'], ['Unconfirmed', 'Unconfirmed: it says nothing'],
      ], { enabledWhen: () => inputs.needsSponsorship })),
    group('Logistics',
      choice('location', 'Location', [
        ['remote', 'Remote, and you accept remote'], ['onsite_ok', 'On site or hybrid, which you accept'],
        ['onsite_unwanted', 'On site, and you want remote'], ['unknown', 'Not stated'],
      ]),
      range('ageDays', 'Posted', { min: 0, max: 45, format: (v) => (v === null ? 'Date unknown' : `${v} day${v === 1 ? '' : 's'} ago`) }),
      h('div', { class: 'ex-ctl ex-ctl-toggle' }, dateUnknown, h('label', { for: dateUnknownId, text: 'The posting has no readable date' })),
      toggle('directAts', 'The link goes straight to the employer’s application')),
    group('Penalties',
      choice('eligibility', 'A stated requirement', [
        ['none', 'None you fall short of'], ['stretch1', 'One year short on experience'],
        ['stretch2', 'Two years short on experience'], ['ineligible', 'Not met: years, degree, licence or clearance'],
      ]),
      choice('payShortfall', 'Posted pay, against your target', [
        ['0', 'Meets it, or no pay is posted'], ['0.1', '10% below'], ['0.25', '25% or more below'],
      ])));

  const presets = h('div', { class: 'ex-lab-presets', role: 'group', 'aria-label': 'Starting points' },
    PRESETS.map((preset) => h('button', {
      type: 'button', class: 'ex-chip ex-chip-sm', onClick: () => set({ ...DEFAULT_INPUTS, ...preset.inputs }),
    }, preset.name)));

  /* ── readout ── */

  function paint() {
    const result = scoreInputs(inputs);
    const rows = [...result.rows, ...result.penalties];
    out.replaceChildren(
      h('div', { class: 'ex-verdict' },
        h('span', { class: 'ex-verdict-score', text: String(result.total) }),
        h('span', { class: 'ex-verdict-of', text: 'out of 100' }),
        h('span', { class: `ex-tier ex-tier-${slug(result.tier)}`, text: result.tier })),
      result.held
        ? h('p', { class: 'ex-lab-held' }, h('strong', { text: `Scored as ${result.rawTier}, held in Queue. ` }), result.heldReason)
        : h('p', { class: 'ex-lab-held is-clear', text: verdictLine(result.tier) }),
      tierRuler(result.total),
      h('table', { class: 'ex-lab-table' },
        h('caption', { class: 'sr-only', text: 'Points by category' }),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Category' }), h('th', { scope: 'col', class: 'ex-num', text: 'Points' }), h('th', { scope: 'col', text: 'Why' }))),
        h('tbody', {}, rows.map((row) => h('tr', { class: row.points < 0 ? 'is-penalty' : null },
          h('th', { scope: 'row', text: row.label }),
          h('td', { class: 'ex-num', text: row.weight ? `${points(row.points)} / ${row.weight}` : points(row.points) }),
          h('td', { class: 'ex-lab-why', text: row.reason })))),
        h('tfoot', {}, h('tr', {},
          h('th', { scope: 'row', text: 'Total' }),
          h('td', { class: 'ex-num', text: `${points(result.raw)} / ${result.max}` }),
          h('td', { class: 'ex-lab-why', text: `Rounded to ${result.total}.` })))));
  }

  function verdictLine(tier) {
    const t = SCORE_MODEL.tiers;
    if (tier === 'Priority') return `${t.priority} or more. “Find jobs and prepare packets” builds its packet.`;
    if (tier === 'Apply') return `${t.apply} to ${t.priority - 1}. “Find jobs and prepare packets” builds its packet.`;
    if (tier === 'Queue') return `${t.queue} to ${t.apply - 1}. On your board; prepared only when you select it.`;
    if (tier === 'Near miss') return `${t.nearMiss} to ${t.queue - 1}. Kept visible, below the queue.`;
    return `Below ${t.nearMiss}. Recorded as discarded, with this breakdown kept.`;
  }

  for (const sync of controls) sync();
  paint();

  return h('div', { class: 'ex-lab' },
    h('div', { class: 'ex-lab-in' }, presets, form),
    out);
}
