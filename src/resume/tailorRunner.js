/**
 * Resume tailoring runner (Node -> Python bridge).
 *
 * Invokes the deterministic Python tailor (src/resume/tailor_cli.py) in a child
 * process, passing the job + the keywords to emphasize, and returns a structured
 * result. The Python side opens the master resume READ-ONLY and writes a new
 * per-job DOCX under resumes/output — the master is never modified.
 *
 * Failure handling is graceful by design: if Python is unavailable, the master
 * resume is missing, or tailoring errors out, this returns a result with
 * `tailored: false`, a fallback to the master resume path, and a human-readable
 * warning. The caller can then attach that warning to the packet rather than
 * crashing the run.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractJdRequirements } from '../llm/jdRequirements.js';
import {
  pythonExe, pythonSpawnOptions, pythonTimeoutMs, killProcessTree,
} from './pythonEnv.js';
import { masterResumeFile } from '../profile/workspace.js';
import { docxToPdfViaChromium, pdfEngine } from './chromiumPdf.js';

/**
 * The active person's master resume (never overwritten by tailoring). Each
 * workspace has its own — see src/profile/workspace.js.
 */
export function masterResumePath(root) {
  return masterResumeFile(root);
}

/** Default tailored-output directory. */
export function outputDir(root) {
  return join(root, 'resumes', 'output');
}

/** Build the keyword set to emphasize from a score result. */
export function keywordsForJob(score = {}) {
  const matched = Array.isArray(score.matchedKeywords) ? score.matchedKeywords : [];
  const missing = Array.isArray(score.missingKeywords) ? score.missingKeywords : [];
  // De-dupe while preserving order; matched first (they are most relevant).
  const seen = new Set();
  const out = [];
  for (const kw of [...matched, ...missing]) {
    const key = String(kw).toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/**
 * Merge extra terms into a term list, de-duplicated case-insensitively and
 * preserving the original ordering/display form of the existing entries.
 * @param {string[]} base
 * @param {string[]} extra
 * @returns {string[]}
 */
export function mergeTerms(base = [], extra = []) {
  const seen = new Set();
  const out = [];
  for (const term of [...base, ...extra]) {
    const key = String(term ?? '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * The vocabulary the JD-requirement tiering is grounded in.
 *
 * It reads `scoring.marketSkills` FIRST — the skill list of the active
 * profile's own role families, written by activating a profile — and then the
 * legacy `scoring.keywords` lists.
 *
 * Reading only `scoring.keywords` made this the last data-engineering-shaped
 * component in the tailoring path: that file ships as one stack's word list, so
 * the ATS report could only tier terms a data engineer would recognize. A nurse
 * or an accountant got a requirements analysis that found none of their
 * profession's requirements — not because the JD lacked them, but because
 * nothing was looking. `marketSkills` is the same candidate-independent
 * market vocabulary the gap analysis was already moved onto (see
 * `computeMissing`), so the two now agree about what a skill even is.
 *
 * Both sources are kept: a user who has tuned `scoring.keywords` by hand keeps
 * every term they added.
 *
 * @param {object} [scoring] parsed config/scoring.json
 * @returns {string[]}
 */
export function vocabularyFromScoring(scoring = {}) {
  const kw = scoring.keywords ?? {};
  const seen = new Set();
  const out = [];
  const add = (term) => {
    const key = String(term ?? '').toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  for (const term of Array.isArray(scoring.marketSkills) ? scoring.marketSkills : []) add(term);
  for (const list of Object.values(kw)) {
    if (!Array.isArray(list)) continue;
    for (const term of list) add(term);
  }
  return out;
}

/**
 * The page budget the tailor works to. Unset means the two-page default; 0
 * means never omit a bullet to fit; anything else is clamped to 1 to 6.
 * @param {unknown} value
 * @returns {number}
 */
export function pageBudget(value) {
  if (value === undefined || value === null || value === '') return 2;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 2;
  return n <= 0 ? 0 : Math.min(6, n);
}

/**
 * Run the Python tailor for one job.
 *
 * @param {object} args
 * @param {object} args.job normalized job ({company, title, jdText})
 * @param {object} args.score scoreJob result (matched/missing keywords)
 * @param {object} args.config loadConfig bundle (uses config.root, humanizerPatterns)
 * @param {object} [args.options]
 * @param {boolean} [args.options.exportPdf=false] also export a PDF (best-effort)
 * @param {boolean} [args.options.addSummaryLine=false]
 * @param {boolean} [args.options.enableRewrites=false] recorded but intentionally disabled by Python
 * @param {object} [args.deps]
 * @param {Function} [args.deps.spawnImpl] override child_process.spawn (testing)
 * @param {NodeJS.ProcessEnv} [args.deps.env]
 * @param {number} [args.deps.timeoutMs=60000]
 * @returns {Promise<{
 *   tailored: boolean, output_path: string, pdf_path: string|null,
 *   audit: object|null, emphasized: number|null, summaryLine: string|null,
 *   warning: string|null, usedFallback: boolean
 * }>}
 */
export async function tailorResumeForJob({ job, score, config, options = {}, deps = {} } = {}) {
  const root = config.root;
  const master = masterResumePath(root);
  const fallback = {
    tailored: false,
    output_path: master,
    pdf_path: null,
    pageCount: null,
    pdfWarning: null,
    audit: null,
    emphasized: null,
    summaryLine: null,
    changes: [],
    gaps: [],
    qualifications: {},
    selectedContent: {},
    rewritePolicy: null,
    invariants: null,
    limitations: [],
    validation: null,
    atsReport: null,
    warning: null,
    usedFallback: true,
    llmRequirements: null,
  };

  if (!existsSync(master)) {
    return { ...fallback, warning: `master resume not found at ${master}; cannot tailor` };
  }

  // ── Optional, grounded requirement expansion ──────────────────────────────
  // The deterministic vocabulary in config/scoring.json cannot cover every
  // employer's phrasing. When LLM assist is enabled, the model READS the posting
  // and proposes requirement phrases; each one is verified to appear verbatim in
  // that posting before it is accepted, then handed to the same deterministic
  // tailor. It only widens what we can RECOGNIZE in the JD — resume content
  // stays evidence-gated, so no claim can be added or reworded.
  //
  // Entirely best-effort: disabled, offline, or malformed all fall through to
  // the deterministic path with a note in the audit trail.
  let llmRequirements = null;
  if (options.llmAssist !== false) {
    try {
      const extractFn = deps.extractJdRequirementsFn ?? extractJdRequirements;
      llmRequirements = await extractFn({
        jdText: job.jdText ?? '',
        title: job.title ?? '',
        root,
        env: deps.env ?? process.env,
      }, deps);
    } catch (err) {
      llmRequirements = { ok: false, phrases: [], provenance: { skipped: `llm assist error: ${err.message}` } };
    }
  }
  const llmPhrases = Array.isArray(llmRequirements?.phrases) ? llmRequirements.phrases : [];

  const request = {
    master_path: master,
    output_dir: options.outputDir ?? outputDir(root),
    output_filename: options.outputFilename ?? null,
    job: {
      company: job.company ?? '',
      title: job.title ?? '',
      jd_text: job.jdText ?? '',
    },
    // Verified JD requirements join the emphasis set. The Python tailor still
    // only emphasizes a term when the MASTER RESUME already contains it, and
    // reports the rest as gaps — that contract is unchanged.
    keywords: mergeTerms(keywordsForJob(score), llmPhrases),
    // Vocabulary + ATS rules drive the deterministic ATS readiness report.
    vocabulary: mergeTerms(vocabularyFromScoring(config.scoring), llmPhrases),
    // Grounded requirement classification. Only phrases verified verbatim
    // against this posting are sent, and Python applies them to ORDERING
    // priority only — never to resume content.
    ...(llmRequirements?.ok
      ? {
          llm_requirements: {
            required: llmRequirements.required ?? [],
            preferred: llmRequirements.preferred ?? [],
          },
        }
      : {}),
    evidence_aliases: config.scoring?.evidenceAliases ?? {},
    ats_config: config.atsResume ?? {},
    patterns: config.humanizerPatterns ?? {},
    add_summary_line: options.addSummaryLine === true,
    enable_rewrites: options.enableRewrites === true,
    // RESUME_PDF_ENGINE=chromium: no Word/LibreOffice attempt; Chromium below.
    export_pdf: options.exportPdf === true && pdfEngine(deps.env ?? process.env) !== 'chromium',
    // Hard length target. The tailor omits whole low-relevance bullets from the
    // oldest roles to hit it; it never shortens or rewrites a claim.
    // 0 (config.runtime.resumeMaxPages) means "never omit anything to fit".
    max_pages: pageBudget(options.maxPages),
    // Bullets a person accepted after each rewrite was verified against cited
    // master-resume evidence (src/resume/rewrites.js). Empty = no rewriting.
    ...(Array.isArray(options.acceptedRewrites) && options.acceptedRewrites.length
      ? { accepted_rewrites: options.acceptedRewrites }
      : {}),
    // Bullets the person pinned for this job ("Keep it" in the comparison):
    // the page fit never omits them.
    ...(Array.isArray(options.keepBullets) && options.keepBullets.length
      ? { keep_bullets: options.keepBullets.map(String) }
      : {}),
  };

  let response;
  try {
    response = await invokePython(request, { ...deps, root });
  } catch (err) {
    return { ...fallback, warning: `resume tailoring failed: ${err.message}` };
  }

  if (!response || response.ok !== true) {
    return { ...fallback, warning: `resume tailoring failed: ${response?.error ?? 'unknown error'}` };
  }

  // The path Python reports back is where the file REALLY went. If it does not
  // exist from Node's side, the two processes disagreed about the bytes in a
  // filename — which is exactly how "84.51°" resumes were written into a
  // directory called "84.51Â°" while their packet JSON went to the right one,
  // and nothing noticed for weeks. The pipe is UTF-8 now (see pythonEnv.js);
  // this is the assertion that says so on every single run, so the next variant
  // of this bug surfaces immediately instead of silently splitting a packet.
  if (response.output_path && !existsSync(response.output_path)) {
    return {
      ...fallback,
      warning: 'resume tailoring reported a file that is not there: '
        + `${response.output_path}. This usually means the Node/Python text `
        + 'encodings disagree about a non-ASCII character in the employer name.',
    };
  }

  // No PDF from Word or LibreOffice: print one with Chromium, which ships with
  // JobAgent, so a PDF always exists (P2-3). RESUME_PDF_ENGINE=office opts out.
  if (options.exportPdf === true && !response.pdf_path && response.output_path
      && pdfEngine(deps.env ?? process.env) !== 'office' && deps.chromiumPdf !== false) {
    const viaChromium = await docxToPdfViaChromium({
      docxPath: response.output_path,
      toHtml: (p) => (deps.resumeHtmlFn ?? resumeHtml)(p, { root, deps }),
      deps: { chromium: deps.chromium },
    });
    if (viaChromium.exported) {
      response.pdf_path = viaChromium.pdfPath;
      response.page_count = viaChromium.pages;
      response.pdf_result = { exported: true, pdf_path: viaChromium.pdfPath, pages: viaChromium.pages, reason: viaChromium.reason };
    } else {
      response.pdf_result = { ...(response.pdf_result ?? {}), reason: `${response.pdf_result?.reason ?? 'no converter'}; Chromium: ${viaChromium.reason}` };
    }
  }

  return {
    tailored: true,
    output_path: response.output_path,
    pdf_path: response.pdf_path ?? null,
    // Measured page count when a PDF was rendered; null when Word was not
    // available and only the tailor's estimate exists.
    pageCount: Number.isFinite(response.page_count) ? response.page_count : null,
    pdfWarning: options.exportPdf === true && response.pdf_path == null
      ? (response.pdf_result?.reason ?? 'PDF preview could not be generated')
      : null,
    audit: response.audit ?? null,
    emphasized: response.emphasized ?? null,
    summaryLine: response.summary_line ?? null,
    // Structured, evidence-backed record of every tailoring action (skill
    // reorders with before/after, emphasis evidence, focus line) plus the JD
    // requirements the resume does NOT support (reported, never inserted).
    changes: response.changes ?? [],
    gaps: response.gaps ?? [],
    qualifications: response.qualifications ?? {},
    selectedContent: response.selected_content ?? {},
    rewritePolicy: response.rewrite_policy ?? null,
    invariants: response.invariants ?? null,
    limitations: response.limitations ?? [],
    validation: response.validation ?? null,
    atsReport: response.ats_report ?? null,
    // Audit trail for the optional grounded requirement expansion: which
    // phrases were verified against the posting, and which were rejected.
    llmRequirements: llmRequirements
      ? {
          ok: llmRequirements.ok === true,
          verified: llmRequirements.phrases ?? [],
          required: llmRequirements.required ?? [],
          preferred: llmRequirements.preferred ?? [],
          rejected: llmRequirements.rejected ?? [],
          provenance: llmRequirements.provenance ?? null,
        }
      : null,
    warning: null,
    usedFallback: false,
  };
}

/**
 * The master resume's paragraphs as citable units (tailor.py master_units):
 * [{ id, text, kind: 'bullet'|'role'|'section'|'paragraph', role }]. Read-only.
 */
export async function readMasterUnits({ root, deps = {} } = {}) {
  const master = masterResumePath(root);
  if (!existsSync(master)) throw new Error(`master resume not found at ${master}`);
  const response = await invokePython({ mode: 'units', master_path: master }, { ...deps, root });
  if (!response?.ok || !Array.isArray(response.units)) throw new Error(response?.error ?? 'could not read the master resume');
  return response.units;
}

/** A resume DOCX as ATS-safe HTML plus its paragraph texts (P2-3). */
export async function resumeHtml(docxPath, { root, deps = {} } = {}) {
  const response = await invokePython({ mode: 'html', docx_path: docxPath }, { ...deps, root });
  if (!response?.ok) throw new Error(response?.error ?? 'could not render the resume');
  return { html: response.html, texts: response.texts ?? [] };
}

/** Write a cover letter's text as a plain .docx (P1-3). Resolves the path. */
export async function writeLetterDocx({ text, path, root, deps = {} } = {}) {
  const response = await invokePython({ mode: 'letter_docx', text, path }, { ...deps, root });
  if (!response?.ok) throw new Error(response?.error ?? 'could not write the cover letter document');
  return response.path;
}

/** Spawn the python CLI, feed it the request JSON, and parse its JSON reply. */
function invokePython(request, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  // Longer than Python's own PDF conversion limits when a PDF is requested,
  // so Python reports "conversion timed out" itself instead of Node killing a
  // healthy tailor mid-export and discarding the DOCX it already wrote.
  const timeoutMs = deps.timeoutMs ?? pythonTimeoutMs({ exportPdf: request.export_pdf === true });
  const script = scriptPath();

  return new Promise((resolve, reject) => {
    let child;
    try {
      // The request carries the output directory, which is derived from the
      // company name. Without a UTF-8 pipe the tailor CREATES the mangled
      // directory and writes the resume into it — see pythonEnv.js.
      child = spawnImpl(pythonExe(env, { root: deps.root, platform }), [script], pythonSpawnOptions(env, platform));
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child, { platform, killImpl: deps.killImpl, spawnImpl });
      reject(new Error(`python tailor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Decode as a STREAM: `chunk.toString()` per chunk split any multi-byte
    // character that straddled two chunks into two U+FFFD — in the JSON that
    // carries file paths, so "84.51°" came back as "84.51\uFFFD\uFFFD".
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.trim();
      if (!text) {
        reject(new Error(`python tailor produced no output${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(lastJsonLine(text)));
      } catch (err) {
        reject(new Error(`could not parse python output: ${err.message}`));
      }
    });

    // A Python that exits before reading stdin (bad interpreter, import error)
    // makes the write fail with EPIPE as an 'error' EVENT, not a throw — and an
    // unhandled stream error crashes the whole Node process. The 'close'
    // handler above already reports what Python printed.
    child.stdin?.on?.('error', () => {});
    try {
      child.stdin?.write(JSON.stringify(request));
      child.stdin?.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}

/** Absolute path to the python CLI script. */
function scriptPath() {
  // fileURLToPath handles Windows drive letters AND percent-encoded characters
  // (spaces, unicode) — the old .pathname hack broke when the repo lived under
  // a path with a space, silently falling back to the untailored master resume.
  return fileURLToPath(new URL('./tailor_cli.py', import.meta.url));
}

/** Tolerate banner/log lines: parse the last non-empty line as JSON. */
function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1];
}
