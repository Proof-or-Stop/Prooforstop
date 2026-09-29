#!/usr/bin/env node
/**
 * Proof-or-Stop bin entry (main standalone mode)
 *
 * This script only loads tools bundled with main (process category). If you also want to enable @proof-or-stop/utils
 * helper tools, use the generated bin/proof-or-stop.js bootstrap script.
 * (B-cc10 F-010: bin/proofOrStop.js was deleted by CHK-006; the generated entrypoint is bin/proof-or-stop.js.)
 *
 * When a dynamic import carries a ?t= cache buster, import.meta.url contains a query string, so skip runCli.
 */

import module from 'node:module';

const _isDirectRun = !import.meta.url.includes('?');

if (_isDirectRun) {
  // Compile the large module graph once and reuse it from disk on later calls;
  // NODE_DISABLE_COMPILE_CACHE=1 still turns this off.
  try { (module as { enableCompileCache?: () => unknown }).enableCompileCache?.(); } catch { /* optional speed-up */ }
  void import('./core/lazy-typescript-hook.js')
    .catch(() => { /* registerHooks unavailable: import typescript eagerly as before */ })
    .then(() => import('./cli-direct.js'))
    .then(({ runDirectCli }) => runDirectCli())
    .catch(e => { console.error(e); process.exit(1); });
}
