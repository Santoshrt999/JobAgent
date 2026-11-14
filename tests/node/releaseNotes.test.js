import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { changelogMarkdown, releaseForTag, releaseMarkdown } from '../../scripts/releaseNotes.mjs';
import { CHANGELOG } from '../../src/dashboard/public/assets/js/changelog-data.js';

const releases = [
  { version: 'v0.2.0', date: '2026-11-12', summary: 'Two things.', safety: 'Nothing is submitted without your review.',
    groups: { new: ['A brand new screen for things.'], fixed: ['A thing that was broken is fixed.'] } },
  { date: '2026-11-01', summary: 'Older.', groups: { improved: ['Something is now faster than before.'] } },
];

describe('release notes (P1-10)', () => {
  it('renders one release with its groups in order and the safety line', () => {
    const md = releaseMarkdown(releases[0]);
    expect(md).toContain('## v0.2.0 (2026-11-12)');
    expect(md.indexOf('### New')).toBeLessThan(md.indexOf('### Fixes'));
    expect(md).toContain('- A brand new screen for things.');
    expect(md).toContain('_Nothing is submitted without your review._');
    expect(md).not.toContain('### Improvements');
  });

  it('refuses a tag that disagrees with package.json or has no changelog entry', () => {
    expect(releaseForTag('v0.2.0', '0.2.0', releases).release.date).toBe('2026-11-12');
    expect(releaseForTag('refs/tags/v0.2.0', '0.2.0', releases).release).toBeTruthy();
    expect(releaseForTag('v0.2.0', '0.1.0', releases).error).toMatch(/does not match/);
    expect(releaseForTag('v0.3.0', '0.3.0', releases).error).toMatch(/no changelog entry/);
    expect(releaseForTag('latest', '0.2.0', releases).error).toMatch(/not vMAJOR/);
  });

  it('keeps CHANGELOG.md identical to the in-app changelog', () => {
    const onDisk = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(changelogMarkdown(CHANGELOG));
  });

  it('gives every versioned release a unique vMAJOR.MINOR.PATCH, newest highest', () => {
    const versions = CHANGELOG.filter((r) => r.version).map((r) => r.version);
    for (const v of versions) expect(v).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(new Set(versions).size).toBe(versions.length);
    const nums = versions.map((v) => v.slice(1).split('.').map(Number));
    for (let i = 1; i < nums.length; i += 1) {
      const [a, b] = [nums[i - 1], nums[i]];
      expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThan(b[0] * 1e6 + b[1] * 1e3 + b[2]);
    }
  });
});
