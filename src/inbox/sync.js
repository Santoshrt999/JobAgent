/**
 * Read replies and suggest outcomes (P1-7). Read-only; never sends, moves,
 * flags or deletes mail, and never changes an application by itself.
 *
 * Settings (.env):
 *   INBOX=imap                  turn it on (default off)
 *   INBOX_IMAP_HOST=imap.gmail.com, INBOX_IMAP_PORT=993, INBOX_IMAP_USER=you@...
 *   INBOX_IMAP_PASSWORD         an app password; better kept in the secret
 *                               store (npm run secret -- set INBOX_IMAP_PASSWORD)
 *   INBOX_LOOKBACK_DAYS=30
 *
 * Each sync reads messages since the lookback date, matches each to one
 * submitted application, classifies it, and records a suggestion as an
 * `inbox_suggestion` event: sender, subject, date, kind and the evidence
 * sentence. The message body is never stored. A person then records the
 * suggested outcome or dismisses it.
 */
import { randomUUID } from 'node:crypto';

import { llmSettings } from '../llm/client.js';
import { createSecretStore } from '../utils/secretStore.js';
import { classifyReply, KIND_TO_OUTCOME } from './classify.js';
import { ImapReadOnlyClient } from './imapClient.js';
import { matchReply } from './match.js';
import { bodyText, parseAddress, parseHeaders } from './mime.js';

export const SUGGESTION_EVENT = 'inbox_suggestion';
export const DECISION_EVENT = 'inbox_decision';

export function inboxSettings(env = process.env, { root = null, secrets = null } = {}) {
  const mode = String(env.INBOX ?? 'off').trim().toLowerCase();
  const base = {
    host: String(env.INBOX_IMAP_HOST ?? 'imap.gmail.com').trim(),
    port: Number(env.INBOX_IMAP_PORT ?? 993) || 993,
    secure: String(env.INBOX_IMAP_TLS ?? 'on').toLowerCase() !== 'off',
    user: String(env.INBOX_IMAP_USER ?? '').trim(),
    lookbackDays: Math.min(Math.max(Number(env.INBOX_LOOKBACK_DAYS ?? 30) || 30, 1), 365),
  };
  if (mode !== 'imap') return { ...base, enabled: false, reason: 'Reading replies is off (set INBOX=imap in .env).' };
  if (!base.user) return { ...base, enabled: false, reason: 'Set INBOX_IMAP_USER to your email address.' };
  let password = null;
  try {
    password = (secrets ?? (root ? createSecretStore({ root, env }) : null))?.get('INBOX_IMAP_PASSWORD') ?? env.INBOX_IMAP_PASSWORD ?? null;
  } catch (err) {
    return { ...base, enabled: false, reason: `The inbox password could not be read: ${err.message}` };
  }
  if (!password) return { ...base, enabled: false, reason: 'Store an app password: npm run secret -- set INBOX_IMAP_PASSWORD' };
  return { ...base, enabled: true, reason: null, password };
}

function knownMessageIds(db) {
  return new Set((db.listEvents?.() ?? [])
    .filter((e) => e.event_type === SUGGESTION_EVENT)
    .map((e) => { try { return JSON.parse(e.metadata).messageId; } catch { return null; } })
    .filter(Boolean));
}

/**
 * One sync pass.
 * @returns {Promise<{ read: number, matched: number, suggested: number, skippedKnown: number }>}
 */
export async function syncInbox({ db, root, env = process.env, now = new Date(), deps = {} }) {
  const settings = deps.inboxSettings ?? inboxSettings(env, { root, secrets: deps.secrets });
  if (!settings.enabled) throw Object.assign(new Error(settings.reason), { statusCode: 409 });
  const jobs = db.listSubmittedJobs();
  const known = knownMessageIds(db);
  // Classifying a reply with the LLM sends part of a real email to the
  // provider, which LLM_ASSIST alone never promised. It needs its own switch.
  const inboxLlm = String(env.INBOX_LLM ?? 'off').trim().toLowerCase() === 'on';
  const llm = inboxLlm ? llmSettings(env, { root }) : null;
  const client = deps.client ?? new ImapReadOnlyClient({ host: settings.host, port: settings.port, secure: settings.secure, connectImpl: deps.connectImpl });
  const stats = { read: 0, matched: 0, suggested: 0, skippedKnown: 0 };
  await client.connect();
  try {
    await client.login(settings.user, settings.password);
    await client.examine('INBOX');
    const since = new Date(now.getTime() - settings.lookbackDays * 86_400_000);
    const uids = (await client.searchSince(since)).slice(-500);
    for (let i = 0; i < uids.length; i += 50) {
      for (const msg of await client.fetch(uids.slice(i, i + 50))) {
        stats.read += 1;
        const head = parseHeaders(msg.header);
        const messageId = head['message-id'] || `uid:${settings.user}:${msg.uid}`;
        if (known.has(messageId)) { stats.skippedKnown += 1; continue; }
        const from = parseAddress(head.from);
        const message = {
          from, subject: head.subject ?? '',
          body: bodyText(msg.text, { contentTypeHeader: head['content-type'], encoding: head['content-transfer-encoding'] }),
        };
        const match = matchReply(message, jobs);
        if (!match) continue;
        stats.matched += 1;
        const verdict = await classifyReply(message, { llm, deps });
        if (verdict.kind === 'unclassified') continue;
        db.insertEvent({
          id: randomUUID(), job_id: match.jobId, event_type: SUGGESTION_EVENT,
          message: `${verdict.kind} reply from ${from.domain || 'unknown sender'}`,
          metadata: JSON.stringify({
            messageId, from: { name: from.name, domain: from.domain, address: from.address }, subject: message.subject.slice(0, 300),
            date: head.date ?? null, kind: verdict.kind, outcome: KIND_TO_OUTCOME[verdict.kind] ?? null,
            evidence: verdict.evidence, method: verdict.method, task: verdict.task ?? null, matchedBy: match.how,
          }),
        });
        known.add(messageId);
        stats.suggested += 1;
      }
    }
  } finally {
    await client.logout();
  }
  return stats;
}

/** Suggestions nobody has decided on yet, newest first. */
export function pendingSuggestions(db) {
  const events = db.listEvents?.() ?? [];
  const decided = new Set(events.filter((e) => e.event_type === DECISION_EVENT)
    .map((e) => { try { return JSON.parse(e.metadata).suggestionId; } catch { return null; } }));
  return events
    .filter((e) => e.event_type === SUGGESTION_EVENT && !decided.has(e.id))
    .map((e) => {
      const job = db.getJob?.(e.job_id);
      return { id: e.id, jobId: e.job_id, company: job?.company ?? null, title: job?.title ?? null, at: e.created_at, ...JSON.parse(e.metadata) };
    })
    .reverse();
}

/** Record or dismiss one suggestion. Recording writes the normal outcome event. */
export function decideSuggestion(db, suggestionId, action, { recordOutcomeFn, now = new Date(), config = null } = {}) {
  const event = (db.listEvents?.() ?? []).find((e) => e.id === suggestionId && e.event_type === SUGGESTION_EVENT);
  if (!event) throw Object.assign(new Error('That suggestion no longer exists.'), { statusCode: 404 });
  if (!['record', 'dismiss'].includes(action)) throw Object.assign(new Error('action must be record or dismiss'), { statusCode: 400 });
  const meta = JSON.parse(event.metadata);
  let summary = null;
  if (action === 'record') {
    if (!meta.outcome) throw Object.assign(new Error('This reply only confirms the application arrived; there is no outcome to record.'), { statusCode: 400 });
    summary = recordOutcomeFn(db, event.job_id, {
      outcome: meta.outcome, now, config, note: `From an email: "${String(meta.evidence ?? meta.subject).slice(0, 180)}"`,
    });
  }
  db.insertEvent({
    id: randomUUID(), job_id: event.job_id, event_type: DECISION_EVENT,
    message: action === 'record' ? `recorded ${meta.outcome} from an email` : 'dismissed an email suggestion',
    metadata: JSON.stringify({ suggestionId, action }),
  });
  return { action, summary };
}
