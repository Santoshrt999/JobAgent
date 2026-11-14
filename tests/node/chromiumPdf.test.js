/**
 * Resume PDFs through Chromium (P2-3): a real tailored DOCX goes through the
 * tailor's HTML rendering and a real headless Chromium, on any OS with no Word
 * or LibreOffice. The PDF exists, has pages, and the page it was printed from
 * held every paragraph of the DOCX.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { countPdfPages, docxToPdfViaChromium, pdfEngine, printHtmlToPdf } from '../../src/resume/chromiumPdf.js';
import { resumeHtml } from '../../src/resume/tailorRunner.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser } from './helpers/dashboardPage.js';

let dir; let available = true;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cpdf-'));
  try { (await launchBrowser()).close(); } catch (err) { available = browserUnavailable(err); }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeDocx(path) {
  const script = [
    'import sys', 'from docx import Document', 'd = Document()',
    'd.add_paragraph("Test Person")', 'd.add_paragraph("PROFESSIONAL EXPERIENCE")',
    'd.add_paragraph("Data Engineer, Acme Corp | Jan 2021 - Present")',
    'd.add_paragraph("Built medallion pipelines on Azure Databricks & PySpark <fast>.", style="List Bullet")',
    'd.add_paragraph("Developed Power BI semantic models for finance analytics.", style="List Bullet")',
    'd.add_paragraph("EDUCATION")', 'd.add_paragraph("B.S. Computer Science, State University")',
    'd.save(sys.argv[1])',
  ].join('\n');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, path]);
}

describe('Chromium PDF (P2-3)', { timeout: 60_000 }, () => {
  it('reads the engine setting, defaulting to auto', () => {
    expect(pdfEngine({})).toBe('auto');
    expect(pdfEngine({ RESUME_PDF_ENGINE: 'chromium' })).toBe('chromium');
    expect(pdfEngine({ RESUME_PDF_ENGINE: 'nonsense' })).toBe('auto');
  });

  it('prints a real DOCX to a PDF holding every paragraph', async (ctx) => {
    if (!available) return ctx.skip();
    const docx = join(dir, 'resume.docx');
    makeDocx(docx);
    const rendering = await resumeHtml(docx, { root: process.cwd() });
    expect(rendering.html).toContain('<h2>PROFESSIONAL EXPERIENCE</h2>');
    expect(rendering.html).toContain('<li>Built medallion pipelines on Azure Databricks &amp; PySpark &lt;fast&gt;.</li>');
    expect(rendering.html).not.toMatch(/<table|<img|<script/i);
    const r = await docxToPdfViaChromium({ docxPath: docx, toHtml: async () => rendering });
    expect(r).toMatchObject({ exported: true, reason: 'ok (Chromium)' });
    expect(existsSync(r.pdfPath)).toBe(true);
    expect(readFileSync(r.pdfPath).subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.pages).toBe(1);
  });

  it('refuses to write a PDF that would leave out a paragraph', async (ctx) => {
    if (!available) return ctx.skip();
    const r = await printHtmlToPdf({
      html: '<!doctype html><html><body><p>Only this</p></body></html>',
      texts: ['Only this', 'A paragraph the page does not have'],
      pdfPath: join(dir, 'never.pdf'),
    });
    expect(r).toMatchObject({ exported: false });
    expect(r.reason).toMatch(/leave out 1 paragraph/);
    expect(existsSync(join(dir, 'never.pdf'))).toBe(false);
  });

  it('counts pages in a PDF', () => {
    expect(countPdfPages(Buffer.from('/Type /Pages /Type /Page x /Type /Page'))).toBe(2);
  });
});

describe('one browser for a batch of PDFs (RISK-04)', () => {
  it('launches Chromium once for several prints, each in its own context, and closes it on request', async () => {
    const { printHtmlToPdf: print, closePdfBrowsers } = await import('../../src/resume/chromiumPdf.js');
    const { writeFileSync: write, mkdtempSync: mk, rmSync: rm } = await import('node:fs');
    const { tmpdir: tmp } = await import('node:os');
    const { join: j } = await import('node:path');
    const out = mk(j(tmp(), 'jobagent-pool-'));
    let launches = 0; let contexts = 0; let closedContexts = 0; let browserClosed = false;
    const page = {
      route: async () => {}, setContent: async () => {}, evaluate: async () => 'Jordan Lee Data Engineer',
      pdf: async ({ path }) => write(path, '%PDF /Type /Page'),
    };
    const fake = {
      launch: async () => {
        launches += 1;
        return {
          on() {}, newContext: async () => { contexts += 1; return { newPage: async () => page, close: async () => { closedContexts += 1; } }; },
          close: async () => { browserClosed = true; },
        };
      },
    };
    try {
      for (let i = 0; i < 3; i += 1) {
        const r = await print({ html: '<p>x</p>', texts: ['Jordan Lee'], pdfPath: j(out, `r${i}.pdf`), deps: { chromium: fake } });
        expect(r.exported).toBe(true);
      }
      expect(launches).toBe(1);
      expect([contexts, closedContexts]).toEqual([3, 3]);
      await closePdfBrowsers();
      expect(browserClosed).toBe(true);
    } finally {
      rm(out, { recursive: true, force: true });
    }
  });
});
