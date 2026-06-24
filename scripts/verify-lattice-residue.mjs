#!/usr/bin/env node
/**
 * verify-lattice-residue.mjs — zero-tolerance brand-residue acceptance gate.
 *
 * Purpose (B-fbca ship-clean story 3):
 *   Reproducible check that the product runtime source surface (packages/<pkg>/src)
 *   contains LITERAL ZERO un-rebranded "koala" / "Koala" brand residue. The
 *   bulk rename + legacy-detection removal drove these roots to zero, so the
 *   gate is now unconditional: ANY case-insensitive "koala" hit in SCAN_ROOTS
 *   is a FAIL. There is no classify()/exemption allowlist — there is nothing
 *   left to exempt.
 *
 * Scope:
 *   SCAN_ROOTS is intentionally the product runtime source only. The gate does
 *   NOT scan docs/, experiments/, or .lattice/story/ — historical/legacy brand
 *   prose there is out of scope for this gate.
 *
 * Usage:
 *   node scripts/verify-lattice-residue.mjs            scan SCAN_ROOTS; exit 0 PASS / 1 with hit list
 *   node scripts/verify-lattice-residue.mjs --self-test run isResidue() unit tests
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), '..');

// ---------------------------------------------------------------------------
// Zero-tolerance detector: any case-insensitive "koala" is residue.
// ---------------------------------------------------------------------------

/**
 * @param {string} line
 * @returns {boolean} true when the line contains brand residue
 */
export function isResidue(line) {
  return /koala/i.test(line);
}

// ---------------------------------------------------------------------------
// Active scope definition — product runtime source only.
// ---------------------------------------------------------------------------

const SCAN_ROOTS = [
  'packages/main/src',
  'packages/lab/src',
  'packages/utils/src',
];

const EXCLUDE_SUBSTRINGS = ['/node_modules/', '/dist/', '/.lattice/'];

/**
 * @param {string} rel normalized repo-relative path
 * @returns {boolean} true when the path is inside the scannable active scope
 */
function inActiveScope(rel) {
  return !EXCLUDE_SUBSTRINGS.some((s) => rel.includes(s));
}

/**
 * Resolve the concrete set of tracked files in the active scope.
 * Uses `git ls-files` so the scan is deterministic and ignores untracked junk.
 * @returns {string[]} repo-relative file paths
 */
function listScopeFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .filter(inActiveScope);
}

// ---------------------------------------------------------------------------
// Scan.
// ---------------------------------------------------------------------------

function runScan() {
  const files = listScopeFiles();
  /** @type {string[]} */
  const hits = [];

  for (const rel of files) {
    const abs = join(repoRoot, rel);
    let content;
    try {
      if (!statSync(abs).isFile()) continue;
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (isResidue(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  if (hits.length === 0) {
    console.log('PASS lattice-residue: 0 brand residue in product runtime source');
    return 0;
  }
  console.error('FAIL lattice-residue: brand residue found (zero tolerance)');
  for (const h of hits) console.error(`  ${h}`);
  console.error(`\n${hits.length} residue hit(s).`);
  return 1;
}

// ---------------------------------------------------------------------------
// Inline unit tests for isResidue().
// ---------------------------------------------------------------------------

/** @type {Array<[string, boolean]>} */
const RESIDUE_CASES = [
  ['the koala framework handles this', true],
  ['name: koala-implementer', true],
  ['const KoalaFoo = 1', true],
  ['existsSync(.claude/skills/koala)', true],
  ['const REVIEW_SALT = "lattice-review-integrity-v1";', false],
  ['import { lattice } from "./lattice.js";', false],
  ['a clean line with no brand token at all', false],
];

/**
 * Run isResidue() unit tests. Throws on the first failure.
 * @returns {number} count of assertions run
 */
export function runSelfTest() {
  let passed = 0;
  for (const [line, expected] of RESIDUE_CASES) {
    const actual = isResidue(line);
    if (actual !== expected) {
      throw new Error(
        `isResidue() unit test FAILED:\n  input:    ${JSON.stringify(line)}\n  expected: ${expected}\n  actual:   ${actual}`,
      );
    }
    passed++;
  }
  return passed;
}

// Always assert the unit tests at module load so any regression in isResidue()
// fails fast for every consumer (scan run, import, or --self-test).
runSelfTest();

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && relative(fileURLToPath(import.meta.url), process.argv[1]) === '';

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) {
    const n = runSelfTest();
    console.log(`PASS lattice-residue self-test: ${n}/${n} isResidue() unit tests`);
    process.exit(0);
  }
  process.exit(runScan());
}
