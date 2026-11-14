/**
 * The cover-letter quality read: what makes a hiring manager stop reading.
 */
import { describe, it, expect } from 'vitest';
import { assessLetter, countWords } from '../../src/apply/letterQuality.js';

const para = (n, seed) => Array.from({ length: n }, (_, i) => `${seed} sentence ${i} covers a different concrete result.`).join(' ');

describe('assessLetter', () => {
  it('reads a thin letter as thin', () => {
    const q = assessLetter('Dear Hiring Team,\n\nI am applying for the role at Northwind.\n\nSincerely,\nJordan Lee', { company: 'Northwind' });
    expect(q.issues.map((i) => i.code)).toContain('short');
    expect(q.label).not.toBe('Strong');
  });

  it('flags an overlong letter', () => {
    const text = [para(20, 'Opening'), para(20, 'Middle'), para(20, 'Later'), para(12, 'Closing Northwind')].join('\n\n');
    expect(assessLetter(text, { company: 'Northwind' }).issues.map((i) => i.code)).toContain('long');
  });

  it('catches a repeated sentence and stock phrases', () => {
    const text = 'I am a team player who loves data.\n\nI rebuilt the close process at Contoso.\n\nI am a team player who loves data.';
    const codes = assessLetter(text).issues.map((i) => i.code);
    expect(codes).toContain('repeat');
    expect(codes).toContain('stock');
  });

  it('blocks a letter that still has a writing prompt or a placeholder', () => {
    expect(assessLetter('Dear team,\n\n[Your strongest result]\n\nThanks').label).toBe('Unfinished');
    expect(assessLetter('I want to join {company} as soon as possible.').issues.some((i) => i.code === 'token' && i.level === 'block')).toBe(true);
  });

  it('expects {company} in a master letter, and the real name in a job letter', () => {
    const master = assessLetter('I would like to help {company} grow its analytics practice.', { master: true });
    expect(master.issues.some((i) => i.code === 'token')).toBe(false);
    const job = assessLetter('I would like to help your team grow its analytics practice.', { company: 'Northwind' });
    expect(job.issues.map((i) => i.code)).toContain('no-company');
  });

  it('does not count the greeting or sign-off as body', () => {
    const q = assessLetter('Dear Hiring Team,\n\nOne two three four five.\n\nSincerely,\nJordan Lee');
    expect(q.words).toBe(countWords('One two three four five.'));
    expect(q.paragraphs).toBe(1);
  });
});
