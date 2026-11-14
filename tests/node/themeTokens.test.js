/**
 * The light palette is written twice and must stay one palette.
 *
 * It appears under `:root[data-theme="light"]` (the user picked light) and again
 * under `@media (prefers-color-scheme: light) :root:not([data-theme="dark"])`
 * (the OS asked for light and the user has not overridden it). CSS cannot union
 * a plain selector with a media-conditioned one, so the block is duplicated —
 * and a duplicated palette drifts the moment someone tunes one colour.
 *
 * Drift here is not cosmetic: `--text-faint` carries the table headers and the
 * line explaining WHY a job is blocked, and it was already once below the 4.5:1
 * contrast AA requires. A half-updated palette would put that failure back for
 * exactly the users who never touched the theme toggle.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../../src/dashboard/public/assets/css/app.css', import.meta.url)),
  'utf8',
);

/** Parse `--name: value;` pairs out of the rule that starts at `selector`. */
function tokensAfter(selector) {
  const at = css.indexOf(selector);
  expect(at, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

describe('light theme palette', () => {
  const explicit = tokensAfter(':root[data-theme="light"] {');
  const system = tokensAfter(':root:not([data-theme="dark"]) {');

  it('defines a non-trivial number of tokens in both places', () => {
    expect(Object.keys(explicit).length).toBeGreaterThan(15);
    expect(Object.keys(system).length).toBe(Object.keys(explicit).length);
  });

  it('has identical values in the explicit and system-preference blocks', () => {
    expect(system).toEqual(explicit);
  });

  it('still carries the contrast-critical text tokens', () => {
    // Raised from #7d8899 (3.59:1 on white) after measuring it as an AA failure,
    // then from #68717f (4.43:1 on --surface-2, found by the axe suite) to a
    // value that is AA on every light surface.
    expect(explicit['--text-faint']).toBe('#5f6875');
    expect(system['--text-faint']).toBe('#5f6875');
  });
});

describe('theme selection', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/public/index.html', import.meta.url)),
    'utf8',
  );

  it('does not hardcode a theme on <html>', () => {
    // A hardcoded data-theme wins over prefers-color-scheme, which is how a
    // light-mode machine was served the dark palette until the user found the
    // toggle. The attribute is set by the toggle only.
    expect(html).toMatch(/<html lang="en">/);
    expect(html).not.toMatch(/<html[^>]*data-theme=/);
  });
});
