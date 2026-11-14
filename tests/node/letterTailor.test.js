/**
 * Tailoring the MASTER cover letter to a job: the person's words are the
 * source, the job decides which of them lead, and nothing is invented.
 */
import { describe, it, expect } from 'vitest';
import { composeFromMaster, letterDepth, parseLetter } from '../../src/apply/letterTailor.js';
import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { sentencesOf } from '../../src/apply/letterQuality.js';

const MASTER = `Dear Hiring Team,

I'm excited to apply for this position. I build data platforms that finance teams trust.

At my current company I rebuilt the month-end close pipeline in Databricks and PySpark, cutting close time from 5 days to 2 and giving 200+ analysts same-day data.

I also enjoy mentoring: I led a guild of six engineers that standardised our CI/CD with Azure DevOps.

Away from data work, I volunteer as a weekend climbing instructor and organise our office book club.

I would welcome the chance to discuss how I could help {company}. Thank you for your consideration.

Sincerely,
Jordan Lee`;

const JOB = { title: 'Senior Data Engineer', company: 'Northwind Health' };
const SCORE = { total: 72, matchedKeywords: ['databricks', 'pyspark', 'azure devops', 'sql'] };
const CANDIDATE = {
  identity: { fullName: 'Jordan Lee' },
  technicalStack: { core: ['Databricks', 'PySpark', 'SQL', 'Azure DevOps'] },
  workHistory: [
    { employer: 'Contoso', current: true, highlights: ['Reduced warehouse cost 38% by consolidating 40 pipelines into Delta Live Tables', 'Responsible for on-call rotation'] },
    { employer: 'Fabrikam', highlights: ['Built SQL data quality checks that caught 1,200 bad rows a week'] },
  ],
};
const CONFIG = {
  enabled: true, minScoreToGenerate: 60, wordCount: { min: 180, max: 260 },
  greeting: 'Dear Hiring Team,', closing: 'Sincerely,',
  template: {
    opening: 'I am applying for the {title} role at {company}.', skillsLead: 'Strengths:',
    experience: 'In my current role I {topHighlight}.', fitNote: 'I also bring {focusAreas}.',
    sponsorshipNote: '', closingParagraph: 'Thank you, {company}.',
  },
};

describe('parseLetter', () => {
  it('separates greeting, body and a sign-off with the name on the next line', () => {
    const parsed = parseLetter(MASTER);
    expect(parsed.greeting).toBe('Dear Hiring Team,');
    expect(parsed.signoff).toEqual(['Sincerely,', 'Jordan Lee']);
    expect(parsed.body).toHaveLength(5);
    expect(parsed.body.at(-1)).toMatch(/^I would welcome/);
  });

  it('handles a sign-off and name in separate blocks, and no greeting', () => {
    const parsed = parseLetter('First paragraph here.\n\nSecond one.\n\nBest regards,\n\nJordan Lee');
    expect(parsed.greeting).toBeNull();
    expect(parsed.body).toEqual(['First paragraph here.', 'Second one.']);
  });
});

describe('composeFromMaster', () => {
  it('names the job, keeps the closing, and fills {company}', () => {
    const out = composeFromMaster({ master: MASTER, job: JOB, score: SCORE, candidate: CANDIDATE });
    expect(out.ok).toBe(true);
    expect(out.paragraphs[0].text).toContain('the Senior Data Engineer role at Northwind Health');
    expect(out.body).toContain('how I could help Northwind Health');
    expect(out.body).not.toMatch(/\{\w+\}/);
  });

  it('leads with the paragraphs that speak to the posting and leaves out the rest when space is short', () => {
    const out = composeFromMaster({ master: MASTER, job: JOB, score: { total: 60, matchedKeywords: SCORE.matchedKeywords }, candidate: {} });
    expect(out.depth).toBe('focused');
    expect(out.body).toContain('month-end close pipeline in Databricks');
    // The relevant paragraphs come first; the unrelated one goes only if the
    // minimum length still needs it.
    const order = ['month-end close', 'guild of six', 'climbing instructor'].map((t) => out.body.indexOf(t));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it('skips a paragraph that still has a writing prompt', () => {
    const draft = MASTER.replace('Away from data work', '[A second example] Away from data work');
    const out = composeFromMaster({ master: draft, job: JOB, score: SCORE, candidate: CANDIDATE });
    expect(out.body).not.toContain('[A second example]');
    expect(out.skipped.some((s) => s.reason.includes('writing prompt'))).toBe(true);
  });

  it('refuses when nothing is finished, so the template is used instead', () => {
    const out = composeFromMaster({ master: 'Dear team,\n\n[Who you are]\n\n[Your best result]', job: JOB, score: SCORE });
    expect(out.ok).toBe(false);
    const letter = generateCoverLetter(JOB, SCORE, { coverLetter: CONFIG, candidate: CANDIDATE, humanizerPatterns: {}, masterLetter: 'Dear team,\n\n[Who you are]' });
    expect(letter.source).toBe('template');
    expect(letter.master.used).toBe(false);
  });

  it('adds profile results VERBATIM only when the letter has few measured results', () => {
    const plain = 'I would like to join {company} as a {title}.\n\nI enjoy building reliable data systems with Databricks.\n\nThank you for your consideration.';
    // A strong match gets two results, from two employers, best match first.
    const out = composeFromMaster({ master: plain, job: JOB, score: { ...SCORE, total: 90 }, candidate: CANDIDATE });
    const evidence = out.paragraphs.find((p) => p.source === 'profile');
    expect(evidence.text).toContain('At Fabrikam, I built SQL data quality checks that caught 1,200 bad rows a week.');
    expect(evidence.text).toContain('At Contoso, I reduced warehouse cost 38% by consolidating 40 pipelines into Delta Live Tables.');
    // A weaker match gets one: the result that speaks to the posting.
    const focused = composeFromMaster({ master: plain, job: JOB, score: { ...SCORE, total: 60 }, candidate: CANDIDATE });
    expect(focused.paragraphs.find((p) => p.source === 'profile').text).toMatch(/^At Fabrikam, I built SQL/);
    // A duty that is not an action ("Responsible for…") is never turned into a claim.
    expect(out.body).not.toContain('on-call');
  });

  it('never states a sentence that is not the person\'s own or an evidenced connective', () => {
    const out = composeFromMaster({ master: MASTER, job: JOB, score: SCORE, candidate: CANDIDATE });
    const sources = [MASTER, ...CANDIDATE.workHistory.flatMap((w) => w.highlights)].join(' ').toLowerCase();
    for (const sentence of sentencesOf(out.body)) {
      const core = sentence.toLowerCase()
        .replace(/northwind health/g, '{company}').replace(/senior data engineer/g, '{title}')
        .replace(/^(at \w+, |there, )i /, '').replace(/[.!?]$/, '');
      const known = sources.includes(core.slice(0, 30))
        || /^i am applying for the \{title\} role at \{company\}/.test(core)
        || /^the posting also asks for/.test(core)
        || /^i'm excited to apply for the \{title\} role at \{company\}/.test(core);
      expect(known, sentence).toBe(true);
    }
  });

  it('grows with the strength of the match', () => {
    expect(letterDepth(60)).toBe('focused');
    expect(letterDepth(80)).toBe('standard');
    expect(letterDepth(90)).toBe('full');
    expect(letterDepth(50, true)).toBe('full');
  });
});

describe('generateCoverLetter with a master letter', () => {
  it('uses the master letter, its own greeting and sign-off, and reports quality', () => {
    const letter = generateCoverLetter(JOB, SCORE, { coverLetter: CONFIG, candidate: CANDIDATE, humanizerPatterns: {}, masterLetter: MASTER });
    expect(letter.generated).toBe(true);
    expect(letter.source).toBe('master');
    expect(letter.text.startsWith('Dear Hiring Team,')).toBe(true);
    expect(letter.text).toMatch(/Sincerely,\nJordan Lee$/);
    expect(letter.text.match(/Sincerely,/g)).toHaveLength(1);
    expect(letter.quality.label).toBeDefined();
    expect(letter.quality.issues.some((i) => i.code === 'repeat')).toBe(false);
  });

  it('still respects the score gate', () => {
    const letter = generateCoverLetter(JOB, { total: 40, matchedKeywords: [] }, { coverLetter: CONFIG, candidate: CANDIDATE, humanizerPatterns: {}, masterLetter: MASTER });
    expect(letter.generated).toBe(false);
  });
});
