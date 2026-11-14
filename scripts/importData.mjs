#!/usr/bin/env node
/**
 * Import a JobAgent export (P1-6). Shows what would change; add --apply to do it.
 *
 *   npm run import -- exports/jobagent-2026-11-11.jobagent
 *   npm run import -- exports/jobagent-2026-11-11.jobagent --apply
 *   npm run import -- me.jobagent --passphrase-file=secret.txt --apply
 *
 * --apply refuses while the dashboard or a run is using the database. Before
 * replacing anything it backs up every current job list (data/backups) and
 * every file it overwrites (data/backups/pre-import-<stamp>/).
 */
import { resolve } from 'node:path';

import { PROJECT_ROOT } from '../src/config/loadConfig.js';
import { MIGRATIONS } from '../src/logging/db.js';
import { importBundle, readPassphraseFile } from '../src/logging/bundle.js';
import { unsafeToWriteReason } from './dbMaintenance.mjs';

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: npm run import -- <file.jobagent> [--apply] [--passphrase-file=...]');
  process.exit(2);
}
const apply = args.includes('--apply');
const passFile = arg('passphrase-file');
const passphrase = passFile ? readPassphraseFile(passFile) : (process.env.JOBAGENT_EXPORT_PASSPHRASE || null);

try {
  if (apply) {
    const reason = await unsafeToWriteReason({ root: PROJECT_ROOT, port: Number(arg('port')) || 4646 });
    if (reason) throw new Error(`not importing: ${reason}`);
  }
  const r = await importBundle(PROJECT_ROOT, resolve(file), {
    passphrase, apply, latestSchema: MIGRATIONS[MIGRATIONS.length - 1].version,
  });
  console.log(`Export from ${r.meta.created_at}${r.meta.app_version ? ` (JobAgent ${r.meta.app_version})` : ''}:`);
  for (const f of r.plan) console.log(`  ${f.replaces ? 'replace' : 'add    '}  ${f.path}  (${(f.size / 1e6).toFixed(2)} MB)`);
  if (!r.applied) {
    console.log('\nNothing changed. Run again with --apply to import.');
  } else {
    console.log(`\nImported. Backed up ${r.backups} job list(s) first${r.keptFilesIn ? `; replaced files kept in ${r.keptFilesIn}` : ''}.`);
  }
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
}
