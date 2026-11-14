/**
 * Type checking only grows (P3-1): the number of src files opted into
 * `// @ts-check` must never fall below the recorded floor, and every opted-in
 * file must be in jsconfig.json, or `npm run typecheck` would skip it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Raise this when more files opt in; never lower it. */
const FLOOR = 19;

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'public' ? [] : jsFiles(p);
    return name.endsWith('.js') ? [p] : [];
  });
}

describe('@ts-check ratchet (P3-1)', () => {
  const checked = jsFiles(join(ROOT, 'src'))
    .filter((p) => readFileSync(p, 'utf8').slice(0, 200).includes('@ts-check'))
    .map((p) => relative(ROOT, p).split(sep).join('/'));

  it(`keeps at least ${FLOOR} type-checked files`, () => {
    expect(checked.length).toBeGreaterThanOrEqual(FLOOR);
  });

  it('includes every opted-in file in jsconfig.json', () => {
    const jsconfig = readFileSync(join(ROOT, 'jsconfig.json'), 'utf8');
    for (const file of checked) {
      const covered = jsconfig.includes(`"${file}"`) || ['src/cli/', 'src/config/'].some((d) => file.startsWith(d)) || file === 'src/index.js';
      expect(covered, `${file} has @ts-check but jsconfig.json does not include it`).toBe(true);
    }
  });
});
