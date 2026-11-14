/**
 * How ready a job is for Auto-fill, before a browser is opened (audit
 * Backlog #1 and #5).
 *
 * Two facts decide most outcomes, and both were only discovered by running a
 * fill: whether the employer's application system needs an ACCOUNT (Workday,
 * Oracle, iCIMS, Taleo: one per employer) or none (Greenhouse, Lever, Ashby,
 * SmartRecruiters), and whether the form asks questions nobody has answered.
 *
 * Sign-ins persist: Auto-fill uses one browser profile per person, so signing
 * in to an employer's portal once lasts across fills. What was missing was
 * GROUPING: twenty Workday jobs stopped at "Needs sign-in" showed twenty
 * identical cards, where the honest instruction is "sign in to these three
 * portals, then retry each one's jobs together".
 *
 * Pure: no I/O. Nothing here fills, approves or submits anything.
 */
import { detectAts } from './atsDetector.js';

/** Application systems that need no candidate account. */
const INSTANT = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'jobvite', 'rippling']);
/** Application systems with a per-employer candidate account. */
const PORTAL = new Set(['workday', 'oraclerecruiting', 'oracle', 'icims', 'taleo', 'successfactors']);

/**
 * @param {{atsPlatform?: string|null, source?: string|null, url?: string|null}} job
 * @returns {{kind: 'instant'|'portal'|'unknown', platform: string|null, label: string}}
 */
export function applicationAccess(job = {}) {
  let platform = String(job.atsPlatform ?? '').toLowerCase() || null;
  if (!platform || platform === 'generic') {
    const src = String(job.source ?? '').toLowerCase();
    if (INSTANT.has(src) || PORTAL.has(src)) platform = src;
    else if (job.url) {
      const detected = detectAts({ url: job.url }).platform;
      platform = detected && detected !== 'generic' ? detected : null;
    }
  }
  if (platform && INSTANT.has(platform)) return { kind: 'instant', platform, label: 'No account needed' };
  if (platform && PORTAL.has(platform)) return { kind: 'portal', platform, label: 'Employer sign-in' };
  return { kind: 'unknown', platform, label: 'Application system not identified' };
}

/**
 * The portal a sign-in belongs to: one Workday tenant, one Oracle pod, one
 * iCIMS site. Signing in to it once covers every job it hosts.
 * @param {string} url
 * @returns {string|null} lowercase host
 */
export function portalHost(url) {
  try { return new URL(String(url)).host.toLowerCase() || null; } catch { return null; }
}

/**
 * Jobs stopped at a sign-in wall, grouped by portal, largest group first.
 * @param {Array<{id: string, url?: string, company?: string, attention?: {kind?: string}}>} rows
 * @returns {Array<{host: string, company: string|null, platform: string|null, ids: string[], count: number}>}
 */
export function signInGroups(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    if (row?.attention?.kind !== 'sign_in') continue;
    const host = portalHost(row.url);
    if (!host) continue;
    let g = groups.get(host);
    if (!g) {
      g = { host, company: row.company ?? null, platform: applicationAccess(row).platform, ids: [], count: 0 };
      groups.set(host, g);
    }
    g.ids.push(row.id);
    g.count += 1;
    if (g.company && row.company && g.company !== row.company) g.company = null; // a shared portal
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/**
 * Open screening questions recorded against one job (from the question queue).
 * @param {{questions?: object[]}} queue
 * @param {string} jobId
 * @returns {Array<{key: string, label: string}>}
 */
export function openQuestionsFor(queue, jobId) {
  return (queue?.questions ?? [])
    .filter((q) => q?.status === 'open' && (q.jobs ?? []).some((s) => s?.jobId === jobId))
    .map((q) => ({ key: q.key, label: q.label }));
}
