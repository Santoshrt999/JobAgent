// @ts-check
/**
 * The dashboard's access token (P1-5).
 *
 * The dashboard listens on 127.0.0.1 only, and its Origin, Host and
 * Fetch-Metadata checks stop web pages from driving it. They do not stop
 * another program, or another user account on the same computer, from calling
 * its API directly: anything that can open a socket to 127.0.0.1:4646 could
 * read the job store or start a run.
 *
 * So every /api/* request must also prove it was opened by this user. The
 * token is a random 256-bit value in data/.dashboard-token, readable only by
 * the user who owns the workspace. The launcher opens
 * http://127.0.0.1:<port>/?token=<token>; the server swaps it for an HttpOnly,
 * SameSite=Strict cookie and redirects to the clean URL, so the page, its
 * fetches and its download links all carry it without any front-end change.
 * Scripts can send it as the `X-Job-Agent-Token` header instead.
 *
 * The browser extension keeps its own shared key and is unaffected.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TOKEN_HEADER = 'x-job-agent-token';
export const TOKEN_FILE = join('data', '.dashboard-token');
const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** The token stored under a workspace root, or null when there is none yet. */
export function readToken(root) {
  if (!root) return null;
  try {
    const value = readFileSync(join(root, TOKEN_FILE), 'utf8').trim();
    return TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The workspace's token, creating it (owner-only permissions) on first use.
 * On Windows the file inherits the user-profile ACL, which already keeps
 * other accounts out; chmod is a no-op there.
 */
export function loadOrCreateToken(root) {
  const existing = readToken(root);
  if (existing) return existing;
  const token = newToken();
  const file = join(root, TOKEN_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
  return token;
}

/**
 * Decide the server's token.
 *  - deps.apiToken: a string uses it; `false` disables the check (tests only).
 *  - env JOB_AGENT_DASHBOARD_AUTH=off disables it (set by the test runner; a
 *    process able to set this server's environment could read the file anyway).
 *  - otherwise the workspace token, or a one-off in-memory token when the
 *    server has no workspace root.
 * @param {{ deps?: { apiToken?: string|false }, root?: string|null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string|null} null when the check is disabled
 */
export function resolveApiToken({ deps = {}, root = null, env = process.env } = {}) {
  if (deps.apiToken === false) return null;
  if (typeof deps.apiToken === 'string' && deps.apiToken) return deps.apiToken;
  if (String(env.JOB_AGENT_DASHBOARD_AUTH ?? '').toLowerCase() === 'off') return null;
  return root ? loadOrCreateToken(root) : newToken();
}

/**
 * Proof that a server holds the access token, without the token being sent:
 * HMAC-SHA256 of a caller-chosen challenge, keyed by the token. The launcher
 * asks for this before it sends the token anywhere, so a program squatting on
 * the dashboard's port cannot collect it.
 *
 * @param {string} token
 * @param {string} challenge
 * @returns {string} hex digest
 */
export function instanceProof(token, challenge) {
  return createHmac('sha256', String(token)).update(`jobagent-instance:${String(challenge)}`).digest('hex');
}

/** Constant-time comparison that does not leak the token's length either. */
export function tokensMatch(given, expected) {
  if (typeof given !== 'string' || !given || typeof expected !== 'string' || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Cookie name: per port, so two dashboards on one machine do not collide. */
export function cookieName(port) {
  return `jobagent_token_${Number(port) || 0}`;
}

/** The token a request carries, from the header or the cookie. */
export function tokenFromRequest(req, port) {
  const header = req.headers?.[TOKEN_HEADER];
  if (typeof header === 'string' && header) return header.trim();
  const cookies = String(req.headers?.cookie ?? '');
  const name = cookieName(port);
  for (const part of cookies.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

export function sessionCookie(token, port) {
  return `${cookieName(port)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** The link that unlocks the dashboard in a browser. */
export function unlockUrl(baseUrl, token) {
  return token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : baseUrl;
}

/** The page shown to a browser without the token. No script; inline style only. */
export function lockedPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JobAgent is locked</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 16px; background: #f5f7fa; color: #131a24; }
  main { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #d5dbe3; border-radius: 12px; padding: 24px 28px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  code { background: #eef1f5; padding: 1px 6px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f141b; color: #e6ebf2; } main { background: #161d26; border-color: #2a3442; } code { background: #222c38; }
  }
</style></head>
<body><main>
  <h1>JobAgent is locked</h1>
  <p>This dashboard only opens from its own link, so other programs on this computer cannot read your jobs.</p>
  <p>Open JobAgent with its launcher (<code>start-job-agent</code>, or <code>npm run app</code>), which opens the right link for you.</p>
  <p>If it is already running, run <code>npm run dashboard:link</code> in the JobAgent folder and open the link it prints.</p>
</main></body></html>`;
}
