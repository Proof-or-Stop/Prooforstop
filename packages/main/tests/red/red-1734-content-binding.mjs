#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 CHK-002 — the content-bound skip gate (verifyBuildBinding /
 * verifyUtilsBuildBinding), which replaces the mtime/existence checks that Codex flagged on B-fb7b.
 *
 * The build scripts SKIP iff their verify passes and REBUILD iff it throws, so proving the verify
 * gate is sensitive to each hazard IS proving the build rebuilds on it. Every case runs against an
 * ISOLATED temp fixture (never the shared worktree dist):
 *   - happy: verify passes on a clean build → skip.
 *   - edge:4 / adversarial:2: a source .ts change (or existence-only dist/index.js present but source
 *     changed) makes sourceDigest mismatch → verify throws → rebuild (not an existsSync skip).
 *   - edge:0: a DELETED-source orphan (dist .js left behind) changes sourceDigest → verify throws.
 *   - edge:1: a PARTIAL build (missing non-index dist .js) changes distDigest → verify throws.
 *   - adversarial:0: a TAMPERED non-index dist .js changes distDigest → verify throws.
 *   - adversarial:3: an ABSENT manifest → verify throws (ENOENT), treated as "not verified" → rebuild.
 *   - adversarial:1: a STALE manifest (forged sourceDigest) → verify RECOMPUTES from source and
 *     rejects it (it does not trust the manifest's claim).
 *   - utils edge:2 / happy:2: the utils binding folds in packages/main/dist, so a main/dist change
 *     makes the utils sourceDigest mismatch → verify throws → utils rebuilds; unchanged → skip.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST,
  BUILD_UTILS_MANIFEST,
  verifyBuildBinding,
  verifyUtilsBuildBinding,
  writeBuildBinding,
  writeUtilsBuildBinding,
} from '../../../../scripts/full-suite-build-binding.mjs';

const write = (root, rel, body) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

// A minimal but faithful two-package tree: packages/main (src+config+dist) and packages/utils
// (src+config+dist). Both bindings are written so a clean fixture verifies (the skip state).
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-1734-content-'));
  write(root, 'packages/main/src/index.ts', 'export const a = 1;\n');
  write(root, 'packages/main/src/util.ts', 'export const b = 2;\n');
  write(root, 'packages/main/tsconfig.json', '{}\n');
  write(root, 'packages/main/package.json', '{"name":"@lattice/core"}\n');
  write(root, 'packages/main/dist/index.js', 'export const a = 1;\n');
  write(root, 'packages/main/dist/util.js', 'export const b = 2;\n');
  write(root, 'packages/main/dist/sub/deep.js', 'export const c = 3;\n');
  write(root, 'packages/utils/src/index.ts', "import { a } from '@lattice/core';\nexport const u = a;\n");
  write(root, 'packages/utils/tsconfig.json', '{}\n');
  write(root, 'packages/utils/package.json', '{"name":"@lattice/utils"}\n');
  write(root, 'packages/utils/dist/index.js', 'export const u = 1;\n');
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

// ── happy: a clean fixture verifies (skip) ──────────────────────────────────
{
  const root = makeFixture();
  try {
    assert.doesNotThrow(() => verifyBuildBinding(root), 'clean main dist must verify (skip)');
    assert.doesNotThrow(() => verifyUtilsBuildBinding(root), 'clean utils dist must verify (skip)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── edge:4 / adversarial:2 — source change (index.js exists, source changed) → rebuild ──
{
  const root = makeFixture();
  try {
    write(root, 'packages/main/src/index.ts', 'export const a = 1; // touched\n');
    throws(() => verifyBuildBinding(root),
      'a source change must make verifyBuildBinding throw even though dist/index.js still exists (content-bound, not existsSync)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── edge:0 — deleted-source orphan (dist .js left behind) → rebuild ─────────
{
  const root = makeFixture();
  try {
    rmSync(join(root, 'packages/main/src/util.ts')); // dist/util.js remains as an orphan
    throws(() => verifyBuildBinding(root),
      'a deleted source (leaving an orphan dist .js) must change sourceDigest and make verify throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── edge:1 — partial/interrupted build (missing non-index dist .js) → rebuild ──
{
  const root = makeFixture();
  try {
    rmSync(join(root, 'packages/main/dist/sub/deep.js'));
    throws(() => verifyBuildBinding(root),
      'a missing non-index dist file (partial build) must change distDigest and make verify throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── adversarial:0 — tampered non-index dist .js (not index, not the manifest) → rebuild ──
{
  const root = makeFixture();
  try {
    write(root, 'packages/main/dist/util.js', 'export const b = 2; // tampered\n');
    throws(() => verifyBuildBinding(root),
      'tampering ANY dist file (here a non-index .js) must change distDigest and make verify throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── adversarial:3 — absent manifest → verify throws (not "assume fresh") ────
{
  const root = makeFixture();
  try {
    rmSync(join(root, BUILD_MANIFEST));
    throws(() => verifyBuildBinding(root),
      'a missing binding manifest must make verify throw (ENOENT) so the caller rebuilds, not silently skips');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── adversarial:1 — stale manifest with a forged sourceDigest → verify recomputes and rejects ──
{
  const root = makeFixture();
  try {
    const manifestPath = join(root, BUILD_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.sourceDigest = 'deadbeef'.repeat(8); // a plausible-looking but wrong claim
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    throws(() => verifyBuildBinding(root),
      'verify must RECOMPUTE sourceDigest from disk and reject a forged manifest claim (not trust the recorded digest)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── utils edge:2 / happy:2 — utils binding folds in packages/main/dist ──────
{
  const root = makeFixture();
  try {
    assert.doesNotThrow(() => verifyUtilsBuildBinding(root), 'unchanged utils fixture must verify (skip)');
    // Change packages/main/dist (what utils tsc links against) → utils sourceDigest must mismatch.
    write(root, 'packages/main/dist/util.js', 'export const b = 2; // main dist rebuilt\n');
    throws(() => verifyUtilsBuildBinding(root),
      'a packages/main/dist change must make the utils binding stale (its sourceDigest folds in main/dist) so utils rebuilds');
    // A missing utils manifest is likewise unverifiable.
    write(root, 'packages/main/dist/util.js', 'export const b = 2; // main dist rebuilt\n');
    writeUtilsBuildBinding(root); // re-sync so only the manifest-absence changes below
    rmSync(join(root, BUILD_UTILS_MANIFEST));
    throws(() => verifyUtilsBuildBinding(root),
      'a missing utils manifest must make verifyUtilsBuildBinding throw (rebuild, not assume-fresh)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('PASS red-1734-content-binding: verifyBuildBinding/verifyUtilsBuildBinding skip on match and reject source-change, orphan, partial, tamper, absent-manifest, forged-manifest, and main/dist drift');
