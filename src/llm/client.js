/**
 * Minimal OpenAI-compatible chat client for the OPTIONAL LLM assist layer.
 *
 * Deliberately dependency-free (global fetch only) so enabling LLM assist never
 * adds an npm dependency to the core agent, and disabling it costs nothing.
 *
 * Everything about this layer is opt-in and fail-safe:
 *   - Off unless LLM_ASSIST=on AND a key is present.
 *   - Hard timeout and a token ceiling on every call.
 *   - Any error, timeout, or malformed reply resolves to `{ ok: false }`. It
 *     never throws into the pipeline, because a resume must still be produced
 *     when the network is down.
 *   - Responses are cached on disk by content hash so re-preparing the same job
 *     is free and does not re-bill the account.
 *
 * Providers (P1-1, src/llm/providers.js): any OpenAI-compatible server (the
 * shipped default targets NVIDIA's endpoint), Anthropic, and the local Ollama
 * and LM Studio servers. LLM_PROVIDER picks one; with it unset nothing changes
 * for an existing OpenAI-compatible setup.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { callProvider, PROVIDER_NAMES, retryAfterToMs } from './providers.js';

export { retryAfterToMs };

/** Default provider endpoint (OpenAI-compatible /chat/completions). */
export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
/** Default model for the default endpoint. */
export const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
/** Default Claude model when LLM_PROVIDER=anthropic and LLM_MODEL is unset. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
/** Hard wall-clock ceiling for one call, per provider kind. */
const DEFAULT_TIMEOUT_MS = { openai: 30_000, anthropic: 120_000, ollama: 180_000, lmstudio: 180_000 };
/** Local servers' usual addresses. */
const LOCAL_BASE_URL = { ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234/v1' };
/** Never send more input text than this (cost + latency ceiling). */
export const MAX_INPUT_CHARS = 24_000;

/**
 * Resolve LLM assist settings from the environment.
 *
 *   LLM_ASSIST     on | off (default off: every LLM feature is opt-in)
 *   LLM_PROVIDER   openai (default) | anthropic | ollama | lmstudio
 *   LLM_MODEL      required for ollama and lmstudio; defaults exist for the others
 *   LLM_BASE_URL   override the endpoint
 *   LLM_API_KEY    key for any hosted provider; NVIDIA_API_KEY (openai) and
 *                  ANTHROPIC_API_KEY (anthropic) also work. Local servers need none.
 *   LLM_TIMEOUT_MS, LLM_JSON_MODE=schema (openai: ask for JSON-schema output)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean, reason: string|null, provider: string, apiKey: string,
 *   baseUrl: string, model: string, timeoutMs: number, jsonMode: string,
 *   cacheDir: string|null, usageLog: string|null
 * }}
 */
export function llmSettings(env = process.env, { root = null } = {}) {
  const flag = String(env.LLM_ASSIST ?? '').trim().toLowerCase();
  const on = ['1', 'on', 'true', 'yes', 'enabled'].includes(flag);
  const provider = String(env.LLM_PROVIDER ?? 'openai').trim().toLowerCase() || 'openai';
  const local = provider === 'ollama' || provider === 'lmstudio';
  const apiKey = String(
    provider === 'anthropic'
      ? (env.ANTHROPIC_API_KEY ?? env.LLM_API_KEY ?? '')
      : local ? (env.LLM_API_KEY ?? '') : (env.NVIDIA_API_KEY ?? env.LLM_API_KEY ?? ''),
  ).trim();
  const defaultModel = provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : provider === 'openai' ? DEFAULT_MODEL : '';
  const model = String(env.LLM_MODEL ?? defaultModel).trim();
  const baseUrl = String(env.LLM_BASE_URL ?? (provider === 'openai' ? DEFAULT_BASE_URL : LOCAL_BASE_URL[provider] ?? ''))
    .replace(/\/+$/, '');

  let reason = null;
  if (!on) reason = 'LLM_ASSIST is not enabled (set LLM_ASSIST=on in .env)';
  else if (!PROVIDER_NAMES.includes(provider)) reason = `unknown LLM_PROVIDER "${provider}" (use openai, anthropic, ollama or lmstudio)`;
  else if (!local && !apiKey) {
    reason = provider === 'anthropic' ? 'no API key found (set ANTHROPIC_API_KEY in .env)' : 'no API key found (set NVIDIA_API_KEY or LLM_API_KEY in .env)';
  } else if (!model) reason = `set LLM_MODEL to the ${provider} model to use`;

  return {
    enabled: reason === null,
    reason,
    provider,
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS[provider] ?? 30_000) || 30_000,
    jsonMode: String(env.LLM_JSON_MODE ?? '').toLowerCase(),
    cacheDir: root && env.LLM_CACHE !== 'off' ? join(root, '.tmp', 'llm-cache') : null,
    usageLog: root ? join(root, 'logs', 'llm-usage.jsonl') : null,
  };
}

/**
 * Stable cache key for one request.
 *
 * The separator is U+0000 written as the `\u0000` ESCAPE. It used to be two
 * literal NUL bytes in the source, which made git treat this file as binary
 * (no diffs, no blame). The escape hashes to the same bytes, so existing
 * cache entries remain valid. Non-default providers and task versions are
 * folded in, so changing either never serves a stale answer.
 */
export function cacheKey({ model, system, user, provider = 'openai', task = '' }) {
  const prefix = provider === 'openai' && !task ? '' : `${provider}\u0000${task}\u0000`;
  return createHash('sha256')
    .update(`${prefix}${model}\u0000${system}\u0000${user}`)
    .digest('hex')
    .slice(0, 32);
}

export function readCache(dir, key) {
  if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')); }
  catch { return null; }
}

export function writeCache(dir, key, value) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${key}.json`), JSON.stringify(value), 'utf8');
  } catch { /* caching is best-effort */ }
}

/**
 * Append one line to logs/llm-usage.jsonl: which task, provider and model, how
 * many tokens, cached or not. Never the prompt or the answer.
 */
export function logUsage(cfg, entry) {
  if (!cfg?.usageLog) return;
  try {
    mkdirSync(join(cfg.usageLog, '..'), { recursive: true });
    appendFileSync(cfg.usageLog, `${JSON.stringify({ at: new Date().toISOString(), provider: cfg.provider, model: cfg.model, ...entry })}\n`);
  } catch { /* usage logging is best-effort */ }
}

/** A provider error as a short, key-free message. */
export function providerErrorMessage(err) {
  const message = String(err?.message ?? err);
  if (typeof err?.status === 'number' || /^(timed out|could not read provider response|the model declined|the reply was cut off|the Anthropic provider needs)/.test(message)) {
    return message;
  }
  return `request failed: ${message}`;
}

/**
 * Ask the model for a JSON object (no schema). Kept for callers that predate
 * runTask (src/llm/task.js), which adds schema validation and a repair turn.
 *
 * @param {object} args
 * @param {string} args.system system prompt
 * @param {string} args.user user prompt (truncated to MAX_INPUT_CHARS)
 * @param {object} [args.settings] llmSettings() result
 * @param {number} [args.maxTokens=1600]
 * @param {object} [deps] { fetchImpl, sleepFn, maxRetries } for tests
 * @returns {Promise<{ ok: boolean, data: any, error: string|null, cached: boolean, model: string }>}
 */
export async function completeJson({
  system, user, settings, maxTokens = 1600,
} = {}, deps = {}) {
  const cfg = settings ?? llmSettings();
  const fail = (error) => ({ ok: false, data: null, error, cached: false, model: cfg.model });

  if (!cfg.enabled) return fail(cfg.reason ?? 'LLM assist disabled');

  const prompt = String(user ?? '').slice(0, MAX_INPUT_CHARS);
  const key = cacheKey({ model: cfg.model, system, user: prompt, provider: cfg.provider ?? 'openai' });
  const hit = readCache(cfg.cacheDir, key);
  if (hit) return { ok: true, data: hit, error: null, cached: true, model: cfg.model };

  let reply;
  try {
    reply = await callProvider({
      cfg: { provider: 'openai', ...cfg }, system, messages: [{ role: 'user', content: prompt }], maxTokens,
    }, deps);
  } catch (err) {
    return fail(providerErrorMessage(err));
  }

  const parsed = parseJsonObject(reply.text);
  if (!parsed) return fail('provider did not return parseable JSON');

  writeCache(cfg.cacheDir, key, parsed);
  logUsage(cfg, { task: 'json', ...reply.usage, cached: false });
  return { ok: true, data: parsed, error: null, cached: false, model: cfg.model };
}

/**
 * Parse a JSON object out of a model reply, tolerating ```json fences and
 * surrounding prose. Returns null when nothing usable is present.
 */
export function parseJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const attempts = [unfenced];
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(unfenced.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* try the next shape */ }
  }
  return null;
}
