#!/usr/bin/env node
/**
 * verify-brand-gate-negative.mjs — B-cdf6: prove the brand-prose gate is NOT vacuous.
 *
 * A gate that only ever reports PASS is indistinguishable from a gate that cannot see
 * anything. This asserts the detector actually bites, in BOTH directions:
 *   1. inject an un-renamed `proofOrStop <cmd>` invocation into a REAL active doc
 *      -> the gate MUST fail (non-zero exit)
 *   2. revert the injection
 *      -> the gate MUST pass (zero exit)
 * So neither a blind gate nor a permanently-red gate can satisfy this check. The doc is
 * always restored, including on early failure.
 */
import { execFileSync } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DOC_REL = 'docs/guide.md';
const doc = join(repoRoot, DOC_REL);
const LEGACY_BIN = ['lat', 'tice'].join('');

// B-cdf6:F-019 — restore by REWRITING THE EXACT ORIGINAL BYTES, never via
// `git checkout --`. The old implementation discarded any pre-existing uncommitted
// edits to this file, on both the success and the failure path, because git restores
// to HEAD rather than to what the author actually had. Snapshotting the bytes up
// front makes the script safe to run against a dirty tree, which matters because it
// is wired into local pre-push style checks where uncommitted work is the norm.
const ORIGINAL_BYTES = readFileSync(doc);

const restore = () => {
  try {
    writeFileSync(doc, ORIGINAL_BYTES);
  } catch { /* best effort */ }
};

/** @returns {boolean} true when the brand gate exits zero (PASS) */
function gatePasses() {
  try {
    execFileSync('node', ['scripts/verify-proof-or-stop-residue.mjs'], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

try {
  appendFileSync(doc, `\nRun \`${LEGACY_BIN} validate\` to check your work.\n`);
  if (gatePasses()) {
    restore();
    console.error('NEGATIVE-TEST FAIL: gate PASSED on an injected regression - it is vacuous');
    process.exit(1);
  }
  restore();
  if (!gatePasses()) {
    console.error('NEGATIVE-TEST FAIL: gate still FAILS on a clean tree');
    process.exit(1);
  }
  console.log('NEGATIVE-TEST OK: injected regression detected, clean tree passes');
} finally {
  restore();
}
