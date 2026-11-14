/**
 * Master vs tailored resume: every difference is named, and anything missing
 * that the tailor did not declare is flagged rather than hidden.
 */
import { describe, it, expect } from 'vitest';
import { diffResume, hasImpact } from '../../src/resume/resumeDiff.js';

const MASTER = [
  'Jordan Lee',
  'SKILLS',
  'Cloud: Azure, AWS, GCP, Databricks',
  'PROFESSIONAL EXPERIENCE',
  'Senior Engineer | Contoso | Jan 2022 - Present',
  'Built SQL pipelines for finance.',
  'Cut close time from 5 days to 2 for 200+ analysts.',
  'Maintained the team wiki.',
  'Engineer | Fabrikam | 2018 - 2021',
  'Wrote Python ETL jobs.',
];

describe('diffResume', () => {
  it('reports an identical resume as unchanged', () => {
    const r = diffResume({ master: MASTER, tailored: MASTER });
    expect(r.summary).toMatchObject({ same: MASTER.length, moved: 0, omitted: 0, added: 0, flagged: 0 });
  });

  it('names moved bullets, reordered skill lists, declared omissions and added lines', () => {
    const tailored = [
      'Jordan Lee',
      'Most relevant to this role: SQL, Python',
      'SKILLS',
      'Cloud: Databricks, Azure, AWS, GCP',
      'PROFESSIONAL EXPERIENCE',
      'Senior Engineer | Contoso | Jan 2022 - Present',
      'Cut close time from 5 days to 2 for 200+ analysts.',
      'Built SQL pipelines for finance.',
      'Engineer | Fabrikam | 2018 - 2021',
      'Wrote Python ETL jobs.',
    ];
    const r = diffResume({
      master: MASTER, tailored,
      omitted: [{ text: 'Maintained the team wiki.', role: 'Senior Engineer | Contoso', reason: 'matches no requirement', jd_terms: [] }],
    });
    const by = Object.fromEntries(r.rows.map((row) => [row.text, row]));
    expect(by['Cloud: Databricks, Azure, AWS, GCP'].status).toBe('reordered');
    expect(r.summary.moved).toBe(1);
    expect(by['Maintained the team wiki.'].status).toBe('omitted');
    expect(by['Maintained the team wiki.'].flags).toEqual([]); // declared, unmeasured, unmatched
    expect(by['Most relevant to this role: SQL, Python'].flags).toEqual(['focus line']);
    expect(r.flagged).toHaveLength(0);
  });

  it('flags a left-out measured result and anything missing without a reason', () => {
    const tailored = MASTER.filter((l) => !l.startsWith('Cut close') && l !== 'Wrote Python ETL jobs.');
    const r = diffResume({
      master: MASTER, tailored,
      omitted: [{ text: 'Cut close time from 5 days to 2 for 200+ analysts.', reason: 'x', jd_terms: [] }],
    });
    const measured = r.rows.find((row) => row.text.startsWith('Cut close'));
    expect(measured.flags).toContain('measured result');
    const undeclared = r.rows.find((row) => row.text === 'Wrote Python ETL jobs.');
    expect(undeclared.flags).toContain('not declared by the tailor');
    expect(r.flagged).toHaveLength(2);
  });

  it('pairs an accepted rewrite as reworded, not as a loss plus an addition', () => {
    const tailored = MASTER.map((l) => (l === 'Wrote Python ETL jobs.' ? 'Wrote Python ETL jobs for the finance warehouse.' : l));
    const r = diffResume({ master: MASTER, tailored, rewrites: [{ before: 'Wrote Python ETL jobs.', after: 'Wrote Python ETL jobs for the finance warehouse.' }] });
    const row = r.rows.find((x) => x.status === 'reworded');
    expect(row.before).toBe('Wrote Python ETL jobs.');
    expect(r.summary.omitted).toBe(0);
    expect(r.summary.added).toBe(0);
  });

  it('marks pinned omissions as kept and tracks sections', () => {
    const tailored = MASTER.filter((l) => l !== 'Maintained the team wiki.');
    const r = diffResume({ master: MASTER, tailored, keep: ['Maintained the team wiki.'] });
    const row = r.rows.find((x) => x.status === 'omitted');
    expect(row.kept).toBe(true);
    expect(row.section).toBe('PROFESSIONAL EXPERIENCE');
  });
});

describe('hasImpact', () => {
  it('matches the Python tailor on what counts as a measured result', () => {
    expect(hasImpact('Saved $1.2M')).toBe(true);
    expect(hasImpact('Improved speed by 40%')).toBe(true);
    expect(hasImpact('Joined in 2019')).toBe(false);
    expect(hasImpact('Maintained documentation')).toBe(false);
  });
});
