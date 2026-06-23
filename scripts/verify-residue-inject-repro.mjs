#!/usr/bin/env node
/**
 * fbca-inject-check.mjs — proves the verify-lattice-residue.mjs gate has
 * zero-tolerance, *reproducible* detection of a newly introduced koala token
 * in product runtime source.
 *
 * Why this exists (B-fbca F-001): the gate enumerates scope files via
 * `git ls-files` (TRACKED only). An UNTRACKED inject is invisible to the gate,
 * so the earlier `echo ... > file && run gate` repro could never fail. This
 * script does the mechanically correct thing:
 *
 *   1. append a koala token line to a real product-source file under
 *      packages/main/src
 *   2. `git add` it  (now the inject is TRACKED and in ls-files scope)
 *   3. run `node scripts/verify-lattice-residue.mjs` and assert it EXITS 1 (FAIL)
 *   4. unconditionally restore: `git reset` the path + `git checkout --` the file
 *   5. re-run the gate and assert it returns to EXIT 0 (PASS) — proves a clean revert
 *
 * The cleanup runs in a finally block so a thrown assertion never leaves the
 * worktree dirty. Exit 0 = gate correctly caught the tracked inject and the
 * tree was restored clean; exit 1 = gate failed to catch it (or revert failed).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'packages/main/src/index.ts';
const targetAbs = join(repoRoot, TARGET);
const GATE = 'scripts/verify-lattice-residue.mjs';

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

/** Run the residue gate; return its exit code (0 PASS / 1 FAIL) without throwing. */
function runGate() {
  try {
    execFileSync('node', [GATE], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

const original = readFileSync(targetAbs, 'utf8');
let ok = false;

try {
  // 1. inject a koala token into a tracked product-source file
  appendFileSync(targetAbs, '\n// koala-inject-test-token (B-fbca F-001 repro)\n');
  // 2. stage it so it is visible to `git ls-files`
  git(['add', '--', TARGET]);

  // 3. the gate must now FAIL (exit 1) because the tracked file has residue
  const failCode = runGate();
  if (failCode !== 1) {
    throw new Error(
      `EXPECTED gate to FAIL (exit 1) on the tracked koala inject, but it exited ${failCode}. ` +
        'The zero-tolerance detection is NOT working.',
    );
  }
  console.log('OK   step 1: tracked koala inject -> gate exited 1 (FAIL caught it)');
  ok = true;
} finally {
  // 4. restore unconditionally: unstage + discard the working-tree edit
  try {
    git(['reset', '--quiet', '--', TARGET]);
  } catch {
    /* path may not be staged if we threw before add */
  }
  writeFileSync(targetAbs, original);
  git(['checkout', '--quiet', '--', TARGET]);
}

// 5. after revert, the gate must PASS again (exit 0) — proves a clean revert
const passCode = runGate();
if (passCode !== 0) {
  console.error(`FAIL: after revert the gate exited ${passCode}, expected 0 (tree not clean).`);
  process.exit(1);
}
console.log('OK   step 2: after git revert -> gate exited 0 (PASS, tree restored clean)');

if (!ok) {
  console.error('FAIL inject-check: detection step did not pass.');
  process.exit(1);
}
console.log('\nPASS inject-check: gate caught the tracked koala inject and the worktree was restored clean.');
process.exit(0);
