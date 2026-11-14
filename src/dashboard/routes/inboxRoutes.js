/**
 * Email replies (P1-7): read-only inbox sync, the suggestions it found, and a
 * person's decision on each. Nothing here sends mail or changes an
 * application without a click.
 */
import { decideSuggestion, inboxSettings, pendingSuggestions, syncInbox } from '../../inbox/sync.js';
import { recordOutcome } from '../data.js';
import { draftReply } from '../../inbox/draftReply.js';
import { llmSettings } from '../../llm/client.js';
import { readBody, sendJson } from '../httpHelpers.js';
import { sanitizeErrorMessage } from '../../utils/failureRca.js';
import { NOT_HANDLED } from './notHandled.js';

export async function handleInboxRoutes(ctx, req, res, { path }) {
  if (!path.startsWith('/api/inbox')) return NOT_HANDLED;
  const env = ctx.deps.inboxEnv ?? process.env;
  if (req.method === 'GET' && path === '/api/inbox') {
    const settings = ctx.deps.inboxSettings ?? inboxSettings(env, { root: ctx.config?.root, secrets: ctx.deps.secrets });
    const drafts = llmSettings(ctx.deps.llmEnv ?? process.env, { root: ctx.config?.root }).enabled;
    return sendJson(res, 200, { enabled: settings.enabled, reason: settings.reason, draftsEnabled: drafts, suggestions: pendingSuggestions(ctx.db) });
  }
  if (req.method === 'POST' && path === '/api/inbox/sync') {
    try {
      const stats = await (ctx.deps.syncInboxImpl ?? syncInbox)({ db: ctx.db, root: ctx.config?.root, env, deps: ctx.deps });
      return sendJson(res, 200, { stats, suggestions: pendingSuggestions(ctx.db) });
    } catch (err) {
      return sendJson(res, err.statusCode ?? 502, { error: `Could not read your inbox: ${sanitizeErrorMessage(err.message)}` });
    }
  }
  if (req.method === 'POST' && path === '/api/inbox/draft') {
    const body = await readBody(req);
    const draft = await (ctx.deps.draftReplyImpl ?? draftReply)({
      db: ctx.db, suggestionId: String(body.id ?? ''), config: ctx.config, env: ctx.deps.llmEnv ?? process.env, deps: ctx.deps,
    });
    return sendJson(res, 200, { draft });
  }
  if (req.method === 'POST' && path === '/api/inbox/decide') {
    const body = await readBody(req);
    const result = decideSuggestion(ctx.db, String(body.id ?? ''), String(body.action ?? ''), {
      recordOutcomeFn: recordOutcome, now: ctx.nowDate(), config: ctx.config,
    });
    ctx.refreshTracker();
    return sendJson(res, 200, { ...result, suggestions: pendingSuggestions(ctx.db) });
  }
  return NOT_HANDLED;
}
