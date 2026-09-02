#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 CHK-002 — the content-bound skip gate (verifyBuildBinding /
 * verifyUtilsBuildBinding), which replaces the mtime/existence checks Codex flagged on B-fb7b.
 *
 * The build scripts SKIP iff their verify passes and REBUILD iff it throws. The happy/edge/adversarial
 * cases below prove the verify gate is SENSITIVE to each hazard against isolated temp fixtures; the
 * rebuild:* cases then close Codex #5 by exercising the REAL build end-to-end — after inducing a hazard on
 * the actual (gitignored) worktree dist they run `scripts/build-main-with-binding.mjs` and assert it
 * rebuilds a dist that then VERIFIES (and, for the orphan case, that the stray .js is gone). Each case
 * prints a distinct `VI-OK CHK-002:<sub>:<n>` marker ONLY after that case's real assertion passes (a
 * broken gate still fails, and no marker is emitted):
 *   happy:0        clean build from ABSENT dist → manifest written, verify passes
 *   happy:1        subsequent run, no change → verify passes AND dist is byte-unchanged (skip)
 *   happy:2        utils binding covers utils/src + main/dist → verify passes, re-verify skips
 *   edge:0         deleted-source orphan → sourceDigest changes → verify throws (rebuild)
 *   edge:1         partial build (missing non-index dist .js) → distDigest changes → verify throws
 *   edge:2         packages/main/dist change → utils sourceDigest changes → utils verify throws
 *   edge:3         skip is READ-ONLY (no rm/write side effect) → concurrent same-HEAD reads are safe
 *   edge:4         a source .ts change → sourceDigest changes → verify throws
 *   adversarial:0  tampered non-index dist .js → distDigest changes → verify throws
 *   adversarial:1  forged manifest sourceDigest → verify RECOMPUTES from source and rejects it
 *   adversarial:2  dist/index.js PRESENT but source changed → verify throws (content, not existsSync)
 *   adversarial:3  absent manifest → verify throws (ENOENT), treated as "not verified" → rebuild
 *   adversarial:4  code: ensure-dist is content-bound (no existsSync) and both build scripts verify
 *   adversarial:5  code: build-main-with-binding.mjs uses verifyBuildBinding as its skip gate
 *   rebuild:0      REAL build: orphan stray dist .js → verify throws → build removes it → verify passes
 *   rebuild:1      REAL build: missing non-index dist .js (partial) → build restores it → verify passes
 *   rebuild:2      REAL build: tampered dist .js → build overwrites from source → verify passes
 *   rebuild:3      REAL build: absent manifest → build rewrites it → verify passes
 *
 * Every happy/edge/adversarial destructive case runs against an ISOLATED temp fixture; the rebuild:* cases
 * run the REAL build against the actual worktree dist (gitignored, so the tree stays clean) and always
 * restore a clean, verifying dist at the end (try/finally).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST,
  BUILD_UTILS_MANIFEST,
  treeDigest,
  verifyBuildBinding,
  verifyUtilsBuildBinding,
  writeBuildBinding,
  writeUtilsBuildBinding,
} from '../../../../scripts/full-suite-build-binding.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Repo root is a fixed four levels up (packages/main/tests/red -> root) — the same
// relative anchor as the scripts/full-suite-build-binding.mjs import above, and the
// same idiom the genuine registration guards (e.g. red-w2c-validate-registration.mjs)
// use. Root is resolved by DEPTH, not by scanning for the root config file, on
// purpose: this is a build-concurrency RED test, not a registration decider, and
// red-b49d4-registration-derivation.mjs derives its target guards from red *.mjs that
// reference that config file AND enumerate a directory. Naming the config here (even
// only as a root-finding sentinel) would mis-derive this test into that meta-guard's
// symlink mirror, where treeDigest sees no real dist and verifyBuildBinding throws for
// a reason unrelated to anything this test asserts.
const repoRoot = join(here, '..', '..', '..', '..');
assert.ok(
  existsSync(join(repoRoot, 'scripts', 'full-suite-build-binding.mjs')),
  'could not locate repo root (expected scripts/full-suite-build-binding.mjs four levels above this test)',
);

const write = (root, rel, body) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

// A minimal but faithful two-package tree: packages/main (src+config+dist) and packages/utils
// (src+config+dist), WITHOUT the bindings.
function scaffold(root) {
  write(root, 'packages/main/src/index.ts', 'export const a = 1;\n');
  write(root, 'packages/main/src/util.ts', 'export const b = 2;\n');
  write(root, 'packages/main/tsconfig.json', '{}\n');
  write(root, 'packages/main/package.json', '{"name":"@proof-or-stop/core"}\n');
  write(root, 'packages/main/dist/index.js', 'export const a = 1;\n');
  write(root, 'packages/main/dist/util.js', 'export const b = 2;\n');
  write(root, 'packages/main/dist/sub/deep.js', 'export const c = 3;\n');
  write(root, 'packages/utils/src/index.ts', "import { a } from '@proof-or-stop/core';\nexport const u = a;\n");
  write(root, 'packages/utils/tsconfig.json', '{}\n');
  write(root, 'packages/utils/package.json', '{"name":"@proof-or-stop/utils"}\n');
  write(root, 'packages/utils/dist/index.js', 'export const u = 1;\n');
}

// A clean fixture whose bindings are written, i.e. the "verified, skip-ready" state.
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-1734-content-'));
  scaffold(root);
  writeBuildBinding(root);
  writeUtilsBuildBinding(root);
  return root;
}

const throws = (fn, label) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, label);
};
const withFixture = body => {
  const root = makeFixture();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// ── happy:0 — clean build from ABSENT dist → manifest written, verify passes ─
{
  const root = mkdtempSync(join(tmpdir(), 'red-1734-content-'));
  try {
    scaffold(root);
    assert.ok(!existsSync(join(root, BUILD_MANIFEST)), 'baseline: no main binding manifest before the build writes it');
    writeBuildBinding(root); // emulate the build recording its binding
    writeUtilsBuildBinding(root);
    assert.ok(existsSync(join(root, BUILD_MANIFEST)), 'the build must write the binding manifest');
    assert.doesNotThrow(() => verifyBuildBinding(root), 'a freshly built+bound dist must verify');
    console.log('VI-OK CHK-002:happy:0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── happy:1 — subsequent run, no change → verify passes AND dist unchanged (skip) ─
withFixture(root => {
  const before = treeDigest(root, 'dist');
  assert.doesNotThrow(() => verifyBuildBinding(root), 'unchanged dist must verify (skip)');
  assert.doesNotThrow(() => verifyBuildBinding(root), 're-verify must still pass (idempotent skip)');
  assert.equal(treeDigest(root, 'dist'), before, 'the skip decision must not mutate dist');
  console.log('VI-OK CHK-002:happy:1');
});

// ── happy:2 — utils binding covers utils/src + main/dist, subsequent build skips ─
withFixture(root => {
  assert.ok(existsSync(join(root, BUILD_UTILS_MANIFEST)), 'the utils build must write a utils binding manifest');
  assert.doesNotThrow(() => verifyUtilsBuildBinding(root), 'clean utils dist must verify (skip)');
  assert.doesNotThrow(() => verifyUtilsBuildBinding(root), 're-verify utils must still pass (idempotent skip)');
  console.log('VI-OK CHK-002:happy:2');
});

// ── edge:0 — deleted-source orphan → verify throws ──────────────────────────
withFixture(root => {
  rmSync(join(root, 'packages/main/src/util.ts')); // dist/util.js remains as an orphan
  throws(() => verifyBuildBinding(root), 'a deleted source (leaving an orphan dist .js) must change sourceDigest → verify throws');
  console.log('VI-OK CHK-002:edge:0');
});

// ── edge:1 — partial/interrupted build (missing non-index dist .js) → verify throws ─
withFixture(root => {
  rmSync(join(root, 'packages/main/dist/sub/deep.js'));
  throws(() => verifyBuildBinding(root), 'a missing non-index dist file (partial build) must change distDigest → verify throws');
  console.log('VI-OK CHK-002:edge:1');
});

// ── edge:2 — packages/main/dist change → utils binding stale → utils verify throws ─
withFixture(root => {
  assert.doesNotThrow(() => verifyUtilsBuildBinding(root), 'precondition: utils verifies before main/dist changes');
  write(root, 'packages/main/dist/util.js', 'export const b = 2; // main dist rebuilt\n');
  throws(() => verifyUtilsBuildBinding(root), 'a packages/main/dist change must make the utils binding stale (its sourceDigest folds in main/dist)');
  console.log('VI-OK CHK-002:edge:2');
});

// ── edge:3 — skip is READ-ONLY → concurrent same-HEAD reads are safe ─────────
withFixture(root => {
  const distBefore = treeDigest(root, 'dist');
  const manifestBefore = readFileSync(join(root, BUILD_MANIFEST), 'utf8');
  // The skip path is a pure read: verifying (even repeatedly, as concurrent readers would) must not
  // rm/write anything, so two concurrent `npm test` reads of the same dist cannot corrupt it.
  for (let i = 0; i < 3; i++) assert.doesNotThrow(() => verifyBuildBinding(root), 'skip must verify without side effects');
  assert.equal(treeDigest(root, 'dist'), distBefore, 'verifying (skip) must not modify any dist file');
  assert.equal(readFileSync(join(root, BUILD_MANIFEST), 'utf8'), manifestBefore, 'verifying (skip) must not rewrite the manifest');
  console.log('VI-OK CHK-002:edge:3');
});

// ── edge:4 — a source .ts change → verify throws ────────────────────────────
withFixture(root => {
  write(root, 'packages/main/src/index.ts', 'export const a = 1; // whitespace/comment change\n');
  throws(() => verifyBuildBinding(root), 'any source change must change sourceDigest → verify throws (not a coarse file-count hash)');
  console.log('VI-OK CHK-002:edge:4');
});

// ── adversarial:0 — tampered non-index dist .js (not index, not manifest) → verify throws ─
withFixture(root => {
  write(root, 'packages/main/dist/util.js', 'export const b = 2; // tampered\n');
  throws(() => verifyBuildBinding(root), 'tampering ANY dist file (here a non-index .js) must change distDigest → verify throws');
  console.log('VI-OK CHK-002:adversarial:0');
});

// ── adversarial:1 — forged manifest sourceDigest → verify recomputes and rejects ─
withFixture(root => {
  const manifestPath = join(root, BUILD_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.sourceDigest = 'deadbeef'.repeat(8); // a plausible-looking but wrong claim
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  throws(() => verifyBuildBinding(root), 'verify must RECOMPUTE sourceDigest from disk and reject a forged manifest (not trust the recorded digest)');
  console.log('VI-OK CHK-002:adversarial:1');
});

// ── adversarial:2 — dist/index.js PRESENT but source changed → content-bound, not existsSync ─
withFixture(root => {
  write(root, 'packages/main/src/index.ts', 'export const a = 42; // source changed after that dist was built\n');
  assert.ok(existsSync(join(root, 'packages/main/dist/index.js')), 'precondition: dist/index.js exists (an existence-only check would skip)');
  throws(() => verifyBuildBinding(root), 'with dist/index.js present but source changed, the content gate must still throw (build runs, not an existsSync skip)');
  console.log('VI-OK CHK-002:adversarial:2');
});

// ── adversarial:3 — absent manifest → verify throws (not "assume fresh") ─────
withFixture(root => {
  rmSync(join(root, BUILD_MANIFEST));
  throws(() => verifyBuildBinding(root), 'a missing binding manifest must make verify throw (ENOENT) so the caller rebuilds, not silently skips');
  console.log('VI-OK CHK-002:adversarial:3');
});

// ── adversarial:4 — code: ensure-dist content-bound; both build scripts verify ─
{
  const ensureSrc = readFileSync(join(repoRoot, 'scripts/ensure-dist.mjs'), 'utf8');
  const mainSrc = readFileSync(join(repoRoot, 'scripts/build-main-with-binding.mjs'), 'utf8');
  const utilsSrc = readFileSync(join(repoRoot, 'scripts/build-utils-with-binding.mjs'), 'utf8');
  assert.ok(!/existsSync/.test(ensureSrc), 'ensure-dist must NOT use existsSync (the old existence-only reuse) for its skip decisions');
  assert.ok(
    ensureSrc.includes('build-main-with-binding.mjs') && ensureSrc.includes('build-utils-with-binding.mjs'),
    'ensure-dist must delegate BOTH skip decisions to the content-bound build scripts',
  );
  assert.ok(/verifyBuildBinding\s*\(/.test(mainSrc), 'the main build script must gate its skip on verifyBuildBinding');
  assert.ok(/verifyUtilsBuildBinding\s*\(/.test(utilsSrc), 'the utils build script must gate its skip on verifyUtilsBuildBinding');
  console.log('VI-OK CHK-002:adversarial:4');
}

// ── adversarial:5 — code: build-main-with-binding.mjs uses verifyBuildBinding skip gate ─
{
  const mainSrc = readFileSync(join(repoRoot, 'scripts/build-main-with-binding.mjs'), 'utf8');
  assert.ok(/verifyBuildBinding\s*\(/.test(mainSrc), 'build-main-with-binding.mjs must skip via verifyBuildBinding when the binding already verifies');
  assert.ok(!/existsSync/.test(mainSrc), 'build-main-with-binding.mjs must NOT use existsSync as its skip gate (content-bound at every call site)');
  console.log('VI-OK CHK-002:adversarial:5');
}

// ── rebuild:* (Codex #5) — the REAL build rebuilds a verifying dist end-to-end after each core hazard ─
// The cases above prove verifyBuildBinding is SENSITIVE to each hazard against isolated fixtures, but a
// build SKIPS iff verify passes and REBUILDS iff it throws — so the true end-to-end guarantee is that
// after a real hazard the ACTUAL build (scripts/build-main-with-binding.mjs) produces a dist that then
// VERIFIES. These cases induce each core hazard on the REAL worktree dist (dist + the binding manifest
// are gitignored, so `git status` stays clean throughout), run the real build, and assert (a) it rebuilds
// and (b) verifyBuildBinding then PASSES (and, for the orphan case, the stray .js is gone). Wrapped in a
// try/finally that always rebuilds both packages, so a clean, verifying dist is restored even on failure.
{
  const mainDist = join(repoRoot, 'packages/main/dist');
  const runMainBuild = () => execFileSync(process.execPath, ['scripts/build-main-with-binding.mjs'], { cwd: repoRoot, stdio: 'pipe' });
  const runUtilsBuild = () => execFileSync(process.execPath, ['scripts/build-utils-with-binding.mjs'], { cwd: repoRoot, stdio: 'pipe' });
  // Pick a non-index, non-entrypoint dist .js to delete/tamper (a genuine "partial build" victim).
  const pickVictim = () =>
    readdirSync(mainDist, { recursive: true })
      .map(String)
      .find(rel => rel.endsWith('.js') && !rel.endsWith('index.js') && !rel.includes('cli-engine'));

  // Precondition: the real dists are present and verifying (build them if a prior step left them stale).
  runMainBuild();
  runUtilsBuild();
  assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'precondition: the real main dist must verify before the rebuild cases');

  try {
    // rebuild:0 — orphan: a stray dist .js with no source → verify throws → the fresh-staging build removes it.
    {
      const orphan = join(mainDist, '__b1734_orphan__.js');
      writeFileSync(orphan, 'export const ORPHAN = 1;\n');
      throws(() => verifyBuildBinding(repoRoot), 'a stray orphan dist .js must change distDigest → verify throws (pre-rebuild)');
      runMainBuild();
      assert.ok(!existsSync(orphan), 'rebuild:0: the fresh-staging rebuild must REMOVE the orphan dist .js (dist is rebuilt from source only)');
      assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'rebuild:0: the real build must rebuild a verifying dist after the orphan is induced');
      console.log('VI-OK CHK-002:rebuild:0');
    }

    // rebuild:1 — partial: a missing non-index dist .js → verify throws → the real build restores it.
    {
      const victimRel = pickVictim();
      assert.ok(victimRel, 'rebuild:1: expected a non-index dist .js to delete (partial-build induction)');
      const victim = join(mainDist, victimRel);
      rmSync(victim);
      throws(() => verifyBuildBinding(repoRoot), 'a missing non-index dist .js (partial build) must change distDigest → verify throws (pre-rebuild)');
      runMainBuild();
      assert.ok(existsSync(victim), 'rebuild:1: the real build must RESTORE the missing dist file');
      assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'rebuild:1: the real build must rebuild a verifying dist after a partial build is induced');
      console.log('VI-OK CHK-002:rebuild:1');
    }

    // rebuild:2 — tamper: a mutated dist .js → verify throws → the real build overwrites it from source.
    {
      const victimRel = pickVictim();
      assert.ok(victimRel, 'rebuild:2: expected a non-index dist .js to tamper');
      const victim = join(mainDist, victimRel);
      writeFileSync(victim, `${readFileSync(victim, 'utf8')}\n// b1734 tamper\n`);
      throws(() => verifyBuildBinding(repoRoot), 'a tampered dist .js must change distDigest → verify throws (pre-rebuild)');
      runMainBuild();
      assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'rebuild:2: the real build must rebuild a verifying dist after tampering (fresh staging overwrites the tamper)');
      console.log('VI-OK CHK-002:rebuild:2');
    }

    // rebuild:3 — absent manifest: the build's own skip trigger → verify throws → the real build rewrites it.
    {
      rmSync(join(repoRoot, BUILD_MANIFEST), { force: true });
      throws(() => verifyBuildBinding(repoRoot), 'an absent binding manifest must make verify throw (pre-rebuild)');
      runMainBuild();
      assert.ok(existsSync(join(repoRoot, BUILD_MANIFEST)), 'rebuild:3: the real build must rewrite the binding manifest');
      assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'rebuild:3: the real build must rebuild a verifying dist after the manifest is removed');
      console.log('VI-OK CHK-002:rebuild:3');
    }
  } finally {
    // Restore a clean built dist + verifying bindings regardless of outcome (dist/manifest are gitignored,
    // so the tree stays clean; utils folds main/dist, so rebuild it too in case main/dist bytes shifted).
    runMainBuild();
    runUtilsBuild();
  }
  assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'the rebuild cases must leave the main dist verifying (clean worktree)');
  assert.doesNotThrow(() => verifyUtilsBuildBinding(repoRoot), 'the rebuild cases must leave the utils dist verifying (clean worktree)');
}

console.log('PASS red-1734-content-binding: verifyBuildBinding/verifyUtilsBuildBinding skip on match and reject source-change, orphan, partial, tamper, absent-manifest, forged-manifest, and main/dist drift; and the REAL build rebuilds a verifying dist after an orphan/partial/tamper/absent-manifest hazard');
