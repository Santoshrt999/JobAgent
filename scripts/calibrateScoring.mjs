#!/usr/bin/env node
/**
 * Propose scoring-weight changes from your recorded outcomes (P2-10).
 *
 *   npm run scoring:calibrate             writes reports/scoring-proposal-<date>.json, changes nothing
 *   npm run scoring:calibrate -- --apply  also writes the proposed weights to config/scoring.json
 *
 * Refuses until there are enough outcomes to say anything (see
 * src/scoring/calibration.js). Applying changes the scoring fingerprint, so
 * the dashboard re-scores every job on its next start.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, PROJECT_ROOT } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';
import { calibrate } from '../src/scoring/calibration.js';
import { buildSamples } from '../src/scoring/calibrationData.js';
import { writeFileAtomic } from '../src/utils/fsSafe.js';

const apply = process.argv.includes('--apply');
const config = loadConfig();
const db = openDatabase({});
try {
  const samples = buildSamples(db, config);
  const result = calibrate(samples, config.scoring.weights);
  const day = new Date().toISOString().slice(0, 10);
  const report = { createdAt: new Date().toISOString(), current: config.scoring.weights, ...result };
  mkdirSync(join(PROJECT_ROOT, 'reports'), { recursive: true });
  const reportPath = join(PROJECT_ROOT, 'reports', `scoring-proposal-${day}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Outcomes: ${result.counts.outcomes} (${result.counts.interviewed} reached an interview, ${result.counts.notInterviewed} did not).`);
  if (!result.ok) {
    console.log(`No proposal yet: ${result.reason}. Report: ${reportPath}`);
    process.exit(0);
  }
  for (const c of result.categories) {
    const from = config.scoring.weights[c.category];
    const to = result.proposed[c.category];
    console.log(`  ${c.category.padEnd(30)} ${String(from).padStart(3)} -> ${String(to).padStart(3)}  ${c.clear ? `difference ${c.difference}` : 'no clear difference'}`);
  }
  console.log(`Report: ${reportPath}`);
  if (apply) {
    const path = join(PROJECT_ROOT, 'config', 'scoring.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    doc.weights = { ...doc.weights, ...result.proposed };
    writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    console.log('Applied to config/scoring.json. Jobs are re-scored on the next start.');
  } else {
    console.log('Nothing changed. Run again with --apply to use these weights.');
  }
} finally {
  db.close();
}
