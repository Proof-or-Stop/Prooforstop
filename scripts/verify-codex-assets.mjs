#!/usr/bin/env node

import { CODEX_README_TEMPLATE, renderCodexAdapterManifest } from '../packages/main/dist/init-assets.js';
import {
  GLOBAL_CODEX_FALLBACK_COMMAND,
  renderCodexAdapterChecks,
  runCodexAdapterChecks,
} from '../packages/main/dist/core/codex-adapter-checks.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const result = runCodexAdapterChecks(root, { executeHeartbeats: false });
if (!result.ok) {
  console.error(renderCodexAdapterChecks(result));
  process.exit(1);
}

assert(CODEX_README_TEMPLATE.includes('node bin/koala-codex.js session_brief'), 'template missing preferred wrapper command');
assert(CODEX_README_TEMPLATE.includes(`${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`), 'template missing fallback command');
assert(CODEX_README_TEMPLATE.includes('koala verify_codex'), 'template missing verify_codex guidance');
assert(renderCodexAdapterManifest().includes('"activitySource": "codex"'), 'manifest template missing codex source');

console.log(renderCodexAdapterChecks(result));
console.log('codex assets verified');
