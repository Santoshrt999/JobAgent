#!/usr/bin/env node
/**
 * Regenerate docs/licenses/npm-dependencies.md from package-lock.json (P1-10),
 * so the license inventory cannot drift from what is installed.
 *
 *   npm run licenses          write the file
 *   npm run licenses -- --check   exit 1 if the file is out of date (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('docs/licenses/npm-dependencies.md', ROOT);

/** The inventory text for a parsed lockfile. */
export function inventory(lock, date) {
  const rows = Object.entries(lock.packages ?? {})
    .filter(([path]) => path)
    .map(([path, meta]) => ({
      name: path.replace(/^node_modules\//, ''),
      version: meta.version ?? '',
      license: typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'UNDECLARED'),
      scope: meta.dev ? 'Development' : 'Runtime / optional',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    '# npm dependency license inventory',
    '',
    `Snapshot: ${date}. Declared metadata from \`package-lock.json\`, including optional platform packages. `
      + 'Dependencies retain these licenses; this inventory does not replace their full notices. '
      + 'Regenerate with `npm run licenses`.',
    '',
    '| Package path | Version | Declared license | Scope |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${r.scope} |`),
    '',
  ].join('\n');
}

function main(argv) {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', ROOT), 'utf8'));
  const current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  const date = argv.includes('--check')
    ? (current.match(/Snapshot: (\d{4}-\d{2}-\d{2})/)?.[1] ?? '')
    : new Date().toISOString().slice(0, 10);
  const text = inventory(lock, date);
  if (argv.includes('--check')) {
    if (text !== current) {
      console.error('docs/licenses/npm-dependencies.md is out of date: run npm run licenses');
      process.exit(1);
    }
    console.log('License inventory is up to date.');
    return;
  }
  writeFileSync(OUT, text);
  const undeclared = text.split('\n').filter((l) => l.includes('| UNDECLARED |'));
  console.log(`Wrote docs/licenses/npm-dependencies.md${undeclared.length ? ` (${undeclared.length} without a declared license)` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
