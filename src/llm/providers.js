/**
 * LLM providers behind one call (P1-1).
 *
 *   openai     any OpenAI-compatible /chat/completions server (the shipped
 *              default: NVIDIA's hosted endpoint). Plain fetch.
 *   lmstudio   LM Studio's local OpenAI-compatible server, with JSON-schema
 *              constrained output. Plain fetch; no key.
 *   ollama     Ollama's native /api/chat, with the JSON schema as `format`
 *              (constrained decoding). Plain fetch; no key.
 *   anthropic  Claude through the official @anthropic-ai/sdk (an optional
 *              dependency, loaded only when this provider is chosen), with
 *              structured output (`output_config.format`).
 *
 * Every provider takes { cfg, system, messages, maxTokens, schema, effort }
 * and resolves { text, usage: { inputTokens, outputTokens }, model } or throws.
 * `messages` is [{ role: 'user'|'assistant', content: string }].
 */
import { withRetry } from '../utils/retryHandler.js';

/** Longest Retry-After honoured (a provider asking for minutes is a failure). */
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 2;

/**
 * Retry-After header -> milliseconds (delta-seconds or HTTP-date), or null.
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {number|null}
 */
export function retryAfterToMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * One HTTP JSON exchange with a provider: timeout over request AND body,
 * bounded retries for 429 / 5xx / network errors honouring Retry-After. Errors
 * never carry the key or the provider's payload.
 */
async function postJson(url, { headers, body, timeoutMs }, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = new Error(`provider returned HTTP ${response.status}`);
        err.status = response.status;
        const retryAfterMs = retryAfterToMs(response.headers?.get?.('retry-after'));
        if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      try {
        return await response.json();
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw Object.assign(new Error(`could not read provider response: ${err.message}`), { retryable: false });
      }
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await withRetry(attempt, {
      maxRetries: deps.maxRetries ?? MAX_RETRIES,
      baseDelayMs: 500,
      maxDelayMs: MAX_RETRY_DELAY_MS,
      ...(deps.sleepFn ? { sleepFn: deps.sleepFn } : {}),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`timed out after ${timeoutMs}ms`);
    throw err;
  }
}

/** OpenAI-compatible chat completions (also LM Studio). */
async function openaiCompatible({ cfg, system, messages, maxTokens, schema }, deps) {
  // LM Studio rejects json_object and accepts json_schema; NVIDIA and most
  // hosted servers accept json_object. LLM_JSON_MODE=schema forces the schema.
  const useSchema = schema && (cfg.provider === 'lmstudio' || cfg.jsonMode === 'schema');
  const body = {
    model: cfg.model,
    // Deterministic: the same input must give the same output, or the audit
    // trail on a re-prepared resume means nothing.
    temperature: 0,
    max_tokens: maxTokens,
    response_format: useSchema
      ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } }
      : { type: 'json_object' },
    messages: [{ role: 'system', content: system }, ...messages],
  };
  const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const payload = await postJson(`${cfg.baseUrl}/chat/completions`, { headers, body, timeoutMs: cfg.timeoutMs }, deps);
  return {
    text: payload?.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: Number(payload?.usage?.prompt_tokens) || 0,
      outputTokens: Number(payload?.usage?.completion_tokens) || 0,
    },
    model: payload?.model ?? cfg.model,
  };
}

/** Ollama's native chat API; `format` is the JSON schema (constrained decoding). */
async function ollama({ cfg, system, messages, maxTokens, schema }, deps) {
  const body = {
    model: cfg.model,
    stream: false,
    format: schema ?? 'json',
    options: { temperature: 0, num_predict: maxTokens },
    messages: [{ role: 'system', content: system }, ...messages],
  };
  const payload = await postJson(`${cfg.baseUrl}/api/chat`, { headers: {}, body, timeoutMs: cfg.timeoutMs }, deps);
  return {
    text: payload?.message?.content ?? '',
    usage: { inputTokens: Number(payload?.prompt_eval_count) || 0, outputTokens: Number(payload?.eval_count) || 0 },
    model: payload?.model ?? cfg.model,
  };
}

/**
 * Claude through the official SDK. Structured output constrains the reply to
 * the task's JSON schema. Claude Opus 5.5 always thinks (depth is `effort`)
 * and takes no temperature. Server-side refusal fallbacks are on: if a safety
 * classifier declines, the API re-runs the request on its fallback model.
 */
async function anthropic({ cfg, system, messages, maxTokens, schema, effort }, deps) {
  let Anthropic = deps.AnthropicSdk;
  if (!Anthropic) {
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw Object.assign(new Error('the Anthropic provider needs the @anthropic-ai/sdk package: run npm install'), { retryable: false });
    }
  }
  const client = new Anthropic({
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    timeout: cfg.timeoutMs,
    maxRetries: deps.maxRetries ?? MAX_RETRIES,
  });
  const request = {
    model: cfg.model,
    max_tokens: Math.max(maxTokens, 16_000),
    system,
    messages,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      ...(effort ? { effort } : {}),
      ...(schema ? { format: { type: 'json_schema', schema } } : {}),
    },
  };
  let response;
  try {
    response = await client.beta.messages.create(request);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw Object.assign(new Error(`provider returned HTTP ${err.status ?? 'error'}`), { status: err.status, retryable: false });
    }
    throw err;
  }
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? 'unspecified';
    throw Object.assign(new Error(`the model declined this request (${category})`), { retryable: false });
  }
  if (response.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('the reply was cut off at the token limit'), { retryable: false });
  }
  const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    usage: { inputTokens: Number(response.usage?.input_tokens) || 0, outputTokens: Number(response.usage?.output_tokens) || 0 },
    model: response.model ?? cfg.model,
  };
}

const PROVIDERS = { openai: openaiCompatible, lmstudio: openaiCompatible, ollama, anthropic };

export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

/**
 * Send one request to the configured provider.
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number }, model: string }>}
 */
export function callProvider(args, deps = {}) {
  const impl = PROVIDERS[args.cfg.provider];
  if (!impl) return Promise.reject(new Error(`unknown LLM provider "${args.cfg.provider}"`));
  return impl(args, deps);
}
