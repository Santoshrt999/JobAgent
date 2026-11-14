/**
 * What kind of question a queued form question is (2026-11-13).
 *
 * Found on a real queue: six of sixteen "questions" were control names or
 * generated field ids, and employer-specific questions ("Have you ever been
 * employed by this company?") were offered as answers to save for every
 * application, which would type the same "No" onto an employer where it is
 * untrue. Employers here are fictional.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { questionKind, recordUnansweredQuestions, summarizeQuestionQueue } from '../../src/apply/questionQueue.js';

const NORTHWIND = { companies: ['Northwind Logistics Group LLC'] };

describe('questionKind', () => {
  it('drops labels that are not questions', () => {
    for (const label of ['Search', 'Select...', 'textbox', 'Display language', 'z0v_CCXsxi', 'Ypq12xwvl4', '--', 'ab']) {
      expect(questionKind(label), label).toBe('noise');
    }
  });

  it('keeps employer-specific questions out of "answer once"', () => {
    for (const label of [
      'Have you ever been employed by this company before?',
      'Were you referred to this role by a current employee?',
      'Why do you feel you are a good fit for this role?',
      'This position is a 5-day per week onsite role. Are you able to work onsite at the office each day?',
    ]) expect(questionKind(label), label).toBe('employer');
    expect(questionKind('Have you worked with Northwind before?', NORTHWIND)).toBe('employer');
  });

  it('groups self-identification and leaves everything else answerable once', () => {
    for (const label of ['Gender', 'Please identify your race', 'Are you Hispanic/Latino?', 'Veteran Status', 'Disability status']) {
      expect(questionKind(label), label).toBe('voluntary');
    }
    for (const label of [
      'Are you legally authorized to work in the United States for this position?',
      'How did you hear about us?', 'How many years of Python experience do you have?', 'LinkedIn', 'Desired salary',
      // Relocation is the person's own preference, stated in the profile.
      'Are you willing to relocate for this position?', 'relocate for this role',
    ]) expect(questionKind(label), label).toBe('general');
  });
});

describe('the queue', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-qkinds-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('never records noise, and counts only what can be answered once', () => {
    recordUnansweredQuestions(root, {
      jobId: 'j1', company: 'Northwind Logistics Group LLC', title: 'Data Engineer', now: new Date(),
      questions: [
        { label: 'Search', required: true },
        { label: 'z0v_CCXsxi', required: true },
        { label: 'Have you ever been employed by this company before?', required: true },
        { label: 'Gender', required: false },
        { label: 'Are you 18 or older?', required: true },
      ],
    });
    const s = summarizeQuestionQueue(root);
    expect(s.open.map((q) => [q.label, q.kind])).toEqual([
      ['Have you ever been employed by this company before?', 'employer'],
      ['Are you 18 or older?', 'general'],
      ['Gender', 'voluntary'],
    ]);
    expect(s.openCount).toBe(2);
    expect(s.requiredCount).toBe(1);
    expect(s.employerCount).toBe(1);
  });
});
