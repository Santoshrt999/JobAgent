/**
 * Read a repository text file for a source-level test, with Windows line
 * endings normalized. On a CRLF checkout (git's `text=auto` on Windows), a
 * test that slices source text on "\n" otherwise finds nothing and quietly
 * checks the whole file, passing for the wrong reason (P3-2).
 */
import { readFileSync } from 'node:fs';

export function readText(url) {
  return readFileSync(url, 'utf8').replace(/\r\n?/g, '\n');
}
