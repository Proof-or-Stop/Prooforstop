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
 * SCOPE — static versus dynamic reachability (B-bcae F-035). Everything this file asserts about an
 * "import graph" is about the STATIC graph: the modules Node loads at module-init, before
 * runLocalBootstrap's try/catch exists. That is the only graph whose third-party content can kill the
 * process before the recovery hint can print, and it is the property B-1734 C3 bought.
 * bin/bootstrap-runner.js ALSO reaches first-party modules DYNAMICALLY, after it has confirmed dist is
 * present — today scripts/build-lock.mjs, which does import proper-lockfile. That is deliberate and is
 * NOT a violation of the static property; it is covered separately by depfree:4 below, and the set of
 * such dynamic helpers is pinned in DYNAMIC_FIRST_PARTY_SCRIPTS. That pin recognises one spelling, so
 * on its own it could not deliver the "cannot slip in uncovered" promise (B-bcae F-039); depfree:0 also
 * classifies EVERY dynamic import() site in the file and FAILS on any shape it cannot resolve to a
 * pinned first-party helper, a compiled dist constant or a bare package. The two together are what make
 * a new dynamic scripts/ helper fail this file until it is listed AND covered.
 *
 * Proof (each `VI-OK` prints only after a real assert):
 *   0. STATIC graph: bin/bootstrap-runner.js does not STATICALLY import build-lock.mjs and DOES
 *      statically import build-lock-target.mjs; build-lock-target.mjs references no proper-lockfile and
 *      imports ONLY node: built-ins; and bootstrap's dynamic first-party helpers are exactly the pinned set.
 *   3. TRANSITIVE STATIC graph: no module reachable by static import from bootstrap imports anything
 *      but node: built-ins and other first-party relative modules.
 *   1. LOAD: build-lock-target.mjs and bin/bootstrap-runner.js both import cleanly (module-init does not
 *      throw) and expose their expected bindings.
 *   2. FRESH-CHECKOUT SPAWN (no dist, no node_modules): runLocalBootstrap prints the recovery hint and
 *      exits 1 — never ERR_MODULE_NOT_FOUND / "Cannot find package 'proper-lockfile'".
 *   4. DYNAMIC BOUNDARY SPAWN (dist PRESENT, no node_modules): control reaches the dynamic helper
 *      import; the unresolvable dependency must still be reported through printBootstrapFailure with
 *      actionable recovery, never as an unhandled ERR_MODULE_NOT_FOUND crash.
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
const LOCK_REL = 'scripts/build-lock.mjs';
const LOCKFILE_RE = /proper-lockfile/;
// First-party repo modules bin/bootstrap-runner.js reaches by DYNAMIC import (never at module-init).
// These are outside the static dep-free guarantee on purpose, so every one of them must be covered by
// the depfree:4 boundary case below. depfree:0 pins this list against the source AND fails closed on any
// dynamic import shape the pin cannot see, so adding a new dynamic scripts/ helper — in ANY spelling —
// fails this file until it is listed AND covered.
const DYNAMIC_FIRST_PARTY_SCRIPTS = [LOCK_REL];

// Bootstrap's dynamic first-party imports are written `import(pathToFileURL(join(repoRoot, …)).href)`.
// Its other dynamic imports resolve compiled dist entries through precomputed constants (MAIN_DIST,
// UTILS_DIST, LAB_DIST, BRAND_ENV_DIST) or bare packages loaded only after dist is live, so they are
// build outputs rather than first-party repo source and are not part of this set.
function collectDynamicRepoRootImports(src) {
  const found = [];
  for (const match of src.matchAll(/import\(\s*pathToFileURL\(\s*join\(\s*repoRoot\s*,([^)]*)\)\s*\)\.href\s*\)/g)) {
    const segments = [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(part => part[1] ?? part[2]);
    if (segments.length > 0) found.push(segments.join('/'));
  }
  return [...new Set(found)].sort();
}

// FAIL-CLOSED CATCH-ALL for the collector above (B-1734 C3 / B-bcae F-039).
//
// The pin `deepEqual(collectDynamicRepoRootImports(src), DYNAMIC_FIRST_PARTY_SCRIPTS)` recognises ONE
// spelling. A new dynamic first-party helper written any other ordinary way — `import('../scripts/x.mjs')`,
// `import(pathToFileURL(resolve(repoRoot, …)).href)`, `import(new URL('../scripts/x.mjs', import.meta.url).href)`,
// or a path hoisted into a local variable — is INVISIBLE to it: the collector still returns the pinned
// list, the deepEqual still passes, and the new helper ships uncovered by depfree:4. That is the exact
// opposite of the property the header claims, so the promise is only as good as this second half.
//
// So classify EVERY `import(` site instead of only the recognised one, and require each to fall in a
// known bucket. Buckets, and why each is out of the pinned set:
//   * repoRootJoin  — the recognised first-party shape; it IS the pinned set.
//   * distConstant  — `import(pathToFileURL(<MODULE_LEVEL_CONST>).href)`, a compiled packages/*/dist
//                     entry resolved through a constant declared in this file's own header block.
//   * bare          — `import('<bare-specifier>')`, a node_modules package, loaded only after dist is
//                     live and covered by depfree:4's missing-dependency assertion.
// Anything else is UNCLASSIFIED and FAILS, naming the raw text, rather than being skipped. Refusing to
// guess is the point: a shape this cannot resolve is precisely how an uncovered helper slips in.
const DIST_CONSTANT_NAMES = new Set(['MAIN_DIST', 'UTILS_DIST', 'LAB_DIST', 'BRAND_ENV_DIST']);
// Blank out comments, preserving string contents, so PROSE about an import site is never classified as
// one. Tracks ' " ` and both comment forms; it does not track regex literals, so the caller asserts the
// stripped text still carries the code markers it must.
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
function classifyDynamicImports(src) {
  // Walk to the matching ')' so a nested call in the argument list cannot truncate the site.
  const sites = [];
  const re = /\bimport\(/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
    }
    const raw = src.slice(match.index, i);
    const inner = src.slice(match.index + match[0].length, i - 1).trim();
    let kind = 'unclassified';
    if (/^pathToFileURL\(\s*join\(\s*repoRoot\s*,[^)]*\)\s*\)\.href$/.test(inner)) kind = 'repoRootJoin';
    else if (DIST_CONSTANT_NAMES.has((/^pathToFileURL\(\s*([A-Za-z_$][\w$]*)\s*\)\.href$/.exec(inner) ?? [])[1])) kind = 'distConstant';
    else if (/^'[^'./][^']*'$|^"[^"./][^"]*"$/.test(inner)) kind = 'bare';
    sites.push({ kind, raw, inner });
  }
  return sites;
}

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
      'bin/bootstrap-runner.js must not STATICALLY import ../scripts/build-lock.mjs: a module-init import ' +
        'pulls in proper-lockfile and ERR_MODULE_NOT_FOUNDs in a fresh checkout BEFORE runLocalBootstrap\'s ' +
        'try/catch can print the recovery hint. Reaching that helper by DYNAMIC import after dist is known ' +
        'to exist is allowed and is covered by depfree:4',
    );
    assert.ok(
      /from\s+['"][^'"]*build-lock-target\.mjs['"]/.test(bootSrc),
      'bin/bootstrap-runner.js must import the lock target + stale threshold from the dependency-free ../scripts/build-lock-target.mjs',
    );
    // A prose mention of proper-lockfile in a comment is fine; what matters is that it is never
    // STATICALLY imported (directly or transitively). Assert none of bootstrap's own static import
    // specifiers is proper-lockfile.
    const bootImportSpecs = [...bootSrc.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(
      !bootImportSpecs.some(spec => LOCKFILE_RE.test(spec)),
      `bin/bootstrap-runner.js must not statically import proper-lockfile; its static import specifiers are ${JSON.stringify(bootImportSpecs)}`,
    );

    // Pin the DYNAMIC first-party helpers. This is the honest counterpart to the static assertions
    // above: they say nothing about modules loaded after module-init, so the set of those modules is
    // fixed here and each one is exercised by depfree:4. A new dynamic scripts/ helper fails here.
    assert.deepEqual(
      collectDynamicRepoRootImports(bootSrc),
      [...DYNAMIC_FIRST_PARTY_SCRIPTS].sort(),
      'bin/bootstrap-runner.js\'s dynamic first-party helpers must be exactly DYNAMIC_FIRST_PARTY_SCRIPTS. ' +
        'A dynamic helper is outside the static dep-free guarantee, so adding one requires listing it here ' +
        'and covering it in the depfree:4 dist-present/no-node_modules boundary case',
    );

    // FAIL CLOSED on any dynamic import shape the pin above cannot see. Without this the pin is a
    // claim about one spelling: a new first-party helper written any other way leaves the collector
    // returning the pinned list unchanged, so the deepEqual passes and the helper ships uncovered
    // (B-bcae F-039). Classify every site instead, and fail naming an unrecognised one.
    const bootCode = stripComments(bootSrc);
    assert.ok(
      bootCode.includes('withDistImportLock') && bootCode.includes('runLocalBootstrap'),
      'the comment stripper mangled bin/bootstrap-runner.js: its code markers are gone, so the ' +
        'classification below would be about the wrong text',
    );
    const dynamicSites = classifyDynamicImports(bootCode);
    assert.ok(
      dynamicSites.length > 0,
      'found no dynamic import() site in bin/bootstrap-runner.js — it loads dist entries dynamically, ' +
        'so an empty result means the scanner broke, not that the imports are gone',
    );
    assert.deepEqual(
      dynamicSites.filter(site => site.kind === 'unclassified').map(site => site.raw),
      [],
      'bin/bootstrap-runner.js contains dynamic import() shapes this guard cannot resolve, so it cannot ' +
        'prove they are either pinned first-party helpers (covered by depfree:4), compiled dist entries, ' +
        'or bare packages. Write the import in a recognised form — ' +
        'import(pathToFileURL(join(repoRoot, \'<literal>\', …)).href), ' +
        'import(pathToFileURL(<MODULE_LEVEL_DIST_CONST>).href) or import(\'<bare-specifier>\') — or teach ' +
        'classifyDynamicImports() the new shape. Refusing to guess is deliberate: an unrecognised ' +
        'first-party spelling is exactly how a helper reaches production uncovered by depfree:4',
    );
    // And the recognised first-party bucket must be the same set the pin above compared, so the two
    // halves cannot disagree about which sites are first-party.
    assert.deepEqual(
      [...new Set(dynamicSites.filter(site => site.kind === 'repoRootJoin')
        .flatMap(site => collectDynamicRepoRootImports(site.raw)))].sort(),
      [...DYNAMIC_FIRST_PARTY_SCRIPTS].sort(),
      'the classified first-party dynamic import sites must resolve to exactly DYNAMIC_FIRST_PARTY_SCRIPTS',
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

  // ── depfree:3 — TRANSITIVE: bootstrap's WHOLE STATIC graph is third-party-free (module-init sans node_modules) ─
  // Guard the entire STATICALLY reachable graph, not just bootstrap's direct imports: no first-party
  // module in it may import a bare/third-party specifier (that needs node_modules and reintroduces the
  // proper-lockfile-class module-init crash). collectStaticGraph follows only top-level `import … from`
  // statements, so this covers exactly what Node loads before any of bootstrap's code runs — and
  // therefore says NOTHING about dynamically imported helpers. Those are pinned by depfree:0 and
  // exercised by depfree:4; do not read this assertion as covering them.
  {
    const graph = collectStaticGraph(join(repoRoot, BOOTSTRAP_REL));
    const scriptModules = [...graph].map(toRepoRel).filter(r => r.startsWith('scripts/'));
    assert.ok(scriptModules.includes(TARGET_REL), `bootstrap's static graph must include ${TARGET_REL}`);
    assert.ok(
      scriptModules.length >= 1,
      `bootstrap must depend on at least the dep-free build-lock-target.mjs scripts/ module; got ${JSON.stringify(scriptModules)}`,
    );
    assert.ok(
      !scriptModules.includes(LOCK_REL),
      `${LOCK_REL} must stay OUT of the static graph (it imports proper-lockfile); it is reached dynamically`,
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
      `every module in bin/bootstrap-runner.js's STATIC import graph must import ONLY node: built-ins or ` +
        `other first-party dep-free modules so a fresh checkout completes module-init without node_modules; ` +
        `found third-party static imports: ${JSON.stringify(thirdPartyImports)}`,
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
      // Copy EVERY first-party module in bootstrap's STATIC import graph (bootstrap-runner.js +
      // build-lock-target.mjs + …). For the never-built condition this fixture is faithful: control
      // cannot reach a dynamic helper, because dist is absent, so the static graph is the whole of what
      // Node loads. (It deliberately does NOT copy the dynamic helpers — that is depfree:4's fixture.)
      // If bootstrap gains a new dep-free scripts/ module this keeps copying it, so the test stays
      // honest that module-init loads without node_modules.
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

  // ── depfree:4 — DYNAMIC BOUNDARY: dist PRESENT, no node_modules → actionable failure, not a crash ──
  // depfree:0/2/3 only reach module-init. Once dist EXISTS, bootstrap goes on to dynamically import
  // scripts/build-lock.mjs for reader admission, and that helper does need proper-lockfile — so this
  // fixture is the only executable case in this file that reaches the dynamic helper boundary at all.
  //
  // What is asserted, precisely: the unresolvable dependency must be SURFACED through
  // printBootstrapFailure with recovery a reader can act on, and must NOT escape as an unhandled
  // ERR_MODULE_NOT_FOUND stack (the B-1734 property, extended past module-init). It is deliberately NOT
  // asserted that a dist-present/no-node_modules tree starts successfully — shipping the dependency
  // closure alongside a compiled dist is a packaging concern, tracked separately. If bootstrap ever
  // stops needing a third-party helper here, REWRITE this case to assert the success path; do not
  // delete it, or the boundary goes back to being unexercised.
  {
    const base = mkdtempSync(join(tmpdir(), 'red-1734-depfree-dist-'));
    try {
      writeFileSync(join(base, 'package.json'), '{"type":"module"}\n');
      for (const abs of collectStaticGraph(join(repoRoot, BOOTSTRAP_REL))) {
        const dest = join(base, toRepoRel(abs));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(abs, dest);
      }
      // The pinned dynamic helpers too — without them control would die on a missing first-party
      // MODULE rather than reaching the missing third-party PACKAGE this case is about.
      for (const rel of DYNAMIC_FIRST_PARTY_SCRIPTS) {
        const dest = join(base, rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(repoRoot, rel), dest);
      }
      // Both entry artifacts bootstrap probes with existsSync, so the presence check passes and the
      // "genuine never-built repo" give-up branch is NOT the path under test.
      for (const rel of ['packages/main/dist/cli-engine.js', 'packages/utils/dist/index.js']) {
        const dest = join(base, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, 'export const stub = true;\n');
      }
      assert.ok(!existsSync(join(base, 'node_modules')), 'the boundary fixture must have no node_modules');

      const driver = join(base, 'bin', 'driver.mjs');
      writeFileSync(driver, "import { runLocalBootstrap } from './bootstrap-runner.js';\nawait runLocalBootstrap();\n");
      const res = await spawnCapture([driver], { cwd: base });

      assert.equal(res.code, 1, `dist-present/no-node_modules bootstrap must exit 1, got code ${res.code}\n${res.out.slice(0, 800)}`);
      assert.ok(
        !/Missing build artifacts:/.test(res.out),
        `both dist entries exist, so this run must NOT take the never-built branch — it must reach the ` +
          `dynamic helper import:\n${res.out.slice(0, 800)}`,
      );
      assert.ok(
        /Cannot find package 'proper-lockfile'/.test(res.out),
        `control must reach the dynamic reader-admission helper and report the real cause (the ` +
          `unresolvable proper-lockfile package):\n${res.out.slice(0, 800)}`,
      );
      assert.ok(
        !/ERR_MODULE_NOT_FOUND/.test(res.out),
        `the missing dependency must be HANDLED by printBootstrapFailure, not escape as an unhandled ` +
          `ERR_MODULE_NOT_FOUND stack:\n${res.out.slice(0, 800)}`,
      );
      assert.ok(
        /(?:proof-or-stop|proofOrStop) local bootstrap is not ready/i.test(res.out) && /Recovery:/i.test(res.out),
        `the dynamic-boundary failure must still print the recovery hint:\n${res.out.slice(0, 800)}`,
      );
      assert.ok(
        /Missing runtime dependency: proper-lockfile/.test(res.out) && /npm install/.test(res.out),
        `an unresolvable BARE package means dependencies are missing, so the recovery must name ` +
          `installing them — "run the build" alone is not actionable here:\n${res.out.slice(0, 800)}`,
      );
      console.log('VI-OK C3:depfree:4');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log(
    'PASS red-1734-bootstrap-depfree: bootstrap-runner\'s STATIC import graph is proper-lockfile-free ' +
      '(it statically imports only the dep-free build-lock-target.mjs), its dynamic first-party helpers are ' +
      'pinned, a never-built fresh checkout prints the recovery hint instead of ERR_MODULE_NOT_FOUND, and the ' +
      'dist-present/no-node_modules dynamic boundary reports the missing dependency actionably instead of crashing',
  );
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
