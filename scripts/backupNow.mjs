#!/usr/bin/env node
/** Back up every job list now (P1-6): npm run backup. Safe while the dashboard runs. */
import { PROJECT_ROOT } from '../src/config/loadConfig.js';
import { backupAll } from '../src/logging/backup.js';

try {
  const made = await backupAll(PROJECT_ROOT, { label: 'manual' });
  if (!made.length) console.log('No job list to back up yet.');
  for (const m of made) console.log(`Backed up ${m.workspaceId || 'default'} (${(m.bytes / 1e6).toFixed(1)} MB) to ${m.path}`);
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
}
