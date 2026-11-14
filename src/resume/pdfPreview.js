/** Best-effort, on-demand PDF generation for dashboard resume previews. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { docxToPdfViaChromium, pdfEngine } from './chromiumPdf.js';
import { resumeHtml } from './tailorRunner.js';
import {
  pythonExe, pythonSpawnOptions, pythonTimeoutMs, killProcessTree,
} from './pythonEnv.js';

function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
  return lines[lines.length - 1] ?? '';
}

/**
 * Convert a generated tailored DOCX to a sibling PDF. Existing PDFs are reused.
 * The caller is responsible for validating that both paths are workspace-local.
 */
function officeResumePdf(docxPath, {
  spawnImpl = spawn, env = process.env, timeoutMs = pythonTimeoutMs({ exportPdf: true, baseMs: 15_000 }),
  platform = process.platform, killImpl, root,
} = {}) {
  if (!docxPath || !existsSync(docxPath)) {
    return Promise.resolve({ exported: false, pdfPath: null, reason: 'tailored DOCX was not found' });
  }
  const script = fileURLToPath(new URL('./pdf_export_cli.py', import.meta.url));
  return new Promise((resolve) => {
    let child;
    try {
      // `pythonEnv` is what keeps the docx path intact across the pipe. Without
      // it Python reads this path in the OS code page and looks for a file that
      // does not exist, one byte different from the one Node just verified.
      child = spawnImpl(pythonExe(env, { root, platform }), [script], pythonSpawnOptions(env, platform));
    } catch (err) {
      resolve({ exported: false, pdfPath: null, reason: `preview converter could not start: ${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killProcessTree(child, { platform, killImpl, spawnImpl });
      finish({ exported: false, pdfPath: null, reason: `preview conversion timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    // Stream-decoded (see tailorRunner.invokePython).
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.stdin?.on?.('error', () => { /* EPIPE: reported by 'close' */ });
    child.on('error', (err) => finish({ exported: false, pdfPath: null, reason: `preview conversion failed: ${err.message}` }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(lastJsonLine(stdout));
        finish({
          exported: parsed.exported === true,
          pdfPath: parsed.pdf_path ?? null,
          // The true page count, when Word produced one. The tailor's page
          // budget is an estimate; this is the measured fact.
          pages: Number.isFinite(parsed.pages) ? parsed.pages : null,
          reason: parsed.reason ?? (parsed.exported ? 'ok' : stderr.trim() || 'preview conversion failed'),
        });
      } catch (err) {
        finish({ exported: false, pdfPath: null, reason: `preview converter returned invalid output: ${err.message}` });
      }
    });
    // An early-exiting converter makes the write fail asynchronously on the
    // stream; without a listener that crashes the process ('close' reports it).
    child.stdin?.on?.('error', () => {});
    try {
      child.stdin?.write(JSON.stringify({ docx_path: docxPath }));
      child.stdin?.end();
    } catch (err) {
      finish({ exported: false, pdfPath: null, reason: `preview request failed: ${err.message}` });
    }
  });
}

/**
 * A PDF for a tailored DOCX (the dashboard's preview and download).
 * RESUME_PDF_ENGINE (see chromiumPdf.js): `auto` tries Word/LibreOffice and
 * falls back to Chromium, so a preview exists on every machine; `chromium`
 * uses Chromium only; `office` never uses it. A caller that injects its own
 * process spawner (tests) keeps the converter-only behaviour unless it also
 * passes `chromiumFallback: true`.
 */
export async function ensureResumePdf(docxPath, options = {}) {
  const engine = pdfEngine(options.env ?? process.env);
  const viaChromium = () => docxToPdfViaChromium({
    docxPath,
    toHtml: (p) => (options.resumeHtmlFn ?? resumeHtml)(p, { root: options.root, deps: { env: options.env } }),
    deps: { chromium: options.chromium },
  });
  if (engine === 'chromium') {
    if (!docxPath || !existsSync(docxPath)) return { exported: false, pdfPath: null, reason: 'tailored DOCX was not found' };
    return viaChromium();
  }
  const office = await officeResumePdf(docxPath, options);
  const fallback = options.chromiumFallback ?? !options.spawnImpl;
  if (office.exported || engine === 'office' || !fallback || !docxPath || !existsSync(docxPath)) return office;
  const chromium = await viaChromium();
  return chromium.exported ? chromium : { ...office, reason: `${office.reason}; Chromium: ${chromium.reason}` };
}
