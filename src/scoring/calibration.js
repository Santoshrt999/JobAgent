// @ts-check
/**
 * Outcome-calibrated scoring, as a PROPOSAL only (P2-10).
 *
 * Scoring stays deterministic. This looks at the applications you submitted
 * and the outcomes you recorded, and asks, per scoring category: did the ones
 * that reached an interview earn more of this category's points than the ones
 * that did not? It proposes small, bounded weight changes where the answer is
 * clear, and writes them to a report. It never changes config/scoring.json by
 * itself; `--apply` does, after you have read the report.
 *
 * Guard rails:
 *   - refuses below MIN_OUTCOMES outcomes, or with fewer than MIN_SIDE
 *     applications on either side (interviewed / not);
 *   - a category moves only when its bootstrap interval for the difference
 *     excludes zero;
 *   - no weight moves more than MAX_STEP (20%) per round;
 *   - the total of all weights is preserved exactly.
 */
export const MIN_OUTCOMES = 30;
export const MIN_SIDE = 5;
export const MAX_STEP = 0.2;

/** Small seeded generator, so the same data always gives the same proposal. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 95% bootstrap interval of mean(pos) - mean(neg). */
function bootstrapDiff(pos, neg, { rounds = 1000, seed = 7 } = {}) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const diffs = [];
  for (let i = 0; i < rounds; i += 1) {
    const p = Array.from({ length: pos.length }, () => pick(pos));
    const n = Array.from({ length: neg.length }, () => pick(neg));
    diffs.push(mean(p) - mean(n));
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(rounds * 0.025)], diffs[Math.ceil(rounds * 0.975) - 1]];
}

/** Integer weights with the same total, by largest remainder. */
export function roundPreservingTotal(values, total) {
  const floors = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.floor(v)]));
  let left = total - Object.values(floors).reduce((a, b) => a + b, 0);
  const byRemainder = Object.entries(values).sort((a, b) => (b[1] - Math.floor(b[1])) - (a[1] - Math.floor(a[1])) || a[0].localeCompare(b[0]));
  for (const [k] of byRemainder) { if (left <= 0) break; floors[k] += 1; left -= 1; }
  return floors;
}

/**
 * @param {Array<{ positive: boolean, breakdown: Record<string, { points: number, weight?: number }> }>} samples
 * @param {Record<string, number>} weights current config weights
 * @returns {{ ok: boolean, reason?: string, counts: object, categories?: object[], proposed?: Record<string, number> }}
 */
export function calibrate(samples, weights, { minOutcomes = MIN_OUTCOMES, minSide = MIN_SIDE, maxStep = MAX_STEP, seed = 7 } = {}) {
  const pos = samples.filter((s) => s.positive);
  const neg = samples.filter((s) => !s.positive);
  const counts = { outcomes: samples.length, interviewed: pos.length, notInterviewed: neg.length };
  if (samples.length < minOutcomes) return { ok: false, reason: `needs at least ${minOutcomes} recorded outcomes; you have ${samples.length}`, counts };
  if (pos.length < minSide || neg.length < minSide) {
    return { ok: false, reason: `needs at least ${minSide} applications that reached an interview and ${minSide} that did not`, counts };
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const categories = [];
  const raw = {};
  for (const [cat, weight] of Object.entries(weights)) {
    const share = (s) => {
      const b = s.breakdown?.[cat];
      return weight > 0 && b ? Math.max(0, Math.min(1, Number(b.points) / weight)) : 0;
    };
    const p = pos.map(share); const n = neg.map(share);
    const diff = mean(p) - mean(n);
    const [low, high] = bootstrapDiff(p, n, { seed });
    const clear = low > 0 || high < 0;
    const step = clear ? Math.max(-maxStep, Math.min(maxStep, diff)) : 0;
    raw[cat] = weight * (1 + step);
    categories.push({ category: cat, weight, interviewedMean: +mean(p).toFixed(3), otherMean: +mean(n).toFixed(3), difference: +diff.toFixed(3), interval: [+low.toFixed(3), +high.toFixed(3)], clear, step: +step.toFixed(3) });
  }
  // Rescale so the total is unchanged, then round to whole points.
  const rawTotal = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const scaled = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (v * total) / rawTotal]));
  const proposed = roundPreservingTotal(scaled, total);
  return { ok: true, counts, categories, proposed };
}
