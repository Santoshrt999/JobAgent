/**
 * ESLint flat config.
 *
 * Deliberately a SAFETY net, not a style guide: eslint:recommended plus a few
 * rules that catch real bugs (undefined names, sloppy equality). Formatting is
 * not linted, and nothing here should ever justify a mass reformat — several
 * people edit these files at once, and a style sweep would conflict with all
 * of them for no behavioural gain.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**', 'coverage/**', 'reports/**', 'logs/**', 'data/**',
      'applications/output/**', 'resumes/output/**', '.cache/**', '.claude/**', '.agents/**',
      'playwright-report/**', 'test-results/**', 'PyProjects/**',
      // A nested clone of the repository is someone's scratch copy, not source.
      'JobAgent/**', 'JobAgent-public/**',
      // Local, gitignored scratch and browser-session directories.
      '.tmp/**', '.venv/**', 'venv/**', '.browser-profile*/**', '.impeccable/**',
      // Vendored/minified third-party code, if any lands in the public tree.
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        caughtErrors: 'none', ignoreRestSiblings: true,
      }],
      eqeqeq: ['error', 'smart'],
      // `catch { /* ignore */ }` with a comment is this codebase's explicit
      // "best effort" idiom; an empty block WITH a comment is intentional.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Control characters in regexes are used on purpose (stripping ANSI /
      // NULs from scraped text).
      'no-control-regex': 'off',
      // Loops that await per item are intentional (rate limiting, ordering).
      'no-await-in-loop': 'off',
      // New in eslint 10's recommended set. Both flag real-but-harmless
      // patterns across files other people are editing (`let x = null` before
      // a try; rethrowing a friendlier error without `cause`). Reported as
      // warnings to fix opportunistically, never as a reason for a sweep.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      // Irregular whitespace INSIDE a regex is how the text normalizers name
      // the characters they strip; anywhere else it is still an error.
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: false }],
    },
  },
  {
    // Browser code: the dashboard front end and the Chrome/Edge extension.
    files: ['src/dashboard/public/**/*.js', 'extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['src/dashboard/public/**/*.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Code evaluated INSIDE a page by Playwright (page.evaluate callbacks)
    // lives in these modules and legitimately references DOM globals.
    files: ['src/automation/**/*.js', 'src/search/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest, ...globals.browser } },
  },
];
