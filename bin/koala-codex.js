#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.KOALA_ACTIVITY_SOURCE = 'codex';
process.env.KOALA_ACTIVITY_RECORD_READONLY = '1';
process.env.KOALA_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

const binDir = dirname(fileURLToPath(import.meta.url));
const localKoala = join(binDir, 'koala.js');
if (existsSync(localKoala)) {
  await import(pathToFileURL(localKoala).href);
} else {
  console.error('bin/koala-codex.js did not find a sibling bin/koala.js local bootstrap.');
  console.error('');
  console.error('Recovery:');
  console.error('  - Rerun: npx koala-init --verify-codex');
  console.error('  - If this is the Koala repository, run: npm run build');
  process.exit(1);
}
