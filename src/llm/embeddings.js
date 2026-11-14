/**
 * Text embeddings for the semantic re-rank (P2-1). Opt-in: RERANK=on and a
 * model in RERANK_MODEL. Ollama (local, e.g. nomic-embed-text) or any
 * OpenAI-compatible /embeddings endpoint; Anthropic has no embeddings API.
 * Vectors are cached on disk by model and text, so a re-rank repeats free.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { llmSettings } from './client.js';

export function embedSettings(env = process.env, { root = null } = {}) {
  const llm = llmSettings({ ...env, LLM_ASSIST: 'on' }, { root });
  const provider = String(env.RERANK_PROVIDER ?? env.LLM_PROVIDER ?? 'openai').toLowerCase();
  const model = String(env.RERANK_MODEL ?? '').trim();
  const base = String(env.RERANK_BASE_URL ?? (provider === 'ollama' ? 'http://localhost:11434' : provider === 'lmstudio' ? 'http://localhost:1234/v1' : llm.baseUrl)).replace(/\/+$/, '');
  const apiKey = provider === 'ollama' || provider === 'lmstudio' ? '' : (env.RERANK_API_KEY ?? llm.apiKey ?? '');
  let reason = null;
  if (String(env.RERANK ?? 'off').toLowerCase() !== 'on') reason = 'Ranking by meaning is off (set RERANK=on and RERANK_MODEL in .env).';
  else if (provider === 'anthropic') reason = 'Anthropic has no embeddings API: set RERANK_PROVIDER=ollama (or an OpenAI-compatible server).';
  else if (!model) reason = 'Set RERANK_MODEL to an embedding model, for example nomic-embed-text with Ollama.';
  else if (provider !== 'ollama' && provider !== 'lmstudio' && !apiKey) reason = 'Set an API key for the embeddings server (RERANK_API_KEY).';
  return {
    enabled: reason === null, reason, provider, model, baseUrl: base, apiKey,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000) || 60_000,
    cacheDir: root ? join(root, '.tmp', 'embeddings') : null,
  };
}

const keyOf = (model, text) => createHash('sha256').update(`${model}\u0000${text}`).digest('hex').slice(0, 32);

/** Embed texts (cached). Resolves an array of number[] in the same order. */
export async function embed(texts, cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => {
    if (cfg.cacheDir) {
      try { out[i] = JSON.parse(readFileSync(join(cfg.cacheDir, `${keyOf(cfg.model, t)}.json`), 'utf8')); return; } catch { /* not cached */ }
    }
    missing.push(i);
  });
  for (let start = 0; start < missing.length; start += 32) {
    const batch = missing.slice(start, start + 32);
    const input = batch.map((i) => texts[i]);
    const ollama = cfg.provider === 'ollama';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let payload;
    try {
      const res = await fetchImpl(ollama ? `${cfg.baseUrl}/api/embed` : `${cfg.baseUrl}/embeddings`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input }),
      });
      if (!res.ok) throw new Error(`embeddings server returned HTTP ${res.status}`);
      payload = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const vectors = ollama ? payload.embeddings : (payload.data ?? []).map((d) => d.embedding);
    if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error('the embeddings server returned the wrong number of vectors');
    batch.forEach((i, j) => {
      out[i] = vectors[j];
      if (cfg.cacheDir) {
        try {
          mkdirSync(cfg.cacheDir, { recursive: true });
          writeFileAtomic(join(cfg.cacheDir, `${keyOf(cfg.model, texts[i])}.json`), JSON.stringify(vectors[j]), 'utf8');
        } catch { /* caching is best-effort */ }
      }
    });
  }
  return out;
}
