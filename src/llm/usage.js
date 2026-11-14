/**
 * Totals from logs/llm-usage.jsonl (P3-5): calls, tokens and cache hits per
 * task and model. The log holds token counts only, never prompts or answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Summarize usage lines since `sinceDays` ago. Pure. */
export function summarizeUsage(lines, { now = new Date(), sinceDays = 30 } = {}) {
  const since = now.getTime() - sinceDays * 86_400_000;
  const byKey = new Map();
  const totals = { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 };
  for (const line of lines) {
    let e;
    try { e = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    if (!e || Date.parse(e.at) < since) continue;
    const key = `${e.task}\u0000${e.provider}\u0000${e.model}`;
    const row = byKey.get(key) ?? { task: e.task, provider: e.provider, model: e.model, calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 };
    row.calls += 1; totals.calls += 1;
    if (e.cached) { row.cached += 1; totals.cached += 1; }
    row.inputTokens += Number(e.inputTokens) || 0; totals.inputTokens += Number(e.inputTokens) || 0;
    row.outputTokens += Number(e.outputTokens) || 0; totals.outputTokens += Number(e.outputTokens) || 0;
    byKey.set(key, row);
  }
  return { sinceDays, totals, rows: [...byKey.values()].sort((a, b) => b.calls - a.calls) };
}

export function readUsage(root, options) {
  let text = '';
  try { text = readFileSync(join(root, 'logs', 'llm-usage.jsonl'), 'utf8'); } catch { /* no usage yet */ }
  return summarizeUsage(text.split('\n').filter(Boolean), options);
}
