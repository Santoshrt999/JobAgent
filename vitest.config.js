import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.js'],
    environment: 'node',
    // Builds a throwaway workspace (shared config + the fictional fixture
    // profile + the synthetic example resume) and points JOB_AGENT_ROOT at it,
    // so no test reads the developer's real candidate.json / master resume or
    // writes to their real data/applied_jobs.db — and a clean clone, which has
    // none of those gitignored files, runs exactly the same suite.
    globalSetup: ['tests/node/globalSetup.js'],
    // `npm run test:coverage` (CI runs it on one matrix cell). Thresholds are
    // the measured baseline (2026-11-10: statements 85.98, branches 77.36,
    // functions 90.35, lines 89.00) rounded down, minus one point. Raise them
    // as coverage grows; never lower them to make a change pass.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // Front-end modules run in the browser; they are covered by the
      // real-browser tests, which v8 coverage in Node cannot see.
      exclude: ['src/dashboard/public/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { statements: 84, branches: 76, functions: 89, lines: 88 },
    },
  },
});
