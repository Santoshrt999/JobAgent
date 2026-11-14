import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadLiveVerifiedAts, verifiedAtsFrom } from '../../src/apply/liveVerification.js';

describe('live ATS verification record (P1-11)', () => {
  it('counts only complete entries', () => {
    const set = verifiedAtsFrom({ verified: [
      { ats: 'Greenhouse', date: '2026-11-20', outcome: 'filled; submitted by hand; confirmation recognised' },
      { ats: 'lever', date: 'soon', outcome: 'x' },
      { ats: 'ashby', date: '2026-11-21' },
      { date: '2026-11-21', outcome: 'x' },
    ] });
    expect([...set]).toEqual(['greenhouse']);
  });

  it('treats a missing or broken file as nothing verified', () => {
    const root = mkdtempSync(join(tmpdir(), 'live-'));
    try {
      expect(loadLiveVerifiedAts(root).size).toBe(0);
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'verified_live_ats.json'), '{ not json');
      expect(loadLiveVerifiedAts(root).size).toBe(0);
      expect(loadLiveVerifiedAts(null).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships with an empty list, so Auto-submit is refused everywhere out of the box', () => {
    const shipped = JSON.parse(readFileSync(new URL('../../config/verified_live_ats.json', import.meta.url), 'utf8'));
    expect(shipped.verified).toEqual([]);
  });
});
