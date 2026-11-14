/**
 * Resume PDFs through headless Chromium (P2-3).
 *
 * The Word (docx2pdf) and LibreOffice converters reproduce the DOCX exactly,
 * but many machines have neither, and then no PDF exists at all. Chromium
 * ships with JobAgent (Playwright), so this path always works: the tailored
 * DOCX is turned into plain, single-column HTML (tailor.py docx_to_html) and
 * printed. Before printing, the rendered page is checked to contain every
 * paragraph of the DOCX, so the PDF never silently drops content.
 *
 *   RESUME_PDF_ENGINE=auto      (default) Word/LibreOffice when they work,
 *                               Chromium when they do not
 *   RESUME_PDF_ENGINE=chromium  always Chromium (consistent, ATS-plain look)
 *   RESUME_PDF_ENGINE=office    never Chromium (the previous behaviour)
 */
import { readFileSync } from 'node:fs';

export function pdfEngine(env = process.env) {
  const value = String(env.RESUME_PDF_ENGINE ?? 'auto').trim().toLowerCase();
  return ['auto', 'chromium', 'office'].includes(value) ? value : 'auto';
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Pages in a PDF Chromium wrote: count its page objects. */
export function countPdfPages(buffer) {
  const text = Buffer.from(buffer).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length || null;
}

/**
 * ONE BROWSER FOR A BATCH (RISK-04). Preparing 20 packets launched 20 headless
 * Chromiums, one per PDF — a cold start each. The browser is now shared while
 * PDFs are being printed and closed once it has sat idle for IDLE_CLOSE_MS;
 * every print still gets a fresh, isolated context and page. Keyed by the
 * chromium module so a test's fake never shares a browser with the real one.
 */
export const IDLE_CLOSE_MS = 15_000;
const pool = new Map();

async function acquireBrowser(chromium) {
  let entry = pool.get(chromium);
  if (!entry) {
    entry = { users: 0, timer: null, browser: chromium.launch({ headless: true }) };
    pool.set(chromium, entry);
    entry.browser.then((b) => b.on?.('disconnected', () => { if (pool.get(chromium) === entry) pool.delete(chromium); }))
      .catch(() => { if (pool.get(chromium) === entry) pool.delete(chromium); });
  }
  clearTimeout(entry.timer);
  entry.users += 1;
  try {
    return { browser: await entry.browser, entry };
  } catch (err) {
    entry.users -= 1;
    throw err;
  }
}

function releaseBrowser(chromium, entry) {
  entry.users -= 1;
  if (entry.users > 0) return;
  entry.timer = setTimeout(() => {
    if (entry.users > 0 || pool.get(chromium) !== entry) return;
    pool.delete(chromium);
    entry.browser.then((b) => b.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
  // Not unref()d: the browser process would otherwise hold a CLI open forever
  // once the timer stopped counting; worst case a command exits 15 s later.
  // Commands close the pool explicitly at the end (closePdfBrowsers).
}

/** Close the shared browser now (shutdown, tests). */
export async function closePdfBrowsers() {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map(async (e) => { clearTimeout(e.timer); try { await (await e.browser).close(); } catch { /* gone */ } }));
}

/**
 * Print HTML to a PDF file after checking every expected text is rendered.
 * @returns {Promise<{ exported: boolean, pdfPath: string|null, pages: number|null, reason: string }>}
 */
export async function printHtmlToPdf({ html, texts = [], pdfPath, deps = {} }) {
  let chromium = deps.chromium;
  if (!chromium) ({ chromium } = await import('playwright'));
  let browser; let entry;
  try {
    ({ browser, entry } = await acquireBrowser(chromium));
  } catch (err) {
    return { exported: false, pdfPath: null, pages: null, reason: `Chromium could not start: ${String(err.message).split('\n')[0]}` };
  }
  let context = null;
  try {
    // A context per print: nothing (cookies, cache, routes) carries between resumes.
    context = typeof browser.newContext === 'function' ? await browser.newContext() : null;
    const page = await (context ?? browser).newPage();
    // Never fetch anything: the HTML is self-contained.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    // eslint-disable-next-line no-undef -- runs in the page, where document exists
    const rendered = squash(await page.evaluate(() => document.body.innerText));
    const missing = texts.filter((t) => !rendered.includes(squash(t)));
    if (missing.length) {
      return { exported: false, pdfPath: null, pages: null, reason: `the PDF would leave out ${missing.length} paragraph(s); not written` };
    }
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: false, preferCSSPageSize: true });
    if (!context) await page.close?.();
    return { exported: true, pdfPath, pages: countPdfPages(readFileSync(pdfPath)), reason: 'ok (Chromium)' };
  } finally {
    try { await context?.close(); } catch { /* browser already gone */ }
    releaseBrowser(chromium, entry);
  }
}

/**
 * DOCX -> PDF through Chromium. `toHtml` turns the DOCX into { html, texts }
 * (the tailor's Python `html` mode in production).
 */
export async function docxToPdfViaChromium({ docxPath, pdfPath = docxPath.replace(/\.docx$/i, '.pdf'), toHtml, deps = {} }) {
  let rendering;
  try {
    rendering = await toHtml(docxPath);
  } catch (err) {
    return { exported: false, pdfPath: null, pages: null, reason: `could not read the resume for Chromium: ${err.message}` };
  }
  return printHtmlToPdf({ html: rendering.html, texts: rendering.texts, pdfPath, deps });
}
