#!/usr/bin/env node
/**
 * Export everything personal in this JobAgent folder to ONE file (P1-6):
 * every job list (all profiles), your config and answers, and your master
 * resumes with their kept versions. Use it to move to another computer, or as
 * an off-site copy. Never includes .env (API keys).
 *
 *   npm run export                         -> exports/jobagent-<date>.jobagent
 *   npm run export -- --out=D:\backup\me.jobagent
 *   npm run export -- --passphrase-file=secret.txt   (encrypted, AES-256-GCM)
 *
 * The file contains your personal data: keep it somewhere private.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PROJECT_ROOT } from '../src/config/loadConfig.js';
import { exportBundle, readPassphraseFile } from '../src/logging/bundle.js';
import { backupStamp } from '../src/logging/backup.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = resolve(arg('out') ?? join(PROJECT_ROOT, 'exports', `jobagent-${backupStamp().slice(0, 10)}.jobagent`));
const passFile = arg('passphrase-file');
const passphrase = passFile ? readPassphraseFile(passFile) : (process.env.JOBAGENT_EXPORT_PASSPHRASE || null);
const { version } = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));

try {
  const r = await exportBundle(PROJECT_ROOT, out, { passphrase, appVersion: version });
  console.log(`Exported ${r.databases} job list(s) and ${r.files} file(s) (${(r.bytes / 1e6).toFixed(1)} MB) to:`);
  console.log(`  ${r.file}`);
  console.log(r.encrypted ? 'Encrypted with your passphrase. Without it the file cannot be opened.'
    : 'Not encrypted: it contains your personal data, so keep it private (add --passphrase-file=... to encrypt).');
} catch (err) {
  console.error(`Export failed: ${err.message}`);
  process.exit(1);
}
