#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 C3 — a FRESH checkout WITHOUT node_modules must still print the
 * recovery hint, NOT crash with ERR_MODULE_NOT_FOUND at module-init.
 *
 * bin/bootstrap-runner.js is the universal local wrapper entrypoint (imported by bin/proofOrStop.js on
 * EVERY call). Pre-fix it imported { BUILD_LOCK_OPTIONS, buildLockTarget } from ../scripts/build-lock.mjs,
 * and build-lock.mjs does `import lockfile from 'proper-lockfile'`. So a checkout without node_modules
 * threw ERR_MODULE_NOT_FOUND at ESM module-init, BEFORE runLocalBootstrap's try/catch / printBootstrapFailure
 * could run — defeating the wrapper's entire purpose (a helpful "run the build" hint).
 *
 * The fix moves the lock target + stale threshold into a dependency-free module (scripts/build-lock-target.mjs,
 * only node: built-ins); bootstrap imports from THERE, so it never transitively loads proper-lockfile.
 *
 * Proof (each `VI-OK` prints only after a real assert):
 *   1. STATIC graph: bin/bootstrap-runner.js does NOT import build-lock.mjs and DOES import
 *      build-lock-target.mjs; build-lock-target.mjs references no proper-lockfile and imports ONLY
 *      node: built-ins → bootstrap's static import graph is proper-lockfile-free.
 *   2. LOAD: build-lock-target.mjs and bin/bootstrap-runner.js both import cleanly (module-init does not
 *      throw) and expose their expected bindings.
 *   3. FRESH-CHECKOUT SPAWN: a fixture with bin/bootstrap-runner.js + scripts/build-lock-target.mjs but
 *      NO node_modules and NO dist runs runLocalBootstrap and prints the recovery hint + exits 1 —
 *      never ERR_MODULE_NOT_FOUND / "Cannot find package 'proper-lockfile'".
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const read = rel => readFileSync(join(repoRoot, rel), 'utf8');
const BOOTSTRAP_REL = 'bin/bootstrap-runner.js';
const TARGET_REL = 'scripts/build-lock-target.mjs';
const LOCKFILE_RE = /proper-lockfile/;

function spawnCapture(args, opts = {}) {
  return new Promise(res => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => res({ code, out }));
    child.on('error', err => res({ code: -1, out: String((err && err.stack) || err) }));
  });
}

const toRepoRel = abs => relative(repoRoot, abs).split(sep).join('/');

// Follow every RELATIVE static import from an entry file, returning the reachable first-party module
// files (absolute paths, including the entry). node: built-ins and bare specifiers terminate a branch.
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
      if (!spec.startsWith('.')) continue;
      stack.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

async function main() {
  // ── depfree:0 — STATIC import graph is proper-lockfile-free ──────────────────────────────────────
  {
    const bootSrc = read(BOOTSTRAP_REL);
    assert.ok(
      !/from\s+['"][^'"]*build-lock\.mjs['"]/.test(bootSrc),
      'bin/bootstrap-runner.js must NOT import from ../scripts/build-lock.mjs (it pulls in proper-lockfile, which ERR_MODULE_NOT_FOUNDs in a fresh checkout)',
    );
    assert.ok(
      /from\s+['"][^'"]*build-lock-target\.mjs['"]/.test(bootSrc),
      'bin/bootstrap-runner.js must import the lock target + stale threshold from the dependency-free ../scripts/build-lock-target.mjs',
    );
    // A prose mention of proper-lockfile in a comment is fine; what matters is that it is never IMPORTED
    // (directly or transitively). Assert none of bootstrap's own import specifiers is proper-lockfile.
    const bootImportSpecs = [...bootSrc.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(
      !bootImportSpecs.some(spec => LOCKFILE_RE.test(spec)),
      `bin/bootstrap-runner.js must not import proper-lockfile; its import specifiers are ${JSON.stringify(bootImportSpecs)}`,
    );

    const targetSrc = read(TARGET_REL);
    assert.ok(!LOCKFILE_RE.test(targetSrc), 'scripts/build-lock-target.mjs must contain no proper-lockfile reference (kept dependency-free)');
    const importSpecs = [...targetSrc.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(importSpecs.length > 0, 'scripts/build-lock-target.mjs must have at least one import (the node: built-ins it uses)');
    for (const spec of importSpecs) {
      assert.ok(spec.startsWith('node:'), `scripts/build-lock-target.mjs may import ONLY node: built-ins so it loads without node_modules, got '${spec}'`);
    }
    console.log('VI-OK C3:depfree:0');
  }

  // ── depfree:3 — TRANSITIVE: bootstrap's WHOLE static graph is third-party-free (loads sans node_modules) ─
  // bootstrap's only scripts/ dependency is the dep-free build-lock-target.mjs (the D3 promote-dist import
  // was reverted). Guard the ENTIRE reachable graph, not just bootstrap's direct imports: no first-party
  // module in it may import a bare/third-party specifier (that needs node_modules and reintroduces the
  // proper-lockfile-class fresh-checkout crash). This future-proofs any new dep-free scripts/ helper
  // bootstrap picks up.
  {
    const graph = collectStaticGraph(join(repoRoot, BOOTSTRAP_REL));
    const scriptModules = [...graph].map(toRepoRel).filter(r => r.startsWith('scripts/'));
    assert.ok(scriptModules.includes(TARGET_REL), `bootstrap's static graph must include ${TARGET_REL}`);
    assert.ok(
      scriptModules.length >= 1,
      `bootstrap must depend on at least the dep-free build-lock-target.mjs scripts/ module; got ${JSON.stringify(scriptModules)}`,
    );
    const thirdPartyImports = [];
    for (const file of graph) {
      const specs = [...readFileSync(file, 'utf8').matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
      for (const spec of specs) {
        // A dependency-free graph may import ONLY node: built-ins (whether written `node:fs` or bare
        // `fs` — isBuiltin recognizes both) and first-party relative modules. Anything else needs
        // node_modules and would ERR_MODULE_NOT_FOUND in a fresh checkout (proper-lockfile was exactly
        // such a case).
        if (isBuiltin(spec) || spec.startsWith('.')) continue;
        thirdPartyImports.push({ file: toRepoRel(file), spec });
      }
    }
    assert.deepEqual(
      thirdPartyImports,
      [],
      `every module in bin/bootstrap-runner.js's static import graph must import ONLY node: built-ins or ` +
        `other first-party dep-free modules so a fresh checkout loads without node_modules; found ` +
        `third-party imports: ${JSON.stringify(thirdPartyImports)}`,
    );
    console.log('VI-OK C3:depfree:3');
  }

  // ── depfree:1 — both modules LOAD (module-init does not throw) and expose expected bindings ───────
  {
    const target = await import(pathToFileURL(join(repoRoot, TARGET_REL)).href);
    assert.equal(typeof target.buildLockTarget, 'function', 'build-lock-target.mjs must export buildLockTarget()');
    assert.equal(typeof target.BUILD_LOCK_STALE_MS, 'number', 'build-lock-target.mjs must export a numeric BUILD_LOCK_STALE_MS');
    assert.ok(target.BUILD_LOCK_STALE_MS >= 30000, `BUILD_LOCK_STALE_MS must be >= 30000ms, got ${target.BUILD_LOCK_STALE_MS}`);

    const boot = await import(pathToFileURL(join(repoRoot, BOOTSTRAP_REL)).href);
    assert.equal(typeof boot.buildInProgress, 'function', 'bootstrap-runner.js must export buildInProgress()');
    assert.equal(typeof boot.runLocalBootstrap, 'function', 'bootstrap-runner.js must export runLocalBootstrap()');
    assert.equal(typeof boot.IMPORT_WAIT_MAX_MS, 'number', 'bootstrap-runner.js must export the numeric IMPORT_WAIT_MAX_MS ceiling');
    console.log('VI-OK C3:depfree:1');
  }

  // ── depfree:2 — FRESH-CHECKOUT SPAWN: no node_modules, no dist → recovery hint + exit 1 ───────────
  {
    const base = mkdtempSync(join(tmpdir(), 'red-1734-depfree-'));
    try {
      mkdirSync(join(base, 'bin'), { recursive: true });
      mkdirSync(join(base, 'scripts'), { recursive: true });
      // Copy EVERY first-party module in bootstrap's static import graph (bootstrap-runner.js +
      // build-lock-target.mjs + …) so the fixture is a faithful fresh checkout whose ONLY missing piece is
      // node_modules. If bootstrap gains a new dep-free scripts/ module this keeps copying it, so the test
      // stays honest that module-init loads without node_modules.
      for (const abs of collectStaticGraph(join(repoRoot, BOOTSTRAP_REL))) {
        const dest = join(base, toRepoRel(abs));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(abs, dest);
      }
      // No node_modules anywhere up-tree of a tmpdir fixture, and no packages/*/dist → this is exactly
      // the fresh-checkout condition. A driver imports runLocalBootstrap and runs it; module-init must
      // succeed (build-lock-target.mjs is dep-free) and importDistModules must fail FAST with the hint
      // (dist absent, no build lock present → buildInProgress() false → give up), not hang or crash.
      const driver = join(base, 'bin', 'driver.mjs');
      writeFileSync(driver, "import { runLocalBootstrap } from './bootstrap-runner.js';\nawait runLocalBootstrap();\n");
      const res = await spawnCapture([driver], { cwd: base });
      assert.equal(res.code, 1, `fresh-checkout bootstrap must exit 1 (recovery hint), got code ${res.code}\n${res.out.slice(0, 600)}`);
      assert.ok(
        !/ERR_MODULE_NOT_FOUND|Cannot find package 'proper-lockfile'|Cannot find module 'proper-lockfile'/i.test(res.out),
        `fresh-checkout bootstrap must NOT crash on proper-lockfile at module-init:\n${res.out.slice(0, 600)}`,
      );
      assert.ok(
        // B-cc10: bin/bootstrap-runner.js prints 'proof-or-stop local bootstrap is not
        // ready'. Accept either brand so this assertion holds on pre- and post-rename trees.
        /(?:proof-or-stop|proofOrStop) local bootstrap is not ready/i.test(res.out) && /Recovery:/i.test(res.out),
        `fresh-checkout bootstrap must print the recovery hint:\n${res.out.slice(0, 600)}`,
      );
      console.log('VI-OK C3:depfree:2');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log('PASS red-1734-bootstrap-depfree: bootstrap-runner is proper-lockfile-free (imports the dep-free build-lock-target.mjs) and a fresh checkout prints the recovery hint instead of ERR_MODULE_NOT_FOUND');
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
