#!/usr/bin/env node
/**
 * B-2ccc CHK-003: smoke suite for the BEHAVIOUR-PRESERVING extraction of the
 * canonical-JSON-digest primitives into the leaf module core/digest.ts.
 *
 * The whole point of this story is that digest VALUES must stay byte-identical
 * after moving canonicalJson / digestCanonicalJson / digestText (and the private
 * normalizeJson) out of handlers/decision-doc-promotion.ts. So the load-bearing
 * checks below PIN the exact sha256 hex captured from the CURRENT implementation
 * (run once before the refactor, hardcoded here) and assert equality.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `smoke passed` at the very end):
 *   - PINNED: canonicalJson / digestCanonicalJson / digestText produce the exact
 *     pinned strings/hashes on pinned inputs (proves byte-identical behaviour).
 *   - ORDER-INDEPENDENT: digestCanonicalJson({a,b}) === digestCanonicalJson({b,a}).
 *   - DISTINCT: digestText(x) !== digestCanonicalJson(x) for a string x.
 *   - PROPOSAL-DIGEST: computeDecisionDocProposalDigest on a fixed proposal is
 *     stable (pinned).
 *   - IMPORT-FENCE: core/digest.ts imports ONLY node:crypto (static scan), and the
 *     scan is non-vacuous (a planted foreign import is caught).
 *   - NO-LOCAL-DEFS: decision-doc-promotion.ts no longer DEFINES the digest
 *     helpers locally (they are imported from ../core/digest.js) and no longer
 *     references createHash.
 *   - NO REGRESSION: the decision-doc + experience-layer smokes still pass
 *     (invoked as subprocesses).
 *
 * Hermetic: pure functions + static source reads + subprocess smokes; no repo
 * mutation, no temp dir needed for the digest assertions themselves.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, digestCanonicalJson, digestText } from '../core/digest.js';
import { computeDecisionDocProposalDigest } from '../handlers/decision-doc-promotion.js';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const REPO_ROOT = repoRoot();
const MAIN_DIR = join(REPO_ROOT, 'packages', 'main');

// ─── Pinned values captured from the PRE-refactor implementation ──────────────
// (decision-doc-promotion.ts inline defs, before they moved to core/digest.ts).
const PIN = {
  canonicalObj: '{"a":1,"b":2,"nested":{"y":null,"z":[3,2,1]}}',
  digestObj: '92145652d9961c0cb425fe343874c2be01dadd420109272b91b1e62623e44f18',
  canonicalStr: '"hello-digest-fixture"',
  digestStr: '40354c6d81d540b8ac744252a78571c3d9892b0962e71a894f0be3c2aca0b032',
  textStr: '4e9117d7d31481237f835463368f7d1f92b389f0b2072a5b5a5a7cb5a9e6659c',
  proposalDigest: '0de71653afa54c4fa623cebb6cba496f18ad6336cb72daadfe6bcd8af7d9634e',
} as const;

const PINNED_OBJ = { b: 2, a: 1, nested: { z: [3, 2, 1], y: null } };
const PINNED_STR = 'hello-digest-fixture';

// Fixed proposal-shaped object (matches the capture used to pin proposalDigest).
const PINNED_PROPOSAL = {
  id: 'DDP-001',
  slug: 'fixed-proposal',
  targetPath: 'docs/requirements/decisions/fixed-proposal.md',
  title: 'A fixed proposal title',
  sourceDecision: 'manual',
  decision: 'We will do the thing in a deterministic way.',
  context: 'There was an ambiguous situation requiring a decision.',
  scope: 'Applies to the fixture only.',
  nonGoals: ['not changing behaviour', 'not adding deps'],
  chosenApproach: 'Extract the digest helpers into a leaf module.',
  alternatives: [
    { name: 'Alpha', pros: ['simple'], cons: ['limited'] },
    { name: 'Beta', pros: ['flexible'], cons: ['complex'] },
  ],
  operationalRules: ['rule one', 'rule two'],
  verificationRequirements: ['build clean', 'smoke passed'],
  risks: ['low risk'],
  status: 'proposed',
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-17T00:00:00.000Z',
  proposalDigest: 'ignored-by-domain', // excluded from the proposal digest domain
  saves: [{ ignore: true }], // excluded
  savedAt: '2026-06-17T00:00:00.000Z', // excluded
  savedCommit: 'deadbeef', // excluded
} as unknown as Parameters<typeof computeDecisionDocProposalDigest>[0];

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

/** Extract `from '...'` module specifiers from a TS/JS source string. */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  // Also catch bare side-effect imports: import '...'
  const bare = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src)) !== null) out.push(m[1]);
  return out;
}

function run(): void {
  // ─── PINNED: byte-identical canonicalization + digests ──────────────────────
  check('pinned: canonicalJson(obj) is the exact pinned canonical string', () => {
    assert.equal(canonicalJson(PINNED_OBJ), PIN.canonicalObj);
  });

  check('pinned: digestCanonicalJson(obj) matches the pre-refactor sha256', () => {
    assert.equal(digestCanonicalJson(PINNED_OBJ), PIN.digestObj);
  });

  check('pinned: canonicalJson(str) JSON-encodes the string (with quotes)', () => {
    assert.equal(canonicalJson(PINNED_STR), PIN.canonicalStr);
  });

  check('pinned: digestCanonicalJson(str) matches the pre-refactor sha256', () => {
    assert.equal(digestCanonicalJson(PINNED_STR), PIN.digestStr);
  });

  check('pinned: digestText(str) matches the pre-refactor sha256', () => {
    assert.equal(digestText(PINNED_STR), PIN.textStr);
  });

  // ─── ORDER-INDEPENDENT canonicalization ─────────────────────────────────────
  check('order-independent: digestCanonicalJson({a,b}) === digestCanonicalJson({b,a})', () => {
    const ab = digestCanonicalJson({ a: 1, b: 2 });
    const ba = digestCanonicalJson({ b: 2, a: 1 });
    assert.equal(ab, ba, 'key order must not change the digest');
  });

  // ─── DISTINCT functions: digestText !== digestCanonicalJson for a string ─────
  check('distinct: digestText(x) !== digestCanonicalJson(x) for a string x', () => {
    const x = 'distinct-fixture';
    // digestCanonicalJson hashes JSON.stringify(x) (quoted); digestText hashes x raw.
    assert.notEqual(digestText(x), digestCanonicalJson(x), 'the two functions must differ');
    // And they are exactly what they claim to be.
    assert.equal(digestCanonicalJson(x), digestText(JSON.stringify(x)), 'digestCanonicalJson(str) == digestText(JSON.stringify(str))');
  });

  // ─── PROPOSAL-DIGEST stability ──────────────────────────────────────────────
  check('proposal-digest: computeDecisionDocProposalDigest is the pinned value', () => {
    assert.equal(computeDecisionDocProposalDigest(PINNED_PROPOSAL), PIN.proposalDigest);
  });

  // ─── IMPORT-FENCE: core/digest.ts imports ONLY node:crypto ──────────────────
  check('import-fence: core/digest.ts imports only node:crypto (static scan)', () => {
    const src = readFileSync(join(MAIN_DIR, 'src', 'core', 'digest.ts'), 'utf-8');
    const specs = importSpecifiers(src);
    assert.ok(specs.length > 0, 'digest.ts must have at least one import (node:crypto)');
    assert.ok(specs.includes('node:crypto'), 'digest.ts must import node:crypto');
    const foreign = specs.filter((s) => s !== 'node:crypto');
    assert.deepEqual(foreign, [], `digest.ts must import ONLY node:crypto; found extra: ${foreign.join(', ')}`);
  });

  check('import-fence: the static scan is non-vacuous (catches a planted foreign import)', () => {
    const real = readFileSync(join(MAIN_DIR, 'src', 'core', 'digest.ts'), 'utf-8');
    const planted = `import { join } from 'node:path';\n${real}`;
    const specs = importSpecifiers(planted);
    const foreign = specs.filter((s) => s !== 'node:crypto');
    assert.deepEqual(foreign, ['node:path'], 'the scanner must detect a foreign import when present');
  });

  // ─── NO-LOCAL-DEFS in decision-doc-promotion.ts ─────────────────────────────
  check('no-local-defs: decision-doc-promotion.ts imports the helpers and defines none locally', () => {
    const src = readFileSync(join(MAIN_DIR, 'src', 'handlers', 'decision-doc-promotion.ts'), 'utf-8');
    // It must import from the leaf module.
    assert.match(src, /from\s+['"]\.\.\/core\/digest\.js['"]/, 'must import from ../core/digest.js');
    // It must NOT contain local function definitions of the moved helpers.
    assert.ok(!/function\s+canonicalJson\s*\(/.test(src), 'must not define canonicalJson locally');
    assert.ok(!/function\s+digestCanonicalJson\s*\(/.test(src), 'must not define digestCanonicalJson locally');
    assert.ok(!/function\s+digestText\s*\(/.test(src), 'must not define digestText locally');
    assert.ok(!/function\s+normalizeJson\s*\(/.test(src), 'must not define normalizeJson locally');
    // It must NOT reference createHash anymore (the only previous user moved out).
    assert.ok(!src.includes('createHash'), 'must not reference createHash after the extraction');
  });

  // ─── NO REGRESSION: decision-doc + experience-layer smokes still pass ────────
  const regressionSmokes: Array<{ label: string; rel: string }> = [
    { label: 'decision-doc-promotion', rel: 'dist/tasks/decision-doc-promotion-smoke.js' },
    { label: 'decision-doc-quorum', rel: 'dist/tasks/decision-doc-quorum-smoke.js' },
    { label: 'experience-layer-finding-signals', rel: 'dist/tasks/experience-layer-finding-signals-smoke.js' },
    { label: 'experience-layer-finding-enums', rel: 'dist/tasks/experience-layer-finding-enums-smoke.js' },
    { label: 'experience-layer-hint-injection', rel: 'dist/tasks/experience-layer-hint-injection-smoke.js' },
  ];
  for (const { label, rel } of regressionSmokes) {
    check(`no-regression: ${label} smoke still prints "smoke passed"`, () => {
      const out = execFileSync('node', [rel], { cwd: MAIN_DIR, encoding: 'utf-8' });
      assert.match(out, /smoke passed/, `${label} smoke must print "smoke passed"`);
    });
  }

  console.log(`\nTOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (process.exitCode === 1) {
    console.error('smoke FAILED');
    return;
  }
  console.log('smoke passed');
}

run();
