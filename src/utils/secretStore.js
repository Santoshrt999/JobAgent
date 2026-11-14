// @ts-check
/**
 * Local secret storage (P1-8): passwords and tokens that must not sit in .env
 * in plain text, such as the inbox's app password.
 *
 * Backends, picked per platform (JOB_AGENT_SECRET_BACKEND overrides):
 *   keychain     macOS Keychain, through `security -i` with the command on
 *                stdin, so the secret never appears in a process listing
 *   dpapi        Windows DPAPI (current user), through PowerShell reading the
 *                secret from stdin; the encrypted blob lives in data/secrets/
 *   secret-tool  Linux Secret Service, secret on stdin
 *   file         fallback: AES-256-GCM in data/secrets/secrets.json under a
 *                key in data/.secret-key (owner-only). Weaker: anyone who can
 *                read your files can read both. Reported as such.
 *
 * An environment variable of the same name always wins, so existing .env
 * setups keep working and CI never touches a keychain.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = 'JobAgent';
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function checkName(name) {
  if (!NAME_RE.test(String(name))) throw new Error(`invalid secret name "${name}" (use UPPER_SNAKE_CASE)`);
}

/**
 * The environment for Windows PowerShell 5.1 (`powershell.exe`). Started from
 * PowerShell 7 (as GitHub's Windows runners and many terminals do), it
 * inherits PowerShell 7's PSModulePath, then fails to load its own
 * Microsoft.PowerShell.Security module ("ConvertTo-SecureString ... the module
 * could not be loaded"). Without the variable it builds its default path.
 */
export function windowsPowerShellEnv(env = process.env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (key.toUpperCase() === 'PSMODULEPATH') delete out[key];
  return out;
}

/** Run a program with input on stdin; never pass secrets as arguments. */
function run(cmd, args, input, execImpl = spawnSync) {
  const env = cmd === 'powershell' ? windowsPowerShellEnv() : process.env;
  const r = execImpl(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 15_000, env });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error ?? null };
}

const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

const keychain = {
  name: 'keychain',
  available: (execImpl) => process.platform === 'darwin' && run('security', ['-h'], '', execImpl).error == null,
  get(name, { execImpl }) {
    const r = run('security', ['find-generic-password', '-a', name, '-s', SERVICE, '-w'], '', execImpl);
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
  },
  set(name, value, { execImpl }) {
    const r = run('security', ['-i'], `add-generic-password -U -a ${quote(name)} -s ${quote(SERVICE)} -w ${quote(value)}\n`, execImpl);
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain refused the secret: ${r.stderr.trim().split('\n')[0]}`);
  },
  delete(name, { execImpl }) {
    run('security', ['delete-generic-password', '-a', name, '-s', SERVICE], '', execImpl);
  },
};

const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const dpapi = {
  name: 'dpapi',
  available: (execImpl) => process.platform === 'win32' && run('powershell', [...PS, '$PSVersionTable.PSVersion.Major'], '', execImpl).status === 0,
  file: (root, name) => join(root, 'data', 'secrets', `${name}.dpapi`),
  get(name, { root, execImpl }) {
    const f = dpapi.file(root, name);
    if (!existsSync(f)) return null;
    const script = '$b = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $b; '
      + '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
    const r = run('powershell', [...PS, script], readFileSync(f, 'utf8'), execImpl);
    return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
  },
  set(name, value, { root, execImpl }) {
    const script = '$v = [Console]::In.ReadToEnd(); ConvertTo-SecureString $v -AsPlainText -Force | ConvertFrom-SecureString';
    const r = run('powershell', [...PS, script], value, execImpl);
    if (r.status !== 0 || !r.stdout.trim()) throw new Error(`DPAPI could not protect the secret: ${r.stderr.trim().split('\n')[0]}`);
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true });
    writeFileSync(dpapi.file(root, name), r.stdout.trim(), { mode: 0o600 });
  },
  delete(name, { root }) { rmSync(dpapi.file(root, name), { force: true }); },
};

const secretTool = {
  name: 'secret-tool',
  available: (execImpl) => process.platform === 'linux' && run('secret-tool', ['--version'], '', execImpl).error == null,
  get(name, { execImpl }) {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'name', name], '', execImpl);
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
  },
  set(name, value, { execImpl }) {
    const r = run('secret-tool', ['store', `--label=${SERVICE} ${name}`, 'service', SERVICE, 'name', name], value, execImpl);
    if (r.status !== 0) throw new Error(`Secret Service refused the secret: ${r.stderr.trim().split('\n')[0]}`);
  },
  delete(name, { execImpl }) { run('secret-tool', ['clear', 'service', SERVICE, 'name', name], '', execImpl); },
};

const file = {
  name: 'file',
  available: () => true,
  keyFile: (root) => join(root, 'data', '.secret-key'),
  store: (root) => join(root, 'data', 'secrets', 'secrets.json'),
  key(root) {
    const kf = file.keyFile(root);
    if (!existsSync(kf)) {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(kf, randomBytes(32).toString('base64'), { mode: 0o600 });
      try { chmodSync(kf, 0o600); } catch { /* not supported */ }
    }
    return Buffer.from(readFileSync(kf, 'utf8').trim(), 'base64');
  },
  read(root) {
    try { return JSON.parse(readFileSync(file.store(root), 'utf8')); } catch { return {}; }
  },
  write(root, data) {
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true });
    writeFileSync(file.store(root), JSON.stringify(data, null, 2), { mode: 0o600 });
  },
  get(name, { root }) {
    const entry = file.read(root)[name];
    if (!entry) return null;
    const decipher = createDecipheriv('aes-256-gcm', file.key(root), Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`the stored secret ${name} could not be decrypted (changed or damaged)`);
    }
  },
  set(name, value, { root }) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', file.key(root), iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const all = file.read(root);
    all[name] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    file.write(root, all);
  },
  delete(name, { root }) {
    const all = file.read(root);
    delete all[name];
    file.write(root, all);
  },
};

export const BACKENDS = { keychain, dpapi, 'secret-tool': secretTool, file };

/**
 * The backend for this machine: the OS store when it works, else the file.
 * @param {{ env?: NodeJS.ProcessEnv, execImpl?: Function }} [options]
 */
export function chooseBackend({ env = process.env, execImpl } = {}) {
  const forced = String(env.JOB_AGENT_SECRET_BACKEND ?? '').trim();
  if (forced) {
    if (!BACKENDS[forced]) throw new Error(`unknown JOB_AGENT_SECRET_BACKEND "${forced}"`);
    return BACKENDS[forced];
  }
  for (const b of [keychain, dpapi, secretTool]) if (b.available(execImpl)) return b;
  return file;
}

/**
 * A secret store for one workspace.
 * @param {{ root?: string|null, env?: NodeJS.ProcessEnv, execImpl?: Function }} [options]
 */
export function createSecretStore({ root = null, env = process.env, execImpl } = {}) {
  const backend = chooseBackend({ env, execImpl });
  const ctx = { root, execImpl };
  return {
    backend: backend.name,
    /** True when secrets are protected by the operating system, not only by file permissions. */
    osProtected: backend !== file,
    get(name) {
      checkName(name);
      const fromEnv = env[name];
      if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
      return backend.get(name, ctx);
    },
    set(name, value) {
      checkName(name);
      if (typeof value !== 'string' || !value) throw new Error('a secret must be a non-empty string');
      backend.set(name, value, ctx);
    },
    delete(name) {
      checkName(name);
      backend.delete(name, ctx);
    },
  };
}
