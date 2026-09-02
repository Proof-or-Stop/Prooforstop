#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 D1 — the packaged desktop binary must ship EVERY scripts/ module that
 * bin/bootstrap-runner.js statically imports, or a packaged desktop runtime crashes with
 * ERR_MODULE_NOT_FOUND at bootstrap module-init.
 *
 * bin/bootstrap-runner.js is the desktop pkg entrypoint (scripts/package-desktop.mjs's pkg-entry copies
 * it into the runtime and imports it). It statically imports the node:-only helper under scripts/
 * (build-lock-target.mjs). That lives under scripts/, NOT packages/<pkg>/dist, so NONE of
 * package-desktop.mjs's listFiles() spreads ship it — it must be listed EXPLICITLY in the
 * writeAssetManifest `files` array. Pre-fix the manifest listed bin/bootstrap-runner.js WITHOUT
 * scripts/build-lock-target.mjs, so the packaged runtime threw ERR_MODULE_NOT_FOUND resolving
 * `../scripts/build-lock-target.mjs` before it could run.
 *
 * This test is drift-proof: it computes bin/bootstrap-runner.js's TRANSITIVE static import graph and
 * asserts every scripts/ module reachable from it is present as a literal in the package-desktop.mjs
 * asset-manifest `files` array. It catches D1 and any future case where bootstrap gains a scripts/
 * dependency not shipped to the desktop runtime.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const BOOTSTRAP_ABS = join(repoRoot, 'bin', 'bootstrap-runner.js');
const PACKAGE_DESKTOP_REL = 'scripts/package-desktop.mjs';
const toRepoRel = abs => relative(repoRoot, abs).split(sep).join('/');

// Follow every RELATIVE static import specifier from an entry file, returning the set of reachable
// on-disk module files (absolute paths, including the entry). Bare specifiers (node_modules deps) and
// node: built-ins terminate a branch — we only care about first-party relative modules here.
function collectStaticGraph(entryAbs) {
  const seen = new Set();
  const stack = [entryAbs];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue; // node: built-in or bare specifier — not a first-party file
      stack.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

// ── manifest:0 — every scripts/ module in bootstrap's static graph is shipped by the desktop manifest ─
{
  const graph = collectStaticGraph(BOOTSTRAP_ABS);
  const scriptDeps = [...graph]
    .map(toRepoRel)
    .filter(rel => rel.startsWith('scripts/'))
    .sort();
  assert.ok(
    scriptDeps.length > 0,
    'expected bin/bootstrap-runner.js to statically import at least one scripts/ module to guard (none found — the parser or the graph changed)',
  );

  const pkgSrc = readFileSync(join(repoRoot, PACKAGE_DESKTOP_REL), 'utf8');
  // Isolate the writeAssetManifest `files` array literal. scripts/ modules can ONLY reach the manifest as
  // explicit string literals here (no listFiles() spread covers scripts/), so literal membership is the
  // correct, sufficient check.
  const filesBlockMatch = pkgSrc.match(/const\s+files\s*=\s*\[([\s\S]*?)\]\s*\.sort\(\)/);
  assert.ok(filesBlockMatch, `could not locate the asset-manifest 'files' array in ${PACKAGE_DESKTOP_REL}`);
  const filesBlock = filesBlockMatch[1];

  for (const dep of scriptDeps) {
    const literal = new RegExp(`['"]${dep.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['"]`);
    assert.ok(
      literal.test(filesBlock),
      `bin/bootstrap-runner.js statically imports '${dep}' (directly or transitively) but ${PACKAGE_DESKTOP_REL}'s ` +
        `asset-manifest 'files' array does not ship it — the packaged desktop runtime would crash with ` +
        `ERR_MODULE_NOT_FOUND at bootstrap module-init (B-1734 D1). Add '${dep}' to that array.`,
    );
  }
  console.log(`VI-OK D1:manifest:0 (${scriptDeps.join(', ')})`);
}

console.log('PASS red-1734-desktop-asset-manifest: every scripts/ module in bin/bootstrap-runner.js\'s static import graph is shipped by the desktop asset manifest');
