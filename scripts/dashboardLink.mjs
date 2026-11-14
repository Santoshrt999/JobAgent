#!/usr/bin/env node
/**
 * Print the link that opens (unlocks) the running dashboard: the dashboard
 * requires its access token (data/.dashboard-token), which the launcher
 * normally passes for you. Use this when the browser says "JobAgent is locked".
 *
 * Usage: npm run dashboard:link [-- --port=4646]
 */
import { readToken, unlockUrl } from '../src/dashboard/apiToken.js';
import { PROJECT_ROOT } from '../src/config/loadConfig.js';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg?.slice(7) ?? process.env.DASHBOARD_PORT ?? 4646) || 4646;
const token = readToken(PROJECT_ROOT);
if (!token) {
  console.error('No dashboard token yet. Start JobAgent once (npm run app); it creates data/.dashboard-token.');
  process.exit(1);
}
console.log(unlockUrl(`http://127.0.0.1:${port}`, token));
