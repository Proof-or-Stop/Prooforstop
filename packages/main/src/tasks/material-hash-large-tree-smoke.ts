#!/usr/bin/env node

/**
 * B-f492 CHK-002 regression smoke: currentMaterialHash on a >1 MiB ls-tree.
 *
 * BUG (the thing this guards): evidence-freshness.ts called
 *   execFileSync('git', ['ls-tree','-r','-z','HEAD'], { ... })
 * with NO `maxBuffer`. Node's default execFileSync maxBuffer is 1 MiB
 * (1,048,576 bytes). Once a repo's `git ls-tree -r -z HEAD` output exceeds that,
 * the call throws ENOBUFS, the surrounding try/catch swallows it, and
 * currentMaterialHash returns `undefined` — silently breaking materialHash
 * repo-wide (review_run_start, escalation/assurance-floor verdicts, evidence
 * freshness, the DONE gate).
 *
 * This smoke builds a throwaway git repo whose `git ls-tree -r -z HEAD` output
 * byte length EXCEEDS 1,048,576, asserts that precondition explicitly (a fixture
 * under 1 MiB would never exercise the bug), then asserts:
 *   1. currentMaterialHash(repoRoot) returns a DEFINED 64-hex sha256 (not undefined).
 *   2. Calling it twice returns the SAME hash (stable).
 *   3. currentStoryFilesHash over a large diff also returns a defined hash.
 *
 * On the PRE-FIX code the >1 MiB ls-tree throws ENOBUFS → currentMaterialHash
 * returns undefined → assertion (1) fails and the smoke exits non-zero. So this
 * is a genuine regression guard, not a tautology.
 */

import { strict as assert } from 'node:assert';
import { execSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';

const ONE_MIB = 1024 * 1024; // 1,048,576 bytes — Node's default execFileSync maxBuffer.

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function lsTreeByteLength(cwd: string): number {
  // The exact call evidence-freshness.ts makes, but with a huge buffer so the
  // smoke itself can measure the output even when it exceeds 1 MiB.
  const buf = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
    cwd,
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  });
  return buf.length;
}

const base = mkdtempSync(join(tmpdir(), 'material-hash-large-tree-smoke-'));
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 200;

/**
 * macOS can briefly retain directory entries after the final git child exits.
 * Keep cleanup bounded, and let the primary assertion failure remain the
 * reported cause if fixture removal also encounters that transient state.
 */
function cleanupFixture(): void {
  rmSync(base, {
    recursive: true,
    force: true,
    maxRetries: CLEANUP_RETRIES,
    retryDelay: CLEANUP_RETRY_DELAY_MS,
  });
}

try {
  // ── Build a git repo whose ls-tree -r -z output exceeds 1 MiB ───────────────
  git('init -b main', base);
  git('config user.email smoke@test.local', base);
  git('config user.name smoke', base);
  git('config commit.gpgsign false', base);

  // A proof-or-stop.config.json so the metadata-exclusion path (loadConfig) loads the
  // same way the production code path does on a real project.
  writeFileSync(join(base, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives' }, null, 2));

  // ls-tree -r emits one NUL-terminated record per file:
  //   <mode> <type> <objectid>\t<path>\0
  // i.e. "100644 blob <40-hex>\t<path>\0" ≈ 54 bytes of fixed overhead + path.
  // We use long, deterministic paths so a few thousand files clear 1 MiB with
  // margin. 6000 files × (~54 + ~130-byte path) ≈ ~1.1 MiB of ls-tree output.
  const FILE_COUNT = 6000;
  const PATH_SEGMENT = 'material_hash_large_tree_regression_fixture_segment'; // 50 chars
  const srcDir = join(base, 'src', 'generated');
  mkdirSync(srcDir, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    const idx = String(i).padStart(5, '0');
    // ~130-char relative path per file (well above the ~54-byte record overhead).
    const name = `${PATH_SEGMENT}_${idx}_${PATH_SEGMENT}_${idx}.ts`;
    writeFileSync(join(srcDir, name), `export const v${idx} = ${i};\n`);
  }
  git('add -A', base);
  git('commit -m fixture', base);

  // ── PRECONDITION: ls-tree -r -z HEAD output must EXCEED 1 MiB ────────────────
  const treeBytes = lsTreeByteLength(base);
  assert.ok(
    treeBytes > ONE_MIB,
    `fixture precondition: git ls-tree -r -z HEAD must exceed ${ONE_MIB} bytes to exercise the >1 MiB ENOBUFS path, got ${treeBytes}`,
  );
  console.log(`fixture ls-tree -r -z HEAD byte length: ${treeBytes} (> ${ONE_MIB} = 1 MiB) across ${FILE_COUNT} files`);

  // ── ASSERTION 1: defined 64-hex sha256 (pre-fix this is undefined → fails) ──
  const hash = currentMaterialHash(base);
  assert.ok(
    hash !== undefined,
    'currentMaterialHash returned undefined on a >1 MiB tree — the ENOBUFS regression (pre-fix behavior)',
  );
  assert.match(
    hash as string,
    /^[0-9a-f]{64}$/,
    `currentMaterialHash must be a 64-hex sha256, got: ${String(hash)}`,
  );

  // ── ASSERTION 2: stable across repeated calls ───────────────────────────────
  const hash2 = currentMaterialHash(base);
  assert.equal(hash2, hash, 'currentMaterialHash must be stable across repeated calls on an unchanged tree');

  // ── ASSERTION 3: currentStoryFilesHash over a large diff is also defined ─────
  // Make a second branch off main with a large material change so the diff path
  // (which also threads the un-capped git diff / ls-tree calls) is exercised.
  git('checkout -b feature', base);
  const moreDir = join(base, 'src', 'feature');
  mkdirSync(moreDir, { recursive: true });
  for (let i = 0; i < 2000; i++) {
    const idx = String(i).padStart(5, '0');
    const name = `${PATH_SEGMENT}_feature_${idx}.ts`;
    writeFileSync(join(moreDir, name), `export const f${idx} = ${i};\n`);
  }
  git('add -A', base);
  git('commit -m feature-change', base);

  const storyFilesHash = currentStoryFilesHash(base);
  assert.ok(
    storyFilesHash !== undefined,
    'currentStoryFilesHash returned undefined on a large diff — diff/ls-tree buffer regression',
  );
  assert.match(
    storyFilesHash as string,
    /^[0-9a-f]{64}$/,
    `currentStoryFilesHash must be a 64-hex sha256, got: ${String(storyFilesHash)}`,
  );

  console.log('material-hash-large-tree smoke passed');
} catch (err) {
  console.error('material-hash-large-tree smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
} finally {
  try {
    cleanupFixture();
  } catch (cleanupError) {
    console.error('material-hash-large-tree smoke fixture cleanup FAILED');
    console.error(cleanupError instanceof Error ? (cleanupError.stack ?? cleanupError.message) : String(cleanupError));
    // Do not replace a prior assertion failure with an incidental cleanup
    // failure, but still fail a passing smoke whose fixture leaked.
    process.exitCode = 1;
  }
}
