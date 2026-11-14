/**
 * Upload runner.
 *
 * Attaches the tailored resume (and optional cover letter) to the file inputs
 * named in a packet's fill plan, using Playwright's `setInputFiles`. It verifies
 * each file exists before attaching and reports anything it could not resolve as
 * a blocker. It uploads only the artifacts the packet already prepared — it does
 * not fabricate or substitute documents.
 */

import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { documentFormats } from '../apply/fileUpload.js';

/** MIME types an `accept` attribute may name, mapped to file extensions. */
const MIME_EXTENSIONS = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/rtf': ['.rtf'],
  'text/rtf': ['.rtf'],
  'text/plain': ['.txt'],
};

/**
 * Extensions a file input's `accept` attribute allows, or null for "anything"
 * (no attribute, or a wildcard the document formats all satisfy).
 * @param {string} accept
 * @returns {Set<string>|null}
 */
export function acceptedExtensions(accept) {
  const parts = String(accept ?? '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const out = new Set();
  for (const part of parts) {
    if (part === '*/*' || part === 'application/*') return null;
    if (part.startsWith('.')) out.add(part);
    else if (part === 'text/*') out.add('.txt').add('.rtf');
    else for (const ext of MIME_EXTENSIONS[part] ?? []) out.add(ext);
  }
  return out.size ? out : null;
}

/**
 * The file to send to an input: the planned one when the input accepts it,
 * else the same document in a format it does accept (documentFormats), else
 * null with the accepted list for the message.
 */
export function fileForInput(path, accept, { alternates = [], fileExists = existsSync } = {}) {
  const allowed = acceptedExtensions(accept);
  if (!allowed) return { path, substituted: false };
  const formats = [...new Set([...documentFormats(path, { fileExists }), ...alternates.filter((p) => p && fileExists(p))])];
  const fit = formats.find((p) => allowed.has(extname(p).toLowerCase()));
  if (fit) return { path: fit, substituted: fit !== path };
  return { path: null, allowed: [...allowed] };
}

/* c8 ignore start - executes in the browser, not under node coverage */
function slotText(index) {
  const el = document.querySelectorAll('input[type="file"]')[index];
  if (!el) return null;
  // The widest box that still holds only this one file input: where a widget
  // shows the attached file's name (Rippling clears the input itself).
  let box = el;
  for (let up = el.parentElement, depth = 0; up && depth < 6; up = up.parentElement, depth += 1) {
    if (up.querySelectorAll('input[type="file"]').length > 1 || up.tagName === 'FORM') break;
    box = up;
  }
  const titles = Array.from(box.querySelectorAll('[title], [aria-label]'))
    .map((n) => `${n.getAttribute('title') || ''} ${n.getAttribute('aria-label') || ''}`).join(' ');
  return `${box.textContent || ''} ${titles}`.replace(/\s+/g, ' ').trim().slice(0, 3000);
}
/* c8 ignore stop */

async function readSlotText(page, index) {
  if (!page || typeof page.evaluate !== 'function' || !Number.isInteger(index)) return null;
  try { return await page.evaluate(slotText, index); } catch { return null; }
}

const FILE_COUNT = /\b([1-9]\d*)\s+files?\s+(?:selected|attached|uploaded|added)\b/i;
const FILE_REJECTED = /\b(?:isn'?t supported|not supported|unsupported|not (?:an? )?(?:accepted|allowed|valid)|invalid file|too large|exceeds|failed to upload|upload failed)\b/i;

/**
 * Does the slot now SHOW this file? For widgets that read the file and then
 * clear the input (Rippling), the FileList is empty although the file is
 * attached, and the run reported "did not remain attached" for a resume that
 * was on the form (2026-11-12). Evidence, any of:
 *   - the file's name, whole or shortened with an ellipsis ("Priya_Raghunatha...docx");
 *   - a count that went from none to "1 file selected".
 * An error message in the slot always wins.
 */
export function slotShowsFile(before, after, path) {
  const now = String(after ?? '');
  if (!now) return { shown: false };
  if (FILE_REJECTED.test(now) && !FILE_REJECTED.test(String(before ?? ''))) return { shown: false, rejected: true };
  const name = basename(path);
  const lower = now.toLowerCase();
  if (lower.includes(name.toLowerCase())) return { shown: true, how: 'file name shown' };
  const ext = extname(name).toLowerCase();
  const stem = name.slice(0, name.length - ext.length).toLowerCase();
  if (stem.length >= 8) {
    const head = stem.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "Priya_Raghunatha...docx": the ellipsis may swallow the extension's dot.
    const tail = ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (tail && new RegExp(`${head}[^\\s]*?(?:\\.\\.\\.|…)[^\\s]*?\\.?${tail}\\b`, 'i').test(now)) return { shown: true, how: 'shortened file name shown' };
  }
  if (FILE_COUNT.test(now) && !FILE_COUNT.test(String(before ?? ''))) return { shown: true, how: 'file count shown' };
  return { shown: false };
}

/** Wait (briefly) for a widget to show the file it was given. */
async function waitForSlot(page, index, before, path, { timeoutMs = 4000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = slotShowsFile(before, await readSlotText(page, index), path);
    if (result.shown || result.rejected || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Read the browser's live FileList after setInputFiles. A successful API call
 * alone is not enough: custom ATS widgets can immediately clear/reject a file.
 * `verified: null` means the page double does not expose FileList inspection;
 * real Playwright locators do.
 */
export async function verifyUploadAttached(locator, path) {
  if (!locator || typeof locator.evaluate !== 'function') {
    return { verified: null, verificationMethod: 'file-list-unavailable' };
  }
  try {
    const files = await locator.evaluate((input) => Array.from(input.files ?? []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    })));
    const wanted = basename(path).toLowerCase();
    const match = Array.isArray(files) && files.some((file) => String(file?.name ?? '').toLowerCase() === wanted);
    return {
      verified: match,
      verificationMethod: 'input-file-list',
      attachedFileCount: Array.isArray(files) ? files.length : 0,
    };
  } catch (err) {
    return { verified: false, verificationMethod: 'input-file-list', verificationError: err.message };
  }
}

/**
 * What a file input is FOR, judged from the words around it.
 *
 * Cover letter is tested first: "Cover letter (optional, in addition to your
 * resume)" names both, and the slot is the cover letter's. A label naming
 * resume AND cover letter as alternatives ("Resume or cover letter") is
 * ambiguous and returns null.
 *
 * @param {string} text label / aria / nearby text / id / name
 * @returns {'resume'|'coverLetter'|'transcript'|'other'|null}
 */
export function classifyFileInput(text) {
  const t = String(text ?? '').toLowerCase().replace(/[_-]+/g, ' ');
  if (!t.trim()) return null;
  const cover = /\bcover\s*letter\b|\bmotivation(?:al)?\s*letter\b|\bcoverletter\b|\bcover\b/.test(t);
  const resume = /\bresume\b|\brésumé\b|\bcv\b|\bcurriculum\b/.test(t);
  if (cover && resume && /\b(?:resume|cv)\s*(?:\/|or|and)\s*cover|cover\s*letter\s*(?:\/|or|and)\s*(?:resume|cv)\b/.test(t)) return null;
  if (cover) return 'coverLetter';
  if (/\btranscripts?\b/.test(t)) return 'transcript';
  if (resume) return 'resume';
  if (/\b(?:portfolio|writing\s*sample|work\s*sample|certificat\w*|reference|photo|id\s*document|additional\s*(?:file|document)s?)\b/.test(t)) return 'other';
  return null;
}

/* c8 ignore start - executes in the browser, not under node coverage */
function collectFileInputs(hints) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const out = [];
  // A site's chat assistant has its own hidden "Attachment" file input. It is
  // never a form slot, and as the page's only file input it was chosen for the
  // resume; the widget cleared the file and the run reported "did not remain
  // attached" (Oracle Recruiting's email step, 2026-11-13).
  const CHAT_WIDGET = '[class*="oda-chat"], [class*="chatbot" i], [class*="chat-widget" i], [id*="chatbot" i], [id*="chat-widget" i]';
  // `index` stays the input's position among ALL file inputs on the page: the
  // `nth=` selector and the slot reader both count that way.
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  inputs.forEach((el, index) => {
    if (el.closest(CHAT_WIDGET)) return;
    const parts = [];
    // Rippling wraps the input in a dropzone <label> whose own text is only
    // "Drop or select (.doc / .docx / .pdf)"; the field's name ("Résumé",
    // "Cover letter") is on the element that LABEL points at with
    // aria-labelledby. Reading only the label's text left both slots unnamed
    // (2026-11-12, a Rippling posting).
    const referenced = (node) => ['aria-labelledby', 'aria-describedby']
      .flatMap((attr) => (node.getAttribute(attr) || '').split(/\s+/).filter(Boolean))
      .map((id) => text(document.getElementById(id)));
    for (const lab of Array.from(el.labels || [])) parts.push(text(lab), ...referenced(lab));
    parts.push(el.getAttribute('aria-label') || '', ...referenced(el));
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) parts.push(text(legend));
    // Nearest ancestor that holds exactly this one file input: its own label
    // text (current Greenhouse renders "Resume/CV" in a sibling div, and hides
    // the input behind an "Attach" button).
    let box = el.parentElement;
    for (let depth = 0; box && depth < 4; depth += 1, box = box.parentElement) {
      if (box.querySelectorAll('input[type="file"]').length > 1) break;
      const lab = box.querySelector('label, legend, .label, [class*="label"], h3, h4');
      if (lab && text(lab)) { parts.push(text(lab).slice(0, 120)); break; }
    }
    parts.push(el.id || '', el.name || '', el.getAttribute('data-automation-id') || '',
      el.getAttribute('data-testid') || '', el.closest('[id]')?.id || '');
    const matches = [];
    for (const [type, sel] of Object.entries(hints || {})) {
      if (!sel) continue;
      try { if (el.matches(sel)) matches.push(type); } catch { /* not a DOM selector */ }
    }
    out.push({
      index,
      selector: `input[type="file"] >> nth=${index}`,
      accept: el.getAttribute('accept') || '',
      text: parts.filter(Boolean).join(' | ').slice(0, 400),
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      hintFor: matches,
    });
  });
  return { fileInputs: out };
}
/* c8 ignore stop */

/**
 * Every file input on the page with the text that says what it is for.
 * Hidden inputs are included: modern ATS widgets hide the real input behind
 * an "Attach" button. Returns null when the page cannot be inspected (unit
 * doubles), in which case the static selectors are used as before.
 */
export async function discoverFileInputs(page, hints = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    // Wrapped in an object so a page double whose evaluate() answers every
    // call with the same array can never be mistaken for a real inspection.
    const found = (await page.evaluate(collectFileInputs, hints))?.fileInputs;
    if (!Array.isArray(found)) return null;
    return found.map((f) => ({ ...f, kind: classifyFileInput(f.text) }));
  } catch {
    return null;
  }
}

/**
 * Pick the file input for one upload type.
 *
 * WHY. The static selectors were the whole decision, and several are generic
 * (`input[type="file"]` + `.first()`), so on a form whose FIRST file input was
 * the cover-letter slot the resume went into it — and a current Greenhouse
 * form (job-boards.greenhouse.io) matched none of the old `#resume_fieldset`
 * selectors at all. The words around each input now decide; a static selector
 * only breaks ties. An input that is clearly for something else is never used.
 *
 * @param {Array<object>} inputs discoverFileInputs() result
 * @param {string} type 'resume' | 'coverLetter'
 * @param {Set<number>} used indexes already taken by another upload
 * @returns {object|null} the chosen input, or null
 */
export function chooseFileInput(inputs, type, used = new Set()) {
  const free = inputs.filter((i) => !used.has(i.index));
  const labelled = free.filter((i) => i.kind === type);
  if (labelled.length) return labelled.find((i) => i.hintFor.includes(type)) ?? labelled[0];
  // No input says it is for this type. A resume may still go into the ONLY
  // file input on the page when nothing says it is for something else.
  const unlabelled = free.filter((i) => i.kind === null);
  if (type === 'resume' && inputs.length === 1 && unlabelled.length === 1) return unlabelled[0];
  // A static selector may pick an unlabelled input, never a labelled one.
  return unlabelled.find((i) => i.hintFor.includes(type)) ?? null;
}

/**
 * @param {object} page Playwright page (or compatible)
 * @param {object} fillPlan packet.fillPlan ({ uploads: [{type, path, selector}] })
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] resolve only; do not attach
 * @param {Function} [options.fileExists=existsSync]
 * @returns {Promise<{ uploaded: object[], blockers: string[], skipped: object[] }>}
 */
export async function uploadFiles(page, fillPlan = {}, { dryRun = false, fileExists = existsSync } = {}) {
  const uploads = Array.isArray(fillPlan.uploads) ? fillPlan.uploads : [];
  const uploaded = [];
  const blockers = [];
  const skipped = [];

  const hints = Object.fromEntries(uploads.filter((u) => u.selector).map((u) => [u.type, u.selector]));
  const discovered = await discoverFileInputs(page, hints);
  const used = new Set();

  for (const u of uploads) {
    if (!u.path) {
      skipped.push({ type: u.type, reason: 'no file path' });
      continue;
    }
    if (!fileExists(u.path)) {
      blockers.push(`${u.type}: file not found at ${u.path}`);
      continue;
    }
    if (discovered && discovered.length) {
      const chosen = chooseFileInput(discovered, u.type, used);
      if (!chosen) {
        const message = `${u.type}: upload input not found (no file input on this page is labelled for it)`;
        if (u.required === false) skipped.push({ type: u.type, path: u.path, reason: message });
        else blockers.push(message);
        continue;
      }
      used.add(chosen.index);
      // Send a format this input accepts: the planned file, or the same
      // document in another format (a .txt cover letter was sent to a slot
      // that takes only .doc/.docx/.pdf, and the form rejected it).
      const file = fileForInput(u.path, chosen.accept, { alternates: u.alternates ?? [], fileExists });
      if (!file.path) {
        const message = `${u.type}: this form takes only ${file.allowed.join(', ')} files, and ${basename(u.path)} is not available in any of those formats`;
        if (u.required === false) skipped.push({ type: u.type, path: u.path, reason: message });
        else blockers.push(message);
        continue;
      }
      if (dryRun) {
        skipped.push({ type: u.type, path: file.path, selector: chosen.selector, reason: 'dry run' });
        continue;
      }
      try {
        const before = await readSlotText(page, chosen.index);
        const locator = page.locator(chosen.selector);
        await locator.setInputFiles(file.path);
        let verification = await verifyUploadAttached(locator, file.path);
        if (verification.verified === false) {
          // The widget may have read the file and cleared its input; what
          // the slot SHOWS then decides (see slotShowsFile).
          const slot = await waitForSlot(page, chosen.index, before, file.path);
          if (slot.shown) verification = { verified: true, verificationMethod: `upload widget: ${slot.how}` };
          else if (slot.rejected) verification = { ...verification, verified: false, verificationMethod: 'upload widget: file rejected' };
        }
        uploaded.push({
          type: u.type, path: file.path, selector: chosen.selector,
          matchedBy: chosen.kind === u.type ? 'label' : 'selector-hint', ...verification,
          ...(file.substituted ? { plannedPath: u.path, formatNote: `sent ${extname(file.path)} because this form does not take ${extname(u.path)}` } : {}),
        });
        if (verification.verified === false) {
          blockers.push(`${u.type}: upload did not remain attached after selection`);
        }
      } catch (err) {
        blockers.push(`${u.type}: upload failed (${err.message})`);
      }
      continue;
    }
    if (discovered && discovered.length === 0 && u.selector) {
      const message = `${u.type}: upload input not found (${u.selector})`;
      if (u.required === false) skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: message });
      else blockers.push(message);
      continue;
    }
    if (!u.selector) {
      const message = `${u.type}: no upload selector resolved`;
      if (u.required === false) skipped.push({ type: u.type, path: u.path, reason: message });
      else blockers.push(message);
      continue;
    }
    let count;
    try {
      count = await page.locator(u.selector).count();
    } catch {
      count = 0;
    }
    if (count < 1) {
      const message = `${u.type}: upload input not found (${u.selector})`;
      if (u.required === false) skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: message });
      else blockers.push(message);
      continue;
    }
    if (dryRun) {
      skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: 'dry run' });
      continue;
    }
    try {
      const locator = page.locator(u.selector).first();
      await locator.setInputFiles(u.path);
      const verification = await verifyUploadAttached(locator, u.path);
      uploaded.push({ type: u.type, path: u.path, selector: u.selector, ...verification });
      if (verification.verified === false) {
        blockers.push(`${u.type}: upload did not remain attached after selection`);
      }
    } catch (err) {
      blockers.push(`${u.type}: upload failed (${err.message})`);
    }
  }

  return { uploaded, blockers, skipped };
}
