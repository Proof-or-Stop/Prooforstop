#!/usr/bin/env node
/**
 * fbca-inject-check.mjs — proves the verify-proof-or-stop-residue.mjs gate has
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
 *   3. run `node scripts/verify-proof-or-stop-residue.mjs` and assert it EXITS 1 (FAIL)
 *   4. unconditionally restore: `git reset` the path + `git checkout --` the file
 *   5. re-run the gate and assert it returns to EXIT 0 (PASS) — proves a clean revert
 *
 * The cleanup runs in a finally block so a thrown assertion never leaves the
 * worktree dirty. Exit 0 = gate correctly caught the tracked inject and the
 * tree was restored clean; exit 1 = gate failed to catch it (or revert failed).
 *
 * B-cc10 CHK-007: extended to ALSO prove CHECK 4 (the exempt -> FORBIDDEN row
 * flip) is enforcing rather than merely reporting. The two injects are different
 * shapes on purpose:
 *
 *   - koala token         -> proves the zero-tolerance presence check (check 1)
 *   - `.startsWith('.proof-or-stop/')` -> proves the forbidden DECISION check (check 4)
 *
 * The second inject is the exact defect class the row flip exists to catch: a
 * DEPRECATED brand literal used as a path comparison, which recognizes only the
 * old spelling so the CANONICAL name silently fails. A gate only ever observed
 * PASSing is not a gate, so each inject asserts exit 1 and each revert asserts
 * exit 0.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// B-cc10 CHK-007: reuse the gate's OWN token derivation so the forbidden-decision
// inject is built from the same constants the gate forbids. Importing the gate also
// runs its inline self-test at module load, so a detector regression fails here too.
import { readDeprecatedBrandTokens } from './verify-proof-or-stop-residue.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'packages/main/src/index.ts';
const targetAbs = join(repoRoot, TARGET);
const GATE = 'scripts/verify-proof-or-stop-residue.mjs';

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

/**
 * Inject `line` into the tracked target, assert the gate FAILS, then restore and
 * assert the gate PASSES again.
 *
 * Restoration is unconditional (finally) so a thrown assertion never leaves the
 * worktree dirty, and the post-revert PASS is asserted for every inject rather
 * than once at the end — otherwise a later inject could mask an unclean revert.
 *
 * @param {string} label human-readable name of the shape under test
 * @param {string} line  the residue line to append
 */
function assertGateCatches(label, line) {
  const original = readFileSync(targetAbs, 'utf8');
  try {
    // 1. inject, 2. stage it so it is visible to `git ls-files`
    appendFileSync(targetAbs, line);
    git(['add', '--', TARGET]);

    // 3. the gate must now FAIL (exit 1) because the tracked file has residue
    const failCode = runGate();
    if (failCode !== 1) {
      throw new Error(
        `EXPECTED gate to FAIL (exit 1) on the tracked ${label} inject, but it exited ${failCode}. ` +
          'That detection is NOT working.',
      );
    }
    console.log(`OK   ${label}: tracked inject -> gate exited 1 (FAIL caught it)`);
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
    console.error(`FAIL: after reverting the ${label} inject the gate exited ${passCode}, expected 0 (tree not clean).`);
    process.exit(1);
  }
  console.log(`OK   ${label}: after git revert -> gate exited 0 (PASS, tree restored clean)`);
}

// Check 1 (B-fbca F-001): zero-tolerance koala presence.
assertGateCatches('koala token', '\n// koala-inject-test-token (B-fbca F-001 repro)\n');

// Check 4 (B-cc10 CHK-007): a DEPRECATED brand literal used as a path DECISION.
// Built at runtime from the deprecated state-dir constant the gate itself derives,
// so this repro cannot drift onto a spelling the gate no longer forbids.
const deprecatedStateDir = readDeprecatedBrandTokens().find(token => token.startsWith('.') && !token.includes('-codex'));
if (!deprecatedStateDir) {
  console.error('FAIL: could not derive a deprecated state-dir token from core/brand-paths.ts.');
  process.exit(1);
}
assertGateCatches(
  'forbidden brand decision',
  `\nexport function b_cc10ForbiddenDecisionRepro(p: string): boolean {\n  return p.startsWith('${deprecatedStateDir}/');\n}\n`,
);

console.log('\nPASS inject-check: gate caught every tracked inject and the worktree was restored clean.');
process.exit(0);
