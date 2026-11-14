/**
 * Per-person files that used to be shared by every workspace (audit BUG-02).
 *
 * The unanswered-question queue named employers and job links, and the
 * "Rank by meaning" result compared one person's resume with their own jobs;
 * both lived in data/ for everyone, so switching person showed the previous
 * person's. They now follow `workspacePaths(root).dataDir`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { questionQueuePath, recordUnansweredQuestions, loadQuestionQueue } from '../../src/apply/questionQueue.js';
import { readRerank } from '../../src/scoring/semanticRerank.js';

describe('per-workspace question queue and rerank result', () => {
  let root;
  const activate = (id, workspace) => {
    writeFileSync(join(root, 'config', 'profiles', `${id}.json`), JSON.stringify({ id, ...(workspace ? { workspace } : {}) }));
    writeFileSync(join(root, 'config', 'profiles', '_active.json'), JSON.stringify({ id }));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-wsiso-'));
    mkdirSync(join(root, 'config', 'profiles'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the original workspace keeps data/question_queue.json', () => {
    activate('first', null);
    expect(questionQueuePath(root)).toBe(join(root, 'data', 'question_queue.json'));
  });

  it('one person\'s unanswered questions never appear for another', () => {
    activate('first', null);
    recordUnansweredQuestions(root, {
      jobId: 'job-a', company: 'Northwind', title: 'Analyst', url: 'https://example.com/a',
      questions: [{ label: 'Do you hold an active TS/SCI clearance?', required: true }],
    });
    expect(loadQuestionQueue(root).questions.length).toBe(1);

    activate('second', 'second');
    expect(questionQueuePath(root)).toBe(join(root, 'data', 'profiles', 'second', 'question_queue.json'));
    expect(loadQuestionQueue(root).questions).toEqual([]);

    activate('first', null);
    expect(loadQuestionQueue(root).questions.length).toBe(1);
  });

  it('the rerank result is read from the active person\'s workspace only', () => {
    activate('first', null);
    writeFileSync(join(root, 'data', 'semantic-rerank.json'), JSON.stringify({ jobs: [{ id: 'x' }] }));
    expect(readRerank(root)?.jobs?.length).toBe(1);
    activate('second', 'second');
    expect(readRerank(root)).toBeNull();
    expect(existsSync(join(root, 'data', 'profiles', 'second', 'semantic-rerank.json'))).toBe(false);
  });
});
