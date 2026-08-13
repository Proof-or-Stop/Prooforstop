#!/usr/bin/env node
/**
 * RED artifact (W2d / B-9ff1, CHK-001..005 + CHK-011 + CHK-015 + CHK-016) — the
 * §1.1 schema rules and the §1.6 TAGGED rejection matrix.
 *
 * Repro-first RED: written and committed BEFORE
 * packages/main/src/core/red-evidence/envelope.ts exists; the import failure IS
 * the RED evidence.
 *
 * THE POINT OF THIS FILE: every rejection asserts its EXACT §1.6 tag, and the
 * two tags an implementation is most likely to collapse are asserted to be
 * MUTUALLY EXCLUSIVE on single-fault fixtures:
 *
 *   R1-1  missing target-exercised proof
 *   R1-2  MINIMUM-SPECIFICITY failure (blocklisted / below-threshold literal, or
 *         a class-only present-in-red set)
 *   R1-3  matcher and path BOUNDS (count, byte length, whitespace, duplicate id,
 *         unknown kind, unregistered class name, invalid supplementary path)
 *   R1-5  adapterId absent from policy.runnerAdapterRegistry (only the
 *         envelope-decidable half of R1-5; argv derivation is the runner's)
 *   R1-6  unregistered or mismatched target binding
 *
 * A below-threshold literal is R1-2 and NOT R1-3; an invalid path or an
 * unregistered class name is R1-3 and NOT R1-2.
 *
 * Assurance scope (§0.6 practical tier): registered-surface drift detection, not
 * a defence against a hostile local agent (Tier-C).
 */
import { strict as assert } from 'node:assert';

const DIST = new URL('../../dist', import.meta.url).pathname;

const { validateAssertionEnvelope } = await import(`${DIST}/core/red-evidence/envelope.js`);
const { resolveRedEvidencePolicy } = await import(`${DIST}/core/red-evidence/policy.js`);
const { targetBindingDigest } = await import(`${DIST}/core/red-evidence/target-bindings.js`);
const { canonDigest } = await import(`${DIST}/core/red-evidence/canon.js`);

const FROZEN = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] });
assert.equal(FROZEN.ok, true);
const policy = FROZEN.snapshot;
const POLICY_DIGEST = FROZEN.policyDigest;
assert.equal(policy.maxMatchers, 8);
assert.equal(policy.maxMatcherLen, 512);

const BINDING = { acceptanceTargetRef: 'M1', adapterId: 'npm-script@1', testCaseRef: 'npm-script:test:x' };
const COMMITTED = { ...BINDING, createdAt: '2026-08-01T00:00:00.000Z' };
const ADMISSIBLE = "Error: Cannot find module '/repo/dist/x.js'";

const literal = (id, value, polarity = 'present-in-red', stream = 'combined') =>
  ({ id, kind: 'literal-line', value, stream, polarity });

function base(overrides = {}) {
  return {
    acceptanceTargetRef: 'M1',
    matchers: [literal('L1', ADMISSIBLE)],
    expectedExitClass: 'nonzero',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: BINDING.testCaseRef,
      adapterId: BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(BINDING),
    },
    ...overrides,
  };
}

const results = [];

function run(assertion, opts = {}) {
  return validateAssertionEnvelope({
    assertion,
    policy: opts.policy ?? policy,
    policyDigest: opts.policyDigest ?? POLICY_DIGEST,
    committedBinding: 'binding' in opts ? opts.binding : COMMITTED,
  });
}

const tagsOf = (result) => [...new Set(result.rejections.map((r) => r.tag))].sort();

/** Assert an INADMISSIBLE fixture carries exactly the expected §1.6 tags. */
function reject(label, assertion, expectedTags, opts = {}) {
  const result = run(assertion, opts);
  const got = tagsOf(result);
  assert.equal(result.ok, false, `${label}: must be inadmissible`);
  assert.deepEqual(
    got,
    [...expectedTags].sort(),
    `${label}: expected tags ${JSON.stringify([...expectedTags].sort())}, got ${JSON.stringify(got)} — ${result.rejections.map((r) => `${r.tag}/${r.code}`).join(', ')}`,
  );
  assert.equal(result.assertionDigest, null,
    `${label}: an inadmissible envelope reports NO success digest (success output must be absent)`);
  results.push(`  REJECT ${got.join('+').padEnd(11)} ${label}`);
  return result;
}

/** Assert an ADMISSIBLE fixture. */
function accept(label, assertion, opts = {}) {
  const result = run(assertion, opts);
  assert.equal(result.ok, true, `${label}: must be admissible; got ${JSON.stringify(result.rejections)} ${JSON.stringify(result.diagnostics)}`);
  assert.match(result.assertionDigest ?? '', /^sha256:[0-9a-f]{64}$/, `${label}: reports a computed assertionDigest`);
  results.push(`  ACCEPT ${''.padEnd(11)} ${label}`);
  return result;
}

// ═══ HAPPY PATHS (CHK-001, 002, 003, 004, 005, 015, 016) ═════════════════════
accept('baseline: one admissible present-in-red literal-line matcher', base());
accept('CHK-001: unique ids across kinds literal-line + class', base({
  matchers: [literal('L1', ADMISSIBLE), { id: 'C1', kind: 'class', value: 'stderr-nonempty', stream: 'stderr', polarity: 'present-in-red' }],
}));
accept('CHK-016: class value exactly naming a registered matcherClassRegistry entry', base({
  matchers: [literal('L1', ADMISSIBLE), { id: 'C1', kind: 'class', value: 'nonzero-exit', stream: 'combined', polarity: 'present-in-red' }],
}));
accept('CHK-015: exactly 1 matcher (inclusive lower count bound)', base());
accept('CHK-015: exactly policy.maxMatchers=8 matchers (inclusive upper count bound)', base({
  matchers: [
    literal('L1', ADMISSIBLE),
    ...Array.from({ length: 7 }, (_, i) => literal(`L${i + 2}`, `Error: distinct failure line ${i + 2} observed`, 'present-in-green')),
  ],
}));
accept('CHK-002: value at exactly maxMatcherLen=512 bytes', base({
  matchers: [literal('L1', 'abcdefgh'.repeat(64))],
}));
accept('CHK-003: greenExempt:true on a present-in-red matcher', base({
  matchers: [{ ...literal('L1', ADMISSIBLE), greenExempt: true }],
}));
accept('CHK-003: greenExempt:false explicitly set on a present-in-red matcher', base({
  matchers: [{ ...literal('L1', ADMISSIBLE), greenExempt: false }],
}));
accept('CHK-004: expectedExitClass exit:7 (0 < n <= 255)', base({ expectedExitClass: 'exit:7' }));
accept('CHK-004: expectedExitClass exit:255 (upper bound)', base({ expectedExitClass: 'exit:255' }));
accept('CHK-004: expectedExitClass nonzero with a script-exit adapter', base());
accept('CHK-005: valid repo-relative targetArtifactRef', base({
  targetExercisedProof: {
    ...base().targetExercisedProof,
    supplementaryArtifact: { targetArtifactRef: 'packages/main/dist/tasks/foo.js', expectation: 'absent-in-red-present-in-green' },
  },
}));
accept('CHK-010: an explicit policyDigest equal to the resolved one', base({ policyDigest: POLICY_DIGEST }));

// timeout-is-failure is legal ONLY with a reporter-event adapter, so it needs a
// binding naming node-test@1.
const REPORTER_BINDING = { acceptanceTargetRef: 'M1', adapterId: 'node-test@1', testCaseRef: 'node-test:packages/main/tests/red/x.mjs#red case' };
const REPORTER_COMMITTED = { ...REPORTER_BINDING, createdAt: '2026-08-01T00:00:00.000Z' };
function reporterBase(overrides = {}) {
  return base({
    expectedExitClass: 'timeout-is-failure',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: REPORTER_BINDING.testCaseRef,
      adapterId: REPORTER_BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(REPORTER_BINDING),
    },
    ...overrides,
  });
}
accept('CHK-004: timeout-is-failure with a reporter-event adapter', reporterBase(), { binding: REPORTER_COMMITTED });

// ═══ R1-3 — MATCHER AND PATH BOUNDS ══════════════════════════════════════════
// Count bounds (CHK-015).
reject('CHK-015: ZERO matchers', base({ matchers: [] }), ['R1-3']);
reject('CHK-015: maxMatchers+1 = 9 matchers', base({
  matchers: [
    literal('L1', ADMISSIBLE),
    ...Array.from({ length: 8 }, (_, i) => literal(`L${i + 2}`, `Error: distinct failure line ${i + 2} observed`, 'present-in-green')),
  ],
}), ['R1-3']);
reject('CHK-015: matchers is not an array', base({ matchers: { id: 'L1' } }), ['R1-3']);

// Identity + kind bounds (CHK-001). Each keeps one admissible present-in-red
// literal so rule 3 stays satisfied and the tag stays single.
reject('CHK-001: duplicate matcher id', base({
  matchers: [literal('L1', ADMISSIBLE), literal('L1', 'Error: a second distinct failure line', 'present-in-green')],
}), ['R1-3']);
for (const kind of ['anchored-regex', 'regex', 'Literal-Line', 'literal_line', '']) {
  reject(`CHK-001: unknown matcher kind ${JSON.stringify(kind)}`, base({
    matchers: [literal('L1', ADMISSIBLE), { id: 'X1', kind, value: ADMISSIBLE, stream: 'combined', polarity: 'present-in-green' }],
  }), ['R1-3']);
}

// Class registry membership (CHK-016) — a BOUNDS failure, never R1-2.
for (const value of ['no-such-class', 'Stderr-Nonempty', 'STDERR-NONEMPTY', '']) {
  reject(`CHK-016: class value ${JSON.stringify(value)} names no registry entry`, base({
    matchers: [literal('L1', ADMISSIBLE), { id: 'C1', kind: 'class', value, stream: 'stderr', polarity: 'present-in-green' }],
  }), ['R1-3']);
}
// The registry consulted is the RESOLVED policy's, so a different registry
// changes the admissible class set: 'stderr-nonempty' is unregistered there.
{
  const CUSTOM = resolveRedEvidencePolicy({
    pinnedPath: ['/usr/bin'],
    matcherClassRegistry: [{ name: 'ex', predicateKind: 'stream-nonempty' }],
  });
  assert.equal(CUSTOM.ok, true);
  reject('CHK-016: a class registered ONLY in the default policy is unregistered under a custom registry', base({
    matchers: [literal('L1', ADMISSIBLE), { id: 'C1', kind: 'class', value: 'stderr-nonempty', stream: 'stderr', polarity: 'present-in-green' }],
  }), ['R1-3'], { policy: CUSTOM.snapshot, policyDigest: CUSTOM.policyDigest });
  accept('CHK-016: the custom registry name IS admissible under that policy', base({
    matchers: [literal('L1', ADMISSIBLE), { id: 'C1', kind: 'class', value: 'ex', stream: 'stderr', polarity: 'present-in-green' }],
  }), { policy: CUSTOM.snapshot, policyDigest: CUSTOM.policyDigest });
}
// §1.2: an exit-code-in class consults NO stream, so the matcher must declare
// stream 'combined'; any other declared stream rejects.
reject('CHK-016: exit-code-in class matcher declaring stream stderr', base({
  matchers: [literal('L1', ADMISSIBLE), { id: 'C1', kind: 'class', value: 'nonzero-exit', stream: 'stderr', polarity: 'present-in-green' }],
}), ['R1-3']);

// Value bounds (CHK-002). Whitespace / empty / over-length are BOUNDS, not
// specificity — the specificity rules are evaluated only over matchers that
// clear the bounds layer, so these fixtures carry R1-3 alone.
reject('CHK-002: value with a leading space', base({
  matchers: [literal('L1', ADMISSIBLE), literal('L2', ` ${ADMISSIBLE}`, 'present-in-green')],
}), ['R1-3']);
reject('CHK-002: value with a trailing newline', base({
  matchers: [literal('L1', ADMISSIBLE), literal('L2', `${ADMISSIBLE}\n`, 'present-in-green')],
}), ['R1-3']);
reject('CHK-002: value with a trailing tab', base({
  matchers: [literal('L1', ADMISSIBLE), literal('L2', `${ADMISSIBLE}\t`, 'present-in-green')],
}), ['R1-3']);
reject('CHK-002: empty value', base({
  matchers: [literal('L1', ADMISSIBLE), literal('L2', '', 'present-in-green')],
}), ['R1-3']);
reject('CHK-002: value at maxMatcherLen+1 = 513 bytes', base({
  matchers: [literal('L1', `${'abcdefgh'.repeat(64)}x`)],
}), ['R1-3']);
// BYTE length, not code units: 129 four-byte emoji is 516 BYTES but only 258
// UTF-16 code units, so a code-unit implementation would ADMIT it.
{
  const EMOJI = '\u{1F4A5}';
  const atLimit = EMOJI.repeat(128);   // 512 bytes / 256 code units
  const overLimit = EMOJI.repeat(129); // 516 bytes / 258 code units
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 512);
  assert.equal(Buffer.byteLength(overLimit, 'utf8'), 516);
  assert.ok(overLimit.length < policy.maxMatcherLen, 'the over-limit row is UNDER the limit when measured in code units');
  accept('CHK-002: 128 four-byte emoji = exactly 512 bytes', base({ matchers: [literal('L1', atLimit)] }));
  reject('CHK-002: 129 four-byte emoji = 516 bytes (a code-unit implementation would ADMIT this)', base({
    matchers: [literal('L1', overLimit)],
  }), ['R1-3']);
}

// Closed enums (CHK-002).
for (const stream of ['Combined', 'STDOUT', 'both', '', undefined]) {
  reject(`CHK-002: stream ${JSON.stringify(stream)}`, base({
    matchers: [literal('L1', ADMISSIBLE), { id: 'X1', kind: 'literal-line', value: ADMISSIBLE, stream, polarity: 'present-in-green' }],
  }), ['R1-3']);
}
for (const polarity of ['absent-in-red', 'Present-In-Red', 'present', '', undefined]) {
  reject(`CHK-002: polarity ${JSON.stringify(polarity)}`, base({
    matchers: [literal('L1', ADMISSIBLE), { id: 'X1', kind: 'literal-line', value: ADMISSIBLE, stream: 'combined', polarity }],
  }), ['R1-3']);
}

// greenExempt legality (CHK-003).
reject('CHK-003: greenExempt:true on an absent-in-green matcher', base({
  matchers: [literal('L1', ADMISSIBLE), { ...literal('L2', ADMISSIBLE, 'absent-in-green'), greenExempt: true }],
}), ['R1-3']);
reject('CHK-003: greenExempt:true on a present-in-green matcher', base({
  matchers: [literal('L1', ADMISSIBLE), { ...literal('L2', ADMISSIBLE, 'present-in-green'), greenExempt: true }],
}), ['R1-3']);
reject('CHK-003: greenExempt is not a boolean', base({
  matchers: [{ ...literal('L1', ADMISSIBLE), greenExempt: 'true' }],
}), ['R1-3']);

// expectedExitClass (CHK-004).
for (const exitClass of ['exit:0', 'exit:256', 'exit:-1', 'exit:', 'exit:07', 'exit:1.5', '', 'NONZERO', 'Nonzero', 'zero', 'timeout', undefined]) {
  reject(`CHK-004: expectedExitClass ${JSON.stringify(exitClass)}`, base({ expectedExitClass: exitClass }), ['R1-3']);
}
// The decidable linkage incompatibility (§1.1.2): timeout-is-failure with a
// script-exit adapter is rejected AT SCHEMA TIME, before a run is spent.
reject('CHK-004: timeout-is-failure with a script-exit adapter', base({ expectedExitClass: 'timeout-is-failure' }), ['R1-3']);

// supplementaryArtifact path syntax (CHK-005) — R1-3, explicitly NOT R1-2.
const BAD_PATHS = ['/absolute/path', 'foo//bar', 'foo/./bar', 'foo/../bar', 'foo\\bar', '', '.', '..', 'foo/bar/', '/', './foo', '../foo'];
for (const targetArtifactRef of BAD_PATHS) {
  reject(`CHK-005: targetArtifactRef ${JSON.stringify(targetArtifactRef)}`, base({
    targetExercisedProof: {
      ...base().targetExercisedProof,
      supplementaryArtifact: { targetArtifactRef, expectation: 'present' },
    },
  }), ['R1-3']);
}
reject('CHK-005: supplementaryArtifact expectation outside the closed enum', base({
  targetExercisedProof: {
    ...base().targetExercisedProof,
    supplementaryArtifact: { targetArtifactRef: 'packages/main/dist/x.js', expectation: 'maybe' },
  },
}), ['R1-3']);
reject('CHK-005: supplementaryArtifact without targetArtifactRef', base({
  targetExercisedProof: {
    ...base().targetExercisedProof,
    supplementaryArtifact: { expectation: 'present' },
  },
}), ['R1-3']);

// ═══ R1-2 — MINIMUM SPECIFICITY (never R1-3) ═════════════════════════════════
reject('CHK-011: below-threshold literal is R1-2, NOT R1-3', base({
  matchers: [literal('L1', 'failed')],
}), ['R1-2']);
reject('CHK-011: blocklisted literal .* is R1-2, NOT R1-3', base({
  matchers: [literal('L1', '.*')],
}), ['R1-2']);
reject('CHK-011: class-only present-in-red set is R1-2, NOT R1-3', base({
  matchers: [{ id: 'C1', kind: 'class', value: 'stderr-nonempty', stream: 'stderr', polarity: 'present-in-red' }],
}), ['R1-2']);

// ═══ R1-1 — MISSING TARGET-EXERCISED PROOF ═══════════════════════════════════
{
  const noProof = base();
  delete noProof.targetExercisedProof;
  reject('CHK-011: targetExercisedProof absent entirely is R1-1, NOT R1-6', noProof, ['R1-1']);
}
reject('CHK-011: targetExercisedProof is not an object', base({ targetExercisedProof: 'harness-token' }), ['R1-1']);
for (const method of [undefined, 'artifact-presence', 'path-touch', 'Harness-Token', '']) {
  const a = base();
  if (method === undefined) delete a.targetExercisedProof.method;
  else a.targetExercisedProof.method = method;
  reject(`CHK-011: targetExercisedProof.method ${JSON.stringify(method)}`, a, ['R1-1']);
}
for (const field of ['adapterId', 'testCaseRef', 'targetBindingDigest']) {
  const a = base();
  delete a.targetExercisedProof[field];
  reject(`CHK-011: targetExercisedProof.${field} absent (an incomplete proof is R1-1, not a binding mismatch)`, a, ['R1-1']);
}

// ═══ R1-6 — UNREGISTERED OR MISMATCHED TARGET BINDING ════════════════════════
reject('CHK-011: NO committed binding registered for the target', base(), ['R1-6'], { binding: null });
{
  const a = base();
  a.targetExercisedProof.adapterId = 'node-test@1';
  a.targetExercisedProof.targetBindingDigest = targetBindingDigest({ ...BINDING, adapterId: 'node-test@1' });
  reject('CHK-011: adapterId mismatching the committed binding', a, ['R1-6']);
}
{
  const a = base();
  a.targetExercisedProof.testCaseRef = 'npm-script:test:OTHER';
  a.targetExercisedProof.targetBindingDigest = targetBindingDigest({ ...BINDING, testCaseRef: 'npm-script:test:OTHER' });
  reject('CHK-011: correct adapterId but WRONG testCaseRef is R1-6 (mismatch), NOT R1-1 (missing)', a, ['R1-6']);
}
{
  // THE DIGEST-SCOPE TRAP: a digest computed over the STORED entry (createdAt
  // included) must fail recomputation, because the digest scope is the
  // createdAt-stripped 3-field subobject.
  const a = base();
  a.targetExercisedProof.targetBindingDigest = canonDigest(COMMITTED);
  assert.notEqual(canonDigest(COMMITTED), targetBindingDigest(BINDING), 'the two digest scopes really differ');
  reject('CHK-011: targetBindingDigest computed WITH createdAt included', a, ['R1-6']);
}
{
  const a = base();
  a.targetExercisedProof.targetBindingDigest = `sha256:${'0'.repeat(64)}`;
  reject('CHK-011: targetBindingDigest that recomputes to nothing', a, ['R1-6']);
}

// ═══ R1-5 — adapterId absent from policy.runnerAdapterRegistry ═══════════════
// Only the envelope-decidable half of R1-5 (registry membership). argv
// derivation from the adapter template is the runner's check (W2e). The
// committed binding names the SAME unregistered adapter, so R1-6 does not fire
// and the tag is unambiguous.
{
  const GHOST = { acceptanceTargetRef: 'M1', adapterId: 'ghost@9', testCaseRef: 'npm-script:test:x' };
  const a = base();
  a.targetExercisedProof.adapterId = GHOST.adapterId;
  a.targetExercisedProof.targetBindingDigest = targetBindingDigest(GHOST);
  reject('adapterId absent from policy.runnerAdapterRegistry is R1-5', a, ['R1-5'], {
    binding: { ...GHOST, createdAt: '2026-08-01T00:00:00.000Z' },
  });
}

// ═══ CO-OCCURRENCE — neither tag suppresses the other ════════════════════════
{
  const a = base({
    matchers: [literal('L1', 'failed')], // R1-2 (below threshold)
    targetExercisedProof: {
      ...base().targetExercisedProof,
      supplementaryArtifact: { targetArtifactRef: '/absolute/path', expectation: 'present' }, // R1-3
    },
  });
  const result = reject('CHK-011: R1-2 and R1-3 co-occur and neither suppresses the other', a, ['R1-2', 'R1-3']);
  assert.ok(result.rejections.length >= 2, 'both rejections are individually reported, not merged');
}
{
  const a = base({ matchers: [literal('L1', 'failed')] }); // R1-2
  delete a.targetExercisedProof;                            // R1-1
  reject('CHK-011: R1-1 and R1-2 co-occur', a, ['R1-1', 'R1-2']);
}

// ═══ STRUCTURAL DIAGNOSTICS (no §1.6 tag is invented for them) ═══════════════
{
  const notAnObject = validateAssertionEnvelope({
    assertion: 'not-an-object', policy, policyDigest: POLICY_DIGEST, committedBinding: COMMITTED,
  });
  assert.equal(notAnObject.ok, false);
  assert.deepEqual(tagsOf(notAnObject), [], 'a non-object assertion carries no §1.6 tag');
  assert.ok(notAnObject.diagnostics.some((d) => d.code === 'assertion-not-an-object'));

  const wrongPolicyDigest = validateAssertionEnvelope({
    assertion: base({ policyDigest: `sha256:${'1'.repeat(64)}` }),
    policy, policyDigest: POLICY_DIGEST, committedBinding: COMMITTED,
  });
  assert.equal(wrongPolicyDigest.ok, false);
  assert.deepEqual(tagsOf(wrongPolicyDigest), [], 'a policyDigest mismatch carries no §1.6 tag');
  assert.ok(wrongPolicyDigest.diagnostics.some((d) => d.code === 'policy-digest-mismatch'));

  const noTarget = base();
  delete noTarget.acceptanceTargetRef;
  const missingTarget = validateAssertionEnvelope({
    assertion: noTarget, policy, policyDigest: POLICY_DIGEST, committedBinding: COMMITTED,
  });
  assert.equal(missingTarget.ok, false);
  assert.ok(missingTarget.diagnostics.some((d) => d.code === 'acceptance-target-ref-invalid'));
}

// ═══ TAG COVERAGE — no rejection class is silently untested ══════════════════
const coveredTags = new Set(results.filter((line) => line.startsWith('  REJECT')).flatMap((line) => line.split(/\s+/)[2].split('+')));
for (const tag of ['R1-1', 'R1-2', 'R1-3', 'R1-5', 'R1-6']) {
  assert.ok(coveredTags.has(tag), `the matrix must exercise ${tag} — an untested tag is an unverified rejection class`);
}

console.log('red-w2d-rejection-matrix: PASS');
console.log(`  ${results.length} fixtures; tags exercised: ${[...coveredTags].sort().join(', ')}`);
for (const line of results) console.log(line);
