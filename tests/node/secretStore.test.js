/**
 * Local secret storage (P1-8). The file fallback runs everywhere; each OS
 * backend is driven through an injected exec double (no real keychain is
 * touched), and the real OS round-trip runs only where CI opts in with
 * REAL_SECRET_STORE_TEST=1 (or on Windows, where DPAPI writes only to a
 * temp folder).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BACKENDS, createSecretStore, windowsPowerShellEnv } from '../../src/utils/secretStore.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'secrets-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('file fallback', () => {
  const store = () => createSecretStore({ root, env: { JOB_AGENT_SECRET_BACKEND: 'file' } });

  it('round-trips, encrypts at rest, and deletes', () => {
    const s = store();
    s.set('INBOX_PASSWORD', 'abcd efgh ijkl mnop');
    expect(s.get('INBOX_PASSWORD')).toBe('abcd efgh ijkl mnop');
    expect(readFileSync(join(root, 'data', 'secrets', 'secrets.json'), 'utf8')).not.toContain('abcd');
    if (process.platform !== 'win32') expect(statSync(join(root, 'data', '.secret-key')).mode & 0o077).toBe(0);
    s.delete('INBOX_PASSWORD');
    expect(s.get('INBOX_PASSWORD')).toBeNull();
    expect(s.osProtected).toBe(false);
  });

  it('refuses a tampered value instead of returning garbage', () => {
    const s = store();
    s.set('TOKEN_A', 'secret');
    const path = join(root, 'data', 'secrets', 'secrets.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.TOKEN_A.data = Buffer.from('tampered').toString('base64');
    writeFileSync(path, JSON.stringify(data));
    expect(() => s.get('TOKEN_A')).toThrow(/could not be decrypted/);
  });

  it('lets an environment variable win, and validates names', () => {
    const s = createSecretStore({ root, env: { JOB_AGENT_SECRET_BACKEND: 'file', INBOX_PASSWORD: 'from-env' } });
    expect(s.get('INBOX_PASSWORD')).toBe('from-env');
    expect(() => s.set('bad name', 'x')).toThrow(/invalid secret name/);
    expect(() => s.set('OK_NAME', '')).toThrow(/non-empty/);
  });
});

describe('OS backends never put the secret in the arguments', () => {
  function recorder(reply = { status: 0, stdout: '', stderr: '' }) {
    const calls = [];
    const execImpl = (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return reply; };
    return { calls, execImpl };
  }

  it('keychain: the add command travels on stdin', () => {
    const { calls, execImpl } = recorder();
    BACKENDS.keychain.set('INBOX_PASSWORD', 'p@ss "word"', { execImpl });
    expect(calls[0].args).toEqual(['-i']);
    expect(calls[0].args.join(' ')).not.toContain('p@ss');
    expect(calls[0].input).toContain('add-generic-password -U -a "INBOX_PASSWORD" -s "JobAgent" -w "p@ss \\"word\\""');
  });

  it('dpapi: the plaintext travels on stdin and only the protected blob is stored', () => {
    const { calls, execImpl } = recorder({ status: 0, stdout: '01000000d08c9ddf-protected\r\n', stderr: '' });
    BACKENDS.dpapi.set('INBOX_PASSWORD', 'plain-secret', { root, execImpl });
    expect(calls[0].args.join(' ')).not.toContain('plain-secret');
    expect(calls[0].input).toBe('plain-secret');
    expect(readFileSync(join(root, 'data', 'secrets', 'INBOX_PASSWORD.dpapi'), 'utf8')).toBe('01000000d08c9ddf-protected');
  });

  it('dpapi: Windows PowerShell starts without an inherited PowerShell 7 module path', () => {
    const calls = [];
    const execImpl = (cmd, args, opts) => { calls.push(opts); return { status: 0, stdout: 'blob', stderr: '' }; };
    BACKENDS.dpapi.set('INBOX_PASSWORD', 'x', { root, execImpl });
    expect(Object.keys(calls[0].env).some((k) => k.toUpperCase() === 'PSMODULEPATH')).toBe(false);
    expect(windowsPowerShellEnv({ PSModulePath: 'C:\\pwsh7\\Modules', Path: 'C:\\Windows' })).toEqual({ Path: 'C:\\Windows' });
  });

  it('secret-tool: the secret travels on stdin', () => {
    const { calls, execImpl } = recorder();
    BACKENDS['secret-tool'].set('INBOX_PASSWORD', 'plain-secret', { execImpl });
    expect(calls[0].args).not.toContain('plain-secret');
    expect(calls[0].input).toBe('plain-secret');
  });
});

const realOs = process.env.REAL_SECRET_STORE_TEST === '1' || process.platform === 'win32';
// Each Windows PowerShell start takes 1-2 s on CI runners and this test starts
// it three times (availability, protect, unprotect): 5.3 s measured on Node 22
// / windows-latest, over vitest's 5 s default. Slow, not broken.
describe.runIf(realOs)('real OS store round-trip', { timeout: 60_000 }, () => {
  it('stores, reads and deletes with the platform backend', () => {
    const s = createSecretStore({ root, env: {} });
    const name = `JOBAGENT_TEST_${process.pid}`;
    s.set(name, 'round trip value');
    try {
      expect(s.get(name)).toBe('round trip value');
    } finally {
      s.delete(name);
    }
    expect(s.get(name)).toBeNull();
  });
});
