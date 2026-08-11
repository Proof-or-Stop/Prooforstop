#!/usr/bin/env node
/**
 * verify-brand-gate-negative.mjs — B-cdf6: prove the brand-prose gate is NOT vacuous.
 *
 * A gate that only ever reports PASS is indistinguishable from a gate that cannot see
 * anything. This asserts the detector actually bites, in BOTH directions:
 *   1. inject an un-renamed `lattice <cmd>` invocation into a REAL active doc
 *      -> the gate MUST fail (non-zero exit)
 *   2. revert the injection
 *      -> the gate MUST pass (zero exit)
 * So neither a blind gate nor a permanently-red gate can satisfy this check. The doc is
 * always restored, including on early failure.
 */
import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DOC_REL = 'docs/guide.md';
const doc = join(repoRoot, DOC_REL);

const restore = () => {
  try {
    execFileSync('git', ['checkout', '--', DOC_REL], { cwd: repoRoot, stdio: 'ignore' });
  } catch { /* best effort */ }
};

/** @returns {boolean} true when the brand gate exits zero (PASS) */
function gatePasses() {
  try {
    execFileSync('node', ['scripts/verify-lattice-residue.mjs'], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

try {
  appendFileSync(doc, '\nRun `lattice validate` to check your work.\n');
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
