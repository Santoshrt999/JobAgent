/**
 * Grounded resume rewriting (P1-2).
 *
 * Off unless BOTH LLM_ASSIST is on and RESUME_REWRITE=suggest. Then, for one
 * job:
 *   1. the master resume's bullets become citable units (tailor.py
 *      master_units), each with the role it belongs to;
 *   2. the model (task `rewrite-bullets`) proposes rewordings that bring out
 *      what the posting asks for, citing the unit ids each one relies on;
 *   3. every proposal goes through the deterministic claim verifier
 *      (claimVerifier.js): numbers, named things and ownership must be backed
 *      by the CITED master-resume units or the profile, never by the posting;
 *   4. the person sees each verified proposal next to the original and accepts
 *      or rejects it. Refused proposals are shown with the reason and cannot be
 *      accepted;
 *   5. only accepted rewrites reach the tailor, which replaces exactly those
 *      bullets and still checks every other unit byte-for-byte. Accepting or
 *      rejecting after a packet was approved sends the packet back for review.
 *
 * Proposals and decisions are append-only `application_events` rows of type
 * `resume_rewrites` (the newest row is the current state): no schema change.
 */
import { createHash, randomUUID } from 'node:crypto';

import { llmSettings } from '../llm/client.js';
import { runTask, SYSTEM_UNTRUSTED_RULE } from '../llm/task.js';
import { profileTerms, verifyRewrite } from './claimVerifier.js';
import { keywordsForJob, readMasterUnits, vocabularyFromScoring } from './tailorRunner.js';
import { extractJdRequirements } from '../llm/jdRequirements.js';

export const REWRITE_EVENT = 'resume_rewrites';
/** Most bullets sent in one request (cost and latency ceiling). */
const MAX_BULLETS = 40;

/** Is rewriting switched on? Returns { enabled, reason }. */
export function rewriteSettings(env = process.env, { root = null } = {}) {
  const llm = llmSettings(env, { root });
  const mode = String(env.RESUME_REWRITE ?? 'off').trim().toLowerCase();
  if (mode !== 'suggest') return { enabled: false, reason: 'Rewrite suggestions are off (set RESUME_REWRITE=suggest in .env).', llm };
  if (!llm.enabled) return { enabled: false, reason: `Rewrite suggestions need the LLM assist: ${llm.reason}`, llm };
  return { enabled: true, reason: null, llm };
}

const SYSTEM = [
  'You reword resume bullets so their relevance to a job is clearer, without changing what they claim.',
  '',
  'Rules:',
  '1. Use ONLY facts stated in the bullet itself or in other bullets of the SAME role. Cite every bullet you',
  '   rely on in "evidence" (always include the bullet being rewritten).',
  '2. Never add a number, percentage, money amount, team size, tool, technology, employer, product,',
  '   certification or degree that is not written in the cited bullets.',
  '3. A requirement phrase from the job is a hint about what to bring forward. It is NOT evidence. If the',
  '   cited bullets do not mention it, do not mention it.',
  '4. Never strengthen ownership: "contributed" stays "contributed"; "built" never becomes "led" or "owned".',
  '5. Keep about the same length (between 0.7 and 1.3 times the original).',
  '6. Skip a bullet when rewording would not make it more relevant. Fewer, safer rewrites are better.',
  `7. ${SYSTEM_UNTRUSTED_RULE}`,
  '',
  'Respond with JSON only: {"rewrites":[{"unitId":"u3","rewrite":"...","evidence":["u3","u4"]}]}',
].join('\n');

/** The rewrite task, versioned: bump on any prompt or schema change. */
export const REWRITE_TASK = Object.freeze({
  name: 'rewrite-bullets',
  version: 1,
  system: SYSTEM,
  maxTokens: 6000,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['rewrites'],
    properties: {
      rewrites: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['unitId', 'rewrite', 'evidence'],
          properties: {
            unitId: { type: 'string' },
            rewrite: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  buildUser: ({ bullets, requirements }) => [
    'JOB REQUIREMENT PHRASES (hints only, not evidence):',
    requirements.length ? requirements.map((r) => `- ${r}`).join('\n') : '- (none found)',
    '',
    'RESUME BULLETS, grouped by role:',
    ...groupByRole(bullets).flatMap(([role, items]) => [
      `ROLE: ${role ?? '(no role heading)'}`,
      ...items.map((u) => `${u.id}: ${u.text}`),
      '',
    ]),
  ].join('\n'),
  postValidate: (data, { bullets }) => {
    const ids = new Set(bullets.map((u) => u.id));
    return (data.rewrites ?? [])
      .filter((r) => !ids.has(r.unitId))
      .map((r) => `unitId ${r.unitId} is not one of the bullets you were given`);
  },
});

function groupByRole(units) {
  const groups = new Map();
  for (const u of units) {
    if (!groups.has(u.role ?? null)) groups.set(u.role ?? null, []);
    groups.get(u.role ?? null).push(u);
  }
  return [...groups.entries()];
}

function masterFingerprint(units) {
  return createHash('sha256').update(units.map((u) => `${u.id}\u0000${u.text}`).join('\u0001')).digest('hex').slice(0, 16);
}

/** The current rewrite record for a job (newest event), or null. */
export function latestRewrites(db, jobId) {
  const rows = (db.listEvents?.(jobId) ?? []).filter((e) => e.event_type === REWRITE_EVENT);
  const last = rows[rows.length - 1];
  if (!last) return null;
  try {
    return typeof last.metadata === 'string' ? JSON.parse(last.metadata) : last.metadata;
  } catch {
    return null;
  }
}

function saveRewrites(db, jobId, record, message) {
  db.insertEvent({
    id: randomUUID(), job_id: jobId, event_type: REWRITE_EVENT, message, metadata: JSON.stringify(record),
  });
  return record;
}

/**
 * Ask for, verify and record rewrite proposals for one job.
 * @returns {Promise<{ ok: boolean, disabled?: boolean, error?: string, record?: object }>}
 */
export async function proposeRewrites({ db, job, config, env = process.env, now = new Date(), deps = {} }) {
  const root = config?.root ?? null;
  const settings = rewriteSettings(env, { root });
  if (!settings.enabled) return { ok: false, disabled: true, error: settings.reason };

  let units;
  try {
    units = await (deps.readMasterUnitsFn ?? readMasterUnits)({ root, deps });
  } catch (err) {
    return { ok: false, error: `Could not read the master resume: ${err.message}` };
  }
  const bullets = units.filter((u) => u.kind === 'bullet').slice(0, MAX_BULLETS);
  if (!bullets.length) return { ok: false, error: 'The master resume has no bullet points to reword.' };

  // Requirement phrases: verified verbatim against the posting, else the
  // scoring keywords. Either way they are hints, never evidence.
  let requirements = [];
  try {
    const extracted = await (deps.extractJdRequirementsFn ?? extractJdRequirements)({
      jdText: job.jd_text ?? job.jdText ?? '', title: job.title ?? '', root, env,
    }, deps);
    requirements = extracted?.phrases ?? [];
  } catch { /* hints are optional */ }
  if (!requirements.length) requirements = keywordsForJob({ matchedKeywords: safeList(job.matched_keywords) });

  const result = await runTask(REWRITE_TASK, { bullets, requirements: requirements.slice(0, 40) },
    { settings: settings.llm, deps });
  if (!result.ok) return { ok: false, error: `No suggestions: ${result.error}` };

  const unitMap = new Map(units.map((u) => [u.id, u]));
  const profile = profileTerms(config?.candidate ?? {});
  const vocabulary = [...new Set([...vocabularyFromScoring(config?.scoring ?? {}), ...requirements])]
    .map((t) => String(t).toLowerCase());
  const seen = new Set();
  const items = [];
  for (const proposal of result.data.rewrites) {
    if (seen.has(proposal.unitId)) continue;
    seen.add(proposal.unitId);
    const unit = unitMap.get(proposal.unitId);
    const verdict = verifyRewrite({ unit, rewrite: proposal.rewrite, evidenceIds: proposal.evidence, units: unitMap, profile, vocabulary });
    items.push({
      unitId: proposal.unitId,
      role: unit?.role ?? null,
      original: unit?.text ?? '',
      rewrite: String(proposal.rewrite ?? '').trim(),
      evidence: verdict.evidence,
      evidenceText: verdict.evidence.map((id) => ({ id, text: unitMap.get(id)?.text ?? '' })),
      status: verdict.ok ? 'verified' : 'refused',
      reasons: verdict.reasons,
      decision: null,
    });
  }

  const record = {
    task: result.provenance.task, provider: result.provenance.provider, model: result.provenance.model,
    createdAt: now.toISOString(), master: masterFingerprint(units), items,
  };
  const verified = items.filter((i) => i.status === 'verified').length;
  saveRewrites(db, job.id, record, `${items.length} rewrite suggestion(s), ${verified} verified against your resume`);
  return { ok: true, record };
}

function safeList(value) {
  if (Array.isArray(value)) return value;
  try { const v = JSON.parse(value ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Record a person's decision: one item ({ unitId, decision: 'accept'|'reject'|null })
 * or every verified item at once ({ acceptAllVerified: true }). Refused items
 * can never be accepted. Returns the new record and whether anything changed.
 */
export function decideRewrites(db, jobId, { unitId = null, decision = null, acceptAllVerified = false } = {}) {
  const current = latestRewrites(db, jobId);
  if (!current) throw Object.assign(new Error('There are no rewrite suggestions for this job yet.'), { statusCode: 404 });
  if (decision !== null && !['accept', 'reject'].includes(decision)) {
    throw Object.assign(new Error('decision must be accept, reject or null'), { statusCode: 400 });
  }
  let changed = false;
  const items = current.items.map((item) => {
    const target = acceptAllVerified ? item.status === 'verified' : item.unitId === unitId;
    if (!target) return item;
    const next = acceptAllVerified ? 'accept' : decision;
    if (next === 'accept' && item.status !== 'verified') {
      throw Object.assign(new Error('A refused suggestion cannot be accepted: it is not backed by your resume.'), { statusCode: 400 });
    }
    if (item.decision === next) return item;
    changed = true;
    return { ...item, decision: next };
  });
  if (!acceptAllVerified && !current.items.some((i) => i.unitId === unitId)) {
    throw Object.assign(new Error(`No suggestion for ${unitId}.`), { statusCode: 404 });
  }
  const record = { ...current, items, decidedAt: new Date().toISOString() };
  if (changed) {
    const accepted = items.filter((i) => i.decision === 'accept').length;
    saveRewrites(db, jobId, record, `${accepted} rewrite(s) accepted`);
  }
  return { record, changed };
}

/** The accepted, verified rewrites for a job, as the tailor expects them. */
export function acceptedRewritesFor(db, jobId) {
  const current = latestRewrites(db, jobId);
  if (!current) return [];
  return current.items
    .filter((i) => i.decision === 'accept' && i.status === 'verified')
    .map((i) => ({ original: i.original, rewrite: i.rewrite, evidence: i.evidence, task: current.task }));
}

const REFINE_SYSTEM = [
  'You change resume bullets the way the candidate asks, without changing what they claim.',
  '',
  'Rules:',
  '1. Edit only bullets the request is about. Use only facts in those bullets or other bullets of the SAME role,',
  '   and cite every bullet you rely on in "evidence" (always including the edited one).',
  '2. Never add a number, tool, technology, employer, product, certification or achievement that is not in the',
  '   cited bullets, and never strengthen ownership.',
  '3. If the request needs a fact the bullets do not contain (for example "say I used Kafka" when no bullet',
  '   mentions Kafka), make no edit for it and explain in "declined" what is missing.',
  '4. Keep about the same length as each original.',
  '',
  'Respond with JSON only: {"edits":[{"unitId":"u3","rewrite":"...","evidence":["u3"]}],"declined":null}',
].join('\n');

/** A refine request, versioned (P2-2). */
export const REFINE_TASK = Object.freeze({
  name: 'refine',
  version: 1,
  system: REFINE_SYSTEM,
  maxTokens: 4000,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['edits', 'declined'],
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['unitId', 'rewrite', 'evidence'],
          properties: { unitId: { type: 'string' }, rewrite: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
        },
      },
      declined: { type: ['string', 'null'] },
    },
  },
  buildUser: ({ instruction, bullets }) => [
    `THE CANDIDATE ASKS: ${String(instruction).slice(0, 600)}`,
    '',
    'RESUME BULLETS, grouped by role:',
    ...groupByRole(bullets).flatMap(([role, items]) => [`ROLE: ${role ?? '(no role heading)'}`, ...items.map((u) => `${u.id}: ${u.text}`), '']),
  ].join('\n'),
  postValidate: (data, { bullets }) => {
    const ids = new Set(bullets.map((u) => u.id));
    return (data.edits ?? []).filter((e) => !ids.has(e.unitId)).map((e) => `unitId ${e.unitId} is not one of the bullets you were given`);
  },
});

/**
 * Apply a plain-language request ("make the Power BI bullet lead with the
 * outcome") as verified suggestions, merged into the job's rewrite record.
 * @returns {Promise<{ ok: boolean, error?: string, disabled?: boolean, record?: object, declined?: string|null }>}
 */
export async function refineRewrites({ db, job, config, instruction, env = process.env, now = new Date(), deps = {} }) {
  const text = String(instruction ?? '').trim();
  if (!text) return { ok: false, error: 'Say what you would like changed.' };
  const root = config?.root ?? null;
  const settings = rewriteSettings(env, { root });
  if (!settings.enabled) return { ok: false, disabled: true, error: settings.reason };
  let units;
  try {
    units = await (deps.readMasterUnitsFn ?? readMasterUnits)({ root, deps });
  } catch (err) {
    return { ok: false, error: `Could not read the master resume: ${err.message}` };
  }
  const bullets = units.filter((u) => u.kind === 'bullet').slice(0, MAX_BULLETS);
  const result = await runTask(REFINE_TASK, { instruction: text, bullets }, { settings: settings.llm, deps });
  if (!result.ok) return { ok: false, error: `Could not apply that: ${result.error}` };

  const unitMap = new Map(units.map((u) => [u.id, u]));
  const profile = profileTerms(config?.candidate ?? {});
  const vocabulary = vocabularyFromScoring(config?.scoring ?? {}).map((t) => String(t).toLowerCase());
  const fresh = result.data.edits.map((edit) => {
    const unit = unitMap.get(edit.unitId);
    const verdict = verifyRewrite({ unit, rewrite: edit.rewrite, evidenceIds: edit.evidence, units: unitMap, profile, vocabulary });
    return {
      unitId: edit.unitId, role: unit?.role ?? null, original: unit?.text ?? '', rewrite: String(edit.rewrite ?? '').trim(),
      evidence: verdict.evidence, evidenceText: verdict.evidence.map((id) => ({ id, text: unitMap.get(id)?.text ?? '' })),
      status: verdict.ok ? 'verified' : 'refused', reasons: verdict.reasons, decision: null, source: 'refine', request: text,
    };
  });
  const current = latestRewrites(db, job.id);
  const replaced = new Set(fresh.map((i) => i.unitId));
  const items = [...(current?.items ?? []).filter((i) => !replaced.has(i.unitId)), ...fresh];
  const record = {
    task: current?.task ?? REFINE_TASK.name, provider: result.provenance.provider, model: result.provenance.model,
    createdAt: current?.createdAt ?? now.toISOString(), master: masterFingerprint(units), items,
    refinements: [...(current?.refinements ?? []), { at: now.toISOString(), request: text, task: result.provenance.task, edits: fresh.length, declined: result.data.declined ?? null }],
  };
  saveRewrites(db, job.id, record, `refine request: ${fresh.length} suggestion(s)${result.data.declined ? ', part declined' : ''}`);
  return { ok: true, record, declined: result.data.declined ?? null };
}
