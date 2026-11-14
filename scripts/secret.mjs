#!/usr/bin/env node
/**
 * Keep a password out of .env (P1-8): store it in the operating system's
 * secret store (Keychain, Windows DPAPI, Secret Service) or, failing that, an
 * encrypted file in data/.
 *
 *   npm run secret -- set INBOX_IMAP_PASSWORD     (asks for it; nothing echoed)
 *   npm run secret -- delete INBOX_IMAP_PASSWORD
 *   npm run secret -- status INBOX_IMAP_PASSWORD  (says whether it is stored; never prints it)
 *
 * `set` also reads the value from stdin when it is piped in.
 */
import { createInterface } from 'node:readline';

import { PROJECT_ROOT } from '../src/config/loadConfig.js';
import { createSecretStore } from '../src/utils/secretStore.js';

const [action, name] = process.argv.slice(2);

function ask(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

try {
  const store = createSecretStore({ root: PROJECT_ROOT, env: {} });
  if (!['set', 'delete', 'status'].includes(action) || !name) {
    console.error('usage: npm run secret -- set|delete|status NAME');
    process.exit(2);
  }
  if (action === 'set') {
    const value = await ask(`Value for ${name}: `);
    store.set(name, value);
    console.log(`Stored ${name} in the ${store.backend} store${store.osProtected ? '' : ' (an encrypted file: anyone who can read your files can read it)'}.`);
  } else if (action === 'delete') {
    store.delete(name);
    console.log(`Removed ${name}.`);
  } else {
    console.log(store.get(name) ? `${name} is stored (${store.backend}).` : `${name} is not stored.`);
  }
} catch (err) {
  console.error(`secret: ${err.message}`);
  process.exit(1);
}
