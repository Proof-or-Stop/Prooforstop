#!/usr/bin/env node
/**
 * RED artifact (W2b / B-e10d, CHK-001 + CHK-002 + CHK-003 + CHK-004).
 *
 * Repro-first RED: this file is written and committed BEFORE
 * packages/main/src/core/red-evidence/target-bindings.ts and the exported
 * resolveExpectedRedTargets exist. At that point the import of
 * ../../dist/core/red-evidence/target-bindings.js fails
 * (ERR_MODULE_NOT_FOUND) and the process exits non-zero — that import failure
 * IS the RED evidence that the §1.1.3 target-binding store has no
 * implementation yet. Once target-bindings.ts + the resolver are implemented
 * and built, every assertion below must hold (GREEN).
 *
 * It proves, un-gameably, four store behaviours a later reviewer must not
 * re-litigate (spec §1.1.3 lines 209-238, §3.3):
 *   1. Exactly ONE binding per acceptanceTargetRef — a duplicate-target write
 *      REJECTS (not overwrite); a different target APPENDS.
 *   2. targetBindingDigest = CANON over the createdAt-STRIPPED 3-field
 *      subobject ONLY — CANON over a STORED entry (carries createdAt) must NOT
 *      equal the digest, while CANON over {acceptanceTargetRef,adapterId,
 *      testCaseRef} MUST. Allowlist (3 named fields), not blocklist.
 *   3. resolveExpectedRedTargets returns the same computed set as the private
 *      expectedRedTargets and the membership check is CASE-SENSITIVE.
 *   4. The committed-tree reader resolves a binding from a git ref (git show),
 *      NEVER the live directory; a bad ref fails closed (no live fallback).
 *
 * Assurance scope (§0.6 practical tier): this detects accidental substitution
 * and casual drift through the registered surfaces. It does not defend against
 * a hostile local agent with filesystem control (that is the Tier-C program).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST = new URL('../../dist', import.meta.url).pathname;

const {
  RED_TARGET_BINDINGS_SCHEMA_VERSION,
  RED_TARGET_BINDINGS_FILENAME,
  emptyRedTargetBindingsFile,
  targetBindingDigest,
  strippedBindingIdentity,
  appendTargetBinding,
  findTargetBinding,
  readCommittedTargetBindings,
  RedTargetBindingDuplicateError,
} = await import(`${DIST}/core/red-evidence/target-bindings.js`);
const { canon, canonDigest } = await import(`${DIST}/core/red-evidence/canon.js`);
const { resolveExpectedRedTargets } = await import(`${DIST}/core/proofstory.js`);

// ── 1. Schema + one-binding-per-target uniqueness (CHK-001) ──────────────────
assert.equal(RED_TARGET_BINDINGS_SCHEMA_VERSION, 'proofstory.red_target_bindings.v1',
  'store schema is proofstory.red_target_bindings.v1');
assert.equal(RED_TARGET_BINDINGS_FILENAME, 'red-target-bindings.json',
  'store filename is red-target-bindings.json');

const empty = emptyRedTargetBindingsFile('B-e10d', '2026-07-25T00:00:00.000Z');
assert.equal(empty.schemaVersion, 'proofstory.red_target_bindings.v1');
assert.equal(empty.storyId, 'B-e10d');
assert.deepEqual(empty.bindings, [], 'a fresh file has an empty bindings array');

const idA = { acceptanceTargetRef: 'AB-001/hash-aaa', adapterId: 'node-test-runner', testCaseRef: 'test/red/a.test.ts' };
const idB = { acceptanceTargetRef: 'AB-002/hash-bbb', adapterId: 'node-test-runner', testCaseRef: 'test/red/b.test.ts' };

const afterA = appendTargetBinding(empty, idA, '2026-07-25T00:00:01.000Z');
assert.equal(afterA.bindings.length, 1, 'first write persists exactly one entry');
assert.equal(afterA.bindings[0].acceptanceTargetRef, idA.acceptanceTargetRef);
assert.equal(afterA.bindings[0].adapterId, idA.adapterId);
assert.equal(afterA.bindings[0].testCaseRef, idA.testCaseRef);
assert.equal(typeof afterA.bindings[0].createdAt, 'string', 'stored entry carries createdAt');
// Purity: appending must not mutate the input file object.
assert.equal(empty.bindings.length, 0, 'append is pure — the source file is not mutated');

const afterB = appendTargetBinding(afterA, idB, '2026-07-25T00:00:02.000Z');
assert.equal(afterB.bindings.length, 2, 'a DIFFERENT target appends a second binding');
assert.equal(afterB.bindings[0].acceptanceTargetRef, idA.acceptanceTargetRef, 'first entry intact after append');

// Duplicate target for the SAME acceptanceTargetRef REJECTS (not overwrite).
const dupSameRef = { acceptanceTargetRef: 'AB-001/hash-aaa', adapterId: 'other-runner', testCaseRef: 'test/red/other.test.ts' };
assert.throws(
  () => appendTargetBinding(afterB, dupSameRef, '2026-07-25T00:00:03.000Z'),
  (err) => err instanceof RedTargetBindingDuplicateError && /AB-001\/hash-aaa/.test(err.message),
  'a second write for the SAME acceptanceTargetRef is a duplicate-target rejection (§1.1.3)',
);

// Unicode / slash / hash ref round-trips exactly (edge).
const idUni = { acceptanceTargetRef: 'AB-999/req#spéçial', adapterId: 'a', testCaseRef: 't' };
const afterUni = appendTargetBinding(empty, idUni, '2026-07-25T00:00:04.000Z');
assert.equal(afterUni.bindings[0].acceptanceTargetRef, 'AB-999/req#spéçial', 'unicode/slash/hash ref round-trips');

assert.ok(findTargetBinding(afterB, 'AB-002/hash-bbb'), 'findTargetBinding locates an existing target');
assert.equal(findTargetBinding(afterB, 'AB-404/none'), undefined, 'findTargetBinding returns undefined for an absent target');

// ── 2. createdAt-stripped digest, BOTH directions (CHK-002) ──────────────────
const storedEntry = afterA.bindings[0]; // has createdAt
const digest = targetBindingDigest(idA);

// The trap: CANON over a STORED entry (with createdAt) must NOT equal the digest.
assert.notEqual(canonDigest(storedEntry), digest,
  'CANON over the STORED entry (with createdAt) must NOT equal targetBindingDigest — createdAt is stripped');
// CANON over the 3-field stripped subobject MUST equal the digest.
assert.equal(canonDigest({ acceptanceTargetRef: idA.acceptanceTargetRef, adapterId: idA.adapterId, testCaseRef: idA.testCaseRef }), digest,
  'CANON over the 3-field identity subobject MUST equal targetBindingDigest');
// strippedBindingIdentity returns exactly the 3 identity fields.
assert.deepEqual(strippedBindingIdentity(storedEntry), { acceptanceTargetRef: idA.acceptanceTargetRef, adapterId: idA.adapterId, testCaseRef: idA.testCaseRef },
  'strippedBindingIdentity yields exactly the 3 identity fields (createdAt removed)');
assert.equal(canon(strippedBindingIdentity(storedEntry)), canon({ acceptanceTargetRef: idA.acceptanceTargetRef, adapterId: idA.adapterId, testCaseRef: idA.testCaseRef }));

// Two entries with identical identity but different createdAt -> SAME digest.
const otherCreatedAt = { ...storedEntry, createdAt: '2099-01-01T00:00:00.000Z' };
assert.equal(targetBindingDigest(otherCreatedAt), digest, 'createdAt is excluded — differing createdAt yields the same digest');

// Allowlist (not blocklist): extra storage metadata beyond createdAt is also absent from the digest.
const withExtra = { ...storedEntry, updatedAt: 'x', supersedes: null, note: 'junk' };
assert.equal(targetBindingDigest(withExtra), digest,
  'strip is allowlist-based (3 named fields only) — extra metadata beyond createdAt is also excluded');

// Field reorder -> same digest (CANON is order-independent per RFC 8785 JCS).
const reordered = { testCaseRef: idA.testCaseRef, acceptanceTargetRef: idA.acceptanceTargetRef, adapterId: idA.adapterId };
assert.equal(targetBindingDigest(reordered), digest, 'CANON canonicalizes regardless of JS property insertion order');

// ── 3. expectedRedTargets exported resolver + membership (CHK-003) ───────────
const repInput = {
  originalIntentSnapshot: { requestHash: 'sha256:REQHASH' },
  proofStoryContract: { acceptanceBindings: [
    { id: 'AB-001', verificationIntentRefs: ['CHK-001:happy:0'], milestoneIds: ['M1'] },
  ] },
  milestoneLedger: { milestones: [
    { id: 'M1', verificationIntentRefs: ['CHK-002:edge:0'] },
    { id: 'M2', verificationIntentRefs: [] },
  ] },
};
const resolved = resolveExpectedRedTargets(repInput);
// Independent reference computation of the SAME set (same-set proof).
const reference = new Set(['sha256:REQHASH', 'AB-001', 'CHK-001:happy:0', 'M1', 'CHK-002:edge:0', 'M2']);
assert.deepEqual([...resolved].sort(), [...reference].sort(),
  'resolveExpectedRedTargets returns the identical computed set as the private expectedRedTargets');
assert.equal(resolved.has('AB-001'), true, 'membership: an in-set ref is present');
assert.equal(resolved.has('ab-001'), false, 'membership is CASE-SENSITIVE (no case-folding)');
assert.equal(resolved.has('AB-404'), false, 'an out-of-set ref is absent');

// Empty topology -> empty set.
assert.equal(resolveExpectedRedTargets({ originalIntentSnapshot: null, proofStoryContract: null, milestoneLedger: null }).size, 0,
  'a story with zero targets yields an empty expectedRedTargets set');

// ── 4. Committed-tree reader — git ref, never the live directory (CHK-004) ───
const repoRoot = mkdtempSync(join(tmpdir(), 'red-w2b-committed-'));
const git = (args) => {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};
try {
  git(['init', '-q']);
  git(['config', 'user.email', 'red@w2b.local']);
  git(['config', 'user.name', 'red-w2b']);
  const relPath = `.proof-or-stop/story/actives/B-e10d/${RED_TARGET_BINDINGS_FILENAME}`;
  const abs = join(repoRoot, relPath);
  mkdirSync(join(repoRoot, '.proof-or-stop/story/actives/B-e10d'), { recursive: true });

  // Commit binding-A.
  const fileA = appendTargetBinding(emptyRedTargetBindingsFile('B-e10d', '2026-07-25T00:00:00.000Z'),
    { acceptanceTargetRef: 'AB-001', adapterId: 'runner-A', testCaseRef: 'test/A.ts' }, '2026-07-25T00:00:01.000Z');
  writeFileSync(abs, JSON.stringify(fileA, null, 2) + '\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'commit binding-A']);
  const headRef = git(['rev-parse', 'HEAD']).trim();

  // Now edit the LIVE directory to binding-B (uncommitted).
  const fileB = appendTargetBinding(emptyRedTargetBindingsFile('B-e10d', '2026-07-25T00:00:00.000Z'),
    { acceptanceTargetRef: 'AB-001', adapterId: 'runner-B-SWAPPED', testCaseRef: 'test/B-SWAPPED.ts' }, '2026-07-25T00:00:05.000Z');
  writeFileSync(abs, JSON.stringify(fileB, null, 2) + '\n');

  const committed = readCommittedTargetBindings({ gitCwd: repoRoot, ref: headRef, relPath });
  assert.ok(committed, 'committed-tree reader returns the file at the ref');
  assert.equal(committed.bindings[0].adapterId, 'runner-A',
    'committed-tree reader returns the COMMITTED binding (runner-A), NOT the live-swapped runner-B — anti-swap');
  assert.equal(committed.bindings[0].testCaseRef, 'test/A.ts');

  // Missing file at a VALID ref -> null (no crash, no live fallback).
  const missing = readCommittedTargetBindings({ gitCwd: repoRoot, ref: headRef, relPath: `.proof-or-stop/story/actives/B-NONE/${RED_TARGET_BINDINGS_FILENAME}` });
  assert.equal(missing, null, 'a missing file at a valid ref returns null (no live-directory fallback)');

  // Bad/nonexistent ref -> THROWS (fail-closed; never silently read the live dir).
  assert.throws(
    () => readCommittedTargetBindings({ gitCwd: repoRoot, ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', relPath }),
    'an invalid git ref fails closed (throws) — never falls back to the live directory',
  );
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

console.log('red-w2b-binding-store: OK (store uniqueness, createdAt-strip digest both directions, expectedRedTargets same-set + case-sensitive membership, committed-tree anti-swap reader)');
