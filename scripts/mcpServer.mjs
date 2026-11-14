#!/usr/bin/env node
/**
 * Start JobAgent's MCP server on stdio (P2-4). Point an MCP client at it, for
 * example in Claude Desktop's config:
 *
 *   "jobagent": { "command": "npm", "args": ["run", "--silent", "mcp"], "cwd": "<path to JobAgent>" }
 *
 * Read tools plus "add a note" and "record an outcome". No tool approves,
 * fills, submits, sends or deletes anything.
 */
import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';

let sdk;
try {
  sdk = await import('@modelcontextprotocol/sdk/server/stdio.js');
} catch {
  console.error('The MCP server needs @modelcontextprotocol/sdk: run npm install.');
  process.exit(1);
}
const { createMcpServer } = await import('../src/mcp/server.js');

// stdout belongs to the protocol: every log goes to stderr.
const config = loadConfig();
const db = openDatabase({});
const server = createMcpServer({ db, config });
await server.connect(new sdk.StdioServerTransport());
console.error('JobAgent MCP server ready (stdio).');
const close = () => { try { db.close(); } catch { /* closing */ } process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
