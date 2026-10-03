#!/usr/bin/env node
/**
 * Proof-or-Stop bin entry (main standalone mode)
 *
 * This script only loads tools bundled with main (process category). If you also want to enable @proof-or-stop/utils
 * helper tools, use the generated bin/proof-or-stop.js bootstrap script.
 * (B-cc10 F-010: bin/proofOrStop.js was deleted by CHK-006; the generated entrypoint is bin/proof-or-stop.js.)
 *
 * When a dynamic import carries a ?t= cache buster, import.meta.url contains a query string, so skip runCli.
 *
 * The direct-run body is cli-direct.js. When scripts/build-cli-bundle.mjs has
 * produced cli-direct.bundle.mjs (the same graph as ONE module) and its
 * freshness manifest still matches every bundled dist input (size and
 * whole-second mtime), that bundle is loaded instead, which avoids linking
 * ~715 modules per call. PROOF_OR_STOP_BUNDLE=0 always uses the per-file graph;
 * PROOF_OR_STOP_BUNDLE=require fails instead of falling back.
 */

import module from 'node:module';
import { readFileSync, statSync } from 'node:fs';

const _isDirectRun = !import.meta.url.includes('?');

const BUNDLE_MANIFEST_SCHEMA = 'proof-or-stop.cli-bundle.v1';

function bundleIsFresh(): string | null {
  const manifest = JSON.parse(readFileSync(new URL('./cli-direct.bundle.json', import.meta.url), 'utf8')) as {
    schema?: unknown; bundle?: unknown; inputs?: unknown;
  };
  if (manifest.schema !== BUNDLE_MANIFEST_SCHEMA || !Array.isArray(manifest.bundle) || !Array.isArray(manifest.inputs)) {
    return 'unrecognized bundle manifest';
  }
  for (const entry of [manifest.bundle, ...manifest.inputs] as unknown[][]) {
    const [path, size, mtime] = entry as [string, number, number];
    const stat = statSync(new URL(`./${path}`, import.meta.url));
    if (stat.size !== size || Math.floor(stat.mtimeMs / 1000) !== mtime) return `${path} changed after the bundle was built`;
  }
  return null;
}

function directEntry(): string {
  const mode = process.env.PROOF_OR_STOP_BUNDLE;
  if (mode === '0') return './cli-direct.js';
  let reason: string | null;
  try {
    reason = bundleIsFresh();
  } catch (error) {
    reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no bundle built' : String(error);
  }
  if (reason === null) return './cli-direct.bundle.mjs';
  if (mode === 'require') throw new Error(`PROOF_OR_STOP_BUNDLE=require: CLI bundle unusable (${reason}); run node scripts/build-cli-bundle.mjs`);
  return './cli-direct.js';
}

if (_isDirectRun) {
  // Compile the large module graph once and reuse it from disk on later calls;
  // NODE_DISABLE_COMPILE_CACHE=1 still turns this off.
  try { (module as { enableCompileCache?: () => unknown }).enableCompileCache?.(); } catch { /* optional speed-up */ }
  void import('./core/lazy-typescript-hook.js')
    .catch(() => { /* registerHooks unavailable: import typescript eagerly as before */ })
    .then(() => import(directEntry()) as Promise<typeof import('./cli-direct.js')>)
    .then(({ runDirectCli }) => runDirectCli())
    .catch(e => { console.error(e); process.exit(1); });
}
