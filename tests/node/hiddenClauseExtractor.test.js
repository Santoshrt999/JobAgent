/**
 * Conditions buried in a description, surfaced with their quotes (Backlog #15).
 * Postings here are fictional.
 */
import { describe, it, expect } from 'vitest';
import { extractHiddenClauses } from '../../src/scoring/hiddenClauses.js';

const kinds = (text) => extractHiddenClauses(text).map((c) => c.kind);
const labelOf = (text, kind) => extractHiddenClauses(text).find((c) => c.kind === kind)?.label;

describe('extractHiddenClauses', () => {
  it('finds an onsite ramp-up buried under a hybrid location, with its sentence', () => {
    const jd = 'Location: Hybrid (Atlanta, GA).\n\nAbout the team. We build data platforms.\n'
      + 'For the first 90 days you will be 100% onsite, Monday through Friday, to ramp up with the team. After that, hybrid.';
    const [clause] = extractHiddenClauses(jd);
    expect(clause.kind).toBe('onsite_ramp');
    expect(clause.label).toBe('Onsite for the first 90 days');
    expect(clause.quote).toMatch(/^For the first 90 days you will be 100% onsite/);
    // A ramp-up is not a fully onsite job.
    expect(kinds(jd)).not.toContain('onsite_full');
    expect(kinds('This role is 100% onsite in Austin.')).toContain('onsite_full');
  });

  it('reads travel, on-call, W2-only, clearance, contract, relocation and deadlines', () => {
    expect(labelOf('This role requires travel up to 50% to client sites.', 'travel')).toBe('Travel up to 50%');
    expect(labelOf('Expect up to 25% travel.', 'travel')).toBe('Travel up to 25%');
    expect(kinds('You will join a weekly on-call rotation.')).toContain('on_call');
    expect(kinds('W2 only. No C2C.')).toContain('w2_only');
    expect(kinds('Must hold an active TS/SCI clearance.')).toContain('clearance');
    expect(labelOf('This is a 12-month contract with possible extension.', 'contract')).toBe('Contract, 12 months');
    expect(kinds('Candidates must relocate to Denver.')).toContain('relocation');
    expect(labelOf('Applications close November 30, 2026.', 'deadline')).toBe('Applications close November 30, 2026');
  });

  it('does not report a clause the posting rules out, or one it never states', () => {
    expect(kinds('There is no on-call rotation for this role.')).not.toContain('on_call');
    expect(kinds('You will not be required to relocate.')).not.toContain('relocation');
    expect(kinds('We value travel, onsite culture and contracts law expertise.')).toEqual([]);
    expect(extractHiddenClauses('')).toEqual([]);
    expect(extractHiddenClauses(null)).toEqual([]);
  });

  it('keeps one clause per kind, hardest first, with bounded quotes', () => {
    const jd = `Must hold an active Secret clearance. ${'Lorem ipsum dolor sit amet. '.repeat(3)}On-call rotation one week in six. On-call weekends too.`;
    const out = extractHiddenClauses(jd);
    expect(out.map((c) => c.kind)).toEqual(['clearance', 'on_call']);
    for (const c of extractHiddenClauses(`On-call ${'x'.repeat(500)}.`)) expect(c.quote.length).toBeLessThanOrEqual(220);
  });
});
