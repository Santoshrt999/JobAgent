// @ts-check
/**
 * Master resume vs. tailored resume, line by line.
 *
 * Tailoring may reorder, emphasise and (to hold a page budget) omit whole
 * bullets, and apply rewordings a person accepted. This answers the reviewer's
 * real question, "what is different, and did I lose anything that mattered?",
 * by comparing the two documents' TEXT rather than trusting the tailor's own
 * change log. Anything missing that the tailor did not declare is flagged as
 * unexpected, so a bug can never hide behind a tidy change list.
 *
 * Pure: it takes paragraph arrays and returns rows. The route reads the files.
 */

/** A measured result: number with a unit, money, a count. Mirrors tailor.py. */
const IMPACT_RE = /[$€£₹]\s?\d|\d+(?:\.\d+)?\s?(?:%|percent|x\b|×|k\b|m\b|mm\b|bn?\b|million|billion|thousand|hours?|days?|weeks?|months?|minutes?|seconds?|users?|customers?|clients?|people|engineers?|teams?|records?|rows?|tb|gb|pb|countries|states|sites|stores)|\b(?!(?:19|20)\d{2}\b)\d{2,}\+?(?:,\d{3})*\b/i;

/** @param {string} text */
export function hasImpact(text) {
  return IMPACT_RE.test(String(text ?? ''));
}

/** @param {string} text */
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
/** @param {string} text */
const key = (text) => norm(text).toLowerCase();

/** A section heading: short, mostly capitals ("PROFESSIONAL EXPERIENCE"). */
export function isHeadingLine(text) {
  const t = norm(text);
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

/**
 * "Label: a, b, c" with the same items in a different order is the same line.
 * Returns a canonical key for comma lists (bracket-aware), else null.
 * @param {string} text
 */
function listKey(text) {
  const t = key(text);
  const colon = t.indexOf(':');
  const label = colon > 0 && colon < 60 ? t.slice(0, colon) : '';
  const rest = colon > 0 && colon < 60 ? t.slice(colon + 1) : t;
  const items = [];
  let depth = 0; let current = '';
  for (const ch of rest) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';' || ch === '|') && depth === 0) { items.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  items.push(current.trim());
  const clean = items.filter(Boolean);
  if (clean.length < 3) return null;
  return `${label}::${clean.sort().join('|')}`;
}

/** @param {string} a @param {string} b */
function similarity(a, b) {
  const words = (s) => new Set(key(s).split(/[^a-z0-9+#.%$]+/).filter((w) => w.length > 2));
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** Longest common subsequence of two key arrays, as matched index pairs. */
function lcsPairs(a, b) {
  const n = a.length; const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; } else if (table[i + 1][j] >= table[i][j + 1]) i += 1; else j += 1;
  }
  return pairs;
}

/**
 * @typedef {{ text: string, role?: string, has_metric?: boolean, jd_terms?: string[], reason?: string }} Omission
 * @typedef {{ status: 'same'|'moved'|'reordered'|'reworded'|'omitted'|'added', text: string,
 *   before?: string, section: string, flags: string[], reason?: string, role?: string, kept?: boolean }} DiffRow
 */

/**
 * @param {object} args
 * @param {string[]} args.master paragraphs of the master resume
 * @param {string[]} args.tailored paragraphs of the tailored resume
 * @param {Omission[]} [args.omitted] the tailor's declared page-fit omissions
 * @param {{before: string, after: string}[]} [args.rewrites] accepted rewordings
 * @param {string[]} [args.keep] bullets pinned for this job
 * @returns {{ rows: DiffRow[], summary: Record<string, number>, flagged: DiffRow[] }}
 */
export function diffResume({ master = [], tailored = [], omitted = [], rewrites = [], keep = [] }) {
  const a = master.map(norm).filter(Boolean);
  const b = tailored.map(norm).filter(Boolean);
  const ak = a.map(key); const bk = b.map(key);
  const matchedA = new Map(); // master index -> tailored index
  const matchedB = new Map();
  /** @type {Map<number, 'same'|'moved'|'reordered'|'reworded'>} */
  const how = new Map();

  for (const [i, j] of lcsPairs(ak, bk)) { matchedA.set(i, j); matchedB.set(j, i); how.set(i, 'same'); }

  // Moved: identical text, outside the common order.
  const freeB = new Map();
  bk.forEach((k, j) => { if (!matchedB.has(j)) freeB.set(k, [...(freeB.get(k) ?? []), j]); });
  ak.forEach((k, i) => {
    if (matchedA.has(i)) return;
    const slots = freeB.get(k);
    if (slots?.length) { const j = slots.shift(); matchedA.set(i, j); matchedB.set(j, i); how.set(i, 'moved'); }
  });
  // Reordered lists: the same items in another order.
  const listB = new Map();
  b.forEach((t, j) => { if (!matchedB.has(j)) { const lk = listKey(t); if (lk) listB.set(lk, [...(listB.get(lk) ?? []), j]); } });
  a.forEach((t, i) => {
    if (matchedA.has(i)) return;
    const lk = listKey(t);
    const slots = lk ? listB.get(lk) : null;
    if (slots?.length) { const j = slots.shift(); matchedA.set(i, j); matchedB.set(j, i); how.set(i, 'reordered'); }
  });
  // Accepted rewordings, then close paraphrases (same words, edited).
  const rewriteAfter = new Map(rewrites.map((r) => [key(r.before), key(r.after)]));
  a.forEach((t, i) => {
    if (matchedA.has(i)) return;
    const target = rewriteAfter.get(key(t));
    const j = target ? bk.findIndex((k, idx) => k === target && !matchedB.has(idx)) : -1;
    if (j >= 0) { matchedA.set(i, j); matchedB.set(j, i); how.set(i, 'reworded'); }
  });
  a.forEach((t, i) => {
    if (matchedA.has(i)) return;
    let best = -1; let score = 0.6;
    b.forEach((u, j) => { if (!matchedB.has(j)) { const s = similarity(t, u); if (s >= score) { score = s; best = j; } } });
    if (best >= 0) { matchedA.set(i, best); matchedB.set(best, i); how.set(i, 'reworded'); }
  });

  const declared = new Map(omitted.map((o) => [key(o.text), o]));
  const pinned = new Set(keep.map(key));

  // Added lines sit after the master line that precedes them in the tailored copy.
  /** @type {Map<number, string[]>} */
  const addedAfter = new Map();
  let lastA = -1;
  b.forEach((t, j) => {
    if (matchedB.has(j)) { lastA = Math.max(lastA, /** @type {number} */ (matchedB.get(j))); return; }
    addedAfter.set(lastA, [...(addedAfter.get(lastA) ?? []), t]);
  });

  /** @type {DiffRow[]} */
  const rows = [];
  let section = '';
  const pushAdded = (index) => {
    for (const t of addedAfter.get(index) ?? []) {
      rows.push({ status: 'added', text: t, section, flags: /most relevant to this role/i.test(t) ? ['focus line'] : ['not in master'] });
    }
  };
  pushAdded(-1);
  a.forEach((t, i) => {
    if (isHeadingLine(t)) section = t;
    const status = how.get(i);
    if (status) {
      // Reworded and reordered lines show what the tailored copy SAYS, with
      // the master's version alongside.
      const changedText = status === 'reworded' || status === 'reordered';
      const row = { status, text: changedText ? b[/** @type {number} */ (matchedA.get(i))] : t, section, flags: [] };
      if (changedText) Object.assign(row, { before: t });
      rows.push(/** @type {DiffRow} */ (row));
    } else {
      const decl = declared.get(key(t));
      const flags = [];
      if (hasImpact(t)) flags.push('measured result');
      if (decl?.jd_terms?.length) flags.push(`matches ${decl.jd_terms.slice(0, 3).join(', ')}`);
      if (!decl) flags.push(isHeadingLine(t) ? 'section heading' : 'not declared by the tailor');
      rows.push({
        status: 'omitted', text: t, section, flags,
        reason: decl?.reason ?? 'missing from the tailored resume without a recorded reason',
        role: decl?.role ?? '', kept: pinned.has(key(t)),
      });
    }
    pushAdded(i);
  });

  const summary = { same: 0, moved: 0, reordered: 0, reworded: 0, omitted: 0, added: 0 };
  for (const row of rows) summary[row.status] += 1;
  // Worth a second look: an omission with a measured result, a requirement
  // match, or no declared reason, and any line the master never had.
  const flagged = rows.filter((r) => (r.status === 'omitted' && r.flags.length)
    || (r.status === 'added' && r.flags.includes('not in master')));
  return { rows, summary: { ...summary, flagged: flagged.length }, flagged };
}
