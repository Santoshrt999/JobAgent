/**
 * Rank the top deterministic matches by meaning (P2-1).
 *
 * The deterministic score stays the score: it decides tiers, gates and
 * Auto-apply eligibility, and nothing here changes it. This adds a second,
 * clearly labelled number for the top matches: how close each posting is in
 * meaning to the bullets of your master resume, with the three closest
 * bullets as the reason. It generates no text, so there is nothing to ground.
 * The result is kept in data/semantic-rerank.json; no schema change.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { boardPage } from '../dashboard/data.js';
import { embed, embedSettings } from '../llm/embeddings.js';
import { readMasterUnits } from '../resume/tailorRunner.js';
import { writeFileAtomic } from '../utils/fsSafe.js';
import { workspacePaths } from '../profile/workspace.js';

export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Per workspace: the scores compare THIS person's resume bullets with jobs in
// THIS person's database, so another candidate must never be shown them.
const resultFile = (root) => join(workspacePaths(root).dataDir, 'semantic-rerank.json');

export function readRerank(root) {
  if (!root) return null;
  try { return JSON.parse(readFileSync(resultFile(root), 'utf8')); } catch { return null; }
}

export async function rerank({ db, config, env = process.env, topN = 50, now = new Date(), deps = {} }) {
  const root = config?.root ?? null;
  const cfg = embedSettings(env, { root });
  if (!cfg.enabled) throw Object.assign(new Error(cfg.reason), { statusCode: 409 });
  const bullets = (await (deps.readMasterUnitsFn ?? readMasterUnits)({ root, deps })).filter((u) => u.kind === 'bullet');
  if (!bullets.length) throw Object.assign(new Error('The master resume has no bullets to compare with.'), { statusCode: 422 });
  const jobs = boardPage(db, { limit: topN, sort: 'score', now }).jobs.slice(0, topN);
  const jobTexts = jobs.map((j) => `${j.title}\n${String(db.getJob(j.id)?.jd_text ?? '').slice(0, 2000)}`);
  const vectors = await embed([...bullets.map((b) => b.text), ...jobTexts], cfg, deps);
  const bulletVecs = vectors.slice(0, bullets.length);
  const items = jobs.map((job, i) => {
    const sims = bulletVecs.map((v, k) => ({ text: bullets[k].text, similarity: cosine(vectors[bullets.length + i], v) }))
      .sort((a, b) => b.similarity - a.similarity).slice(0, 3);
    const semantic = Math.round(100 * (sims.reduce((s, x) => s + x.similarity, 0) / Math.max(1, sims.length)));
    return {
      jobId: job.id, company: job.company, title: job.title, fitScore: job.score ?? null, tier: job.tier ?? null,
      semantic, closest: sims.map((s) => ({ text: s.text, similarity: Math.round(s.similarity * 100) })),
    };
  });
  const result = { at: now.toISOString(), model: cfg.model, provider: cfg.provider, items };
  if (root) writeFileAtomic(resultFile(root), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
