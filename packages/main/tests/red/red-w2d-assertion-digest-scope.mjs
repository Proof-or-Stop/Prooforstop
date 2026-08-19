#!/usr/bin/env node
/**
 * RED artifact (W2d / B-9ff1, CHK-010 + CHK-003) — `assertionDigest` scope,
 * proven in BOTH directions.
 *
 * Repro-first RED: written and committed BEFORE
 * packages/main/src/core/red-evidence/envelope.ts exists; the import failure IS
 * the RED evidence.
 *
 * §1.1.4: `assertionDigest` = CANON over the assertion subobject INCLUDING
 * `policyDigest` and EXCLUDING `assertionDigest` itself.
 *
 * WHY BOTH DIRECTIONS
 * -------------------
 * A one-directional test ("the recomputed digest equals the stored one") passes
 * for any implementation whose recomputation happens to match its own stamping —
 * including a wrong one that forgot to strip the self field, as long as it forgot
 * consistently. This file therefore asserts the two NEGATIVE directions as well:
 *   - CANON over the FULL stored object (self field NOT stripped) must DIFFER;
 *   - CANON over the subobject with `policyDigest` REMOVED must DIFFER.
 * Only an implementation with the exact §1.1.4 scope satisfies all three.
 *
 * §0.4 omission: `greenExempt: false` is OMITTED, so an explicit false and an
 * absent field canonicalize identically (no digest fork), while `true` does not.
 *
 * Assurance scope (§0.6 practical tier): registered-surface drift detection, not
 * a defence against a hostile local agent (Tier-C).
 */
import { strict as assert } from 'node:assert';

const DIST = new URL('../../dist', import.meta.url).pathname;

const { computeAssertionDigest, canonicalAssertionSubobject, validateAssertionEnvelope } =
  await import(`${DIST}/core/red-evidence/envelope.js`);
const { canon, canonDigest, canonDigestOmitting } = await import(`${DIST}/core/red-evidence/canon.js`);
const { resolveRedEvidencePolicy } = await import(`${DIST}/core/red-evidence/policy.js`);
const { targetBindingDigest } = await import(`${DIST}/core/red-evidence/target-bindings.js`);

const FROZEN = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] });
assert.equal(FROZEN.ok, true);
const policy = FROZEN.snapshot;
const POLICY_DIGEST = FROZEN.policyDigest;

const BINDING = { acceptanceTargetRef: 'M1', adapterId: 'npm-script@1', testCaseRef: 'npm-script:test:x' };
const COMMITTED = { ...BINDING, createdAt: '2026-08-01T00:00:00.000Z' };
const ADMISSIBLE = "Error: Cannot find module '/repo/dist/x.js'";

function baseAssertion(overrides = {}) {
  return {
    acceptanceTargetRef: 'M1',
    matchers: [{ id: 'A1', kind: 'literal-line', value: ADMISSIBLE, stream: 'combined', polarity: 'present-in-red' }],
    expectedExitClass: 'nonzero',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: BINDING.testCaseRef,
      adapterId: BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(BINDING),
    },
    policyDigest: POLICY_DIGEST,
    ...overrides,
  };
}

// ── 1. The computed digest, and the STORED envelope that carries it ──────────
const candidate = baseAssertion();
const DIGEST = computeAssertionDigest(candidate);
assert.match(DIGEST, /^sha256:[0-9a-f]{64}$/, 'assertionDigest is a sha256: digest');

const stored = { ...candidate, assertionDigest: DIGEST };

// POSITIVE: CANON over the correctly stripped subobject reproduces the stored value.
assert.equal(
  canonDigestOmitting(stored, 'assertionDigest'),
  DIGEST,
  'CANON over the assertion with ONLY assertionDigest omitted must equal the stored assertionDigest',
);
assert.equal(computeAssertionDigest(stored), DIGEST,
  'the implementation recomputes the same digest from the STORED object (it strips the self field)');

// NEGATIVE 1: forgetting to strip the self field yields a DIFFERENT digest.
assert.notEqual(
  canonDigest(stored),
  DIGEST,
  'CANON over the FULL stored object (assertionDigest included) must NOT equal it — a validator that forgets to strip gets a different digest',
);

// NEGATIVE 2: omitting policyDigest from the canonical subobject yields a
// DIFFERENT digest (the assertion digest COVERS the policy digest).
const withoutPolicyDigest = { ...candidate };
delete withoutPolicyDigest.policyDigest;
assert.notEqual(
  canonDigest(withoutPolicyDigest),
  DIGEST,
  'CANON with policyDigest REMOVED must NOT equal the stored assertionDigest — policyDigest is inside the digest scope',
);
assert.ok(
  canon(canonicalAssertionSubobject(stored)).includes('"policyDigest"'),
  'the canonical subobject the digest is taken over must CONTAIN policyDigest',
);
assert.ok(
  !canon(canonicalAssertionSubobject(stored)).includes('"assertionDigest"'),
  'the canonical subobject must NOT contain assertionDigest (a digest cannot cover itself)',
);

// ── 2. policyDigest is load-bearing: change it, change the assertion identity ─
{
  const otherPolicy = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'], maxMatchers: 7 });
  assert.equal(otherPolicy.ok, true);
  assert.notEqual(otherPolicy.policyDigest, POLICY_DIGEST, 'the two policies really differ');
  const underOtherPolicy = baseAssertion({ policyDigest: otherPolicy.policyDigest });
  assert.notEqual(
    computeAssertionDigest(underOtherPolicy),
    DIGEST,
    'identical matchers + proof under a DIFFERENT policyDigest must yield a DIFFERENT assertionDigest',
  );
}

// ── 3. Determinism: serialization roundtrip and key order do not move it ─────
assert.equal(computeAssertionDigest(JSON.parse(JSON.stringify(stored))), DIGEST,
  'a JSON.parse(JSON.stringify(...)) roundtrip yields the same assertionDigest');
{
  const reordered = {
    policyDigest: stored.policyDigest,
    assertionDigest: stored.assertionDigest,
    targetExercisedProof: {
      targetBindingDigest: stored.targetExercisedProof.targetBindingDigest,
      adapterId: stored.targetExercisedProof.adapterId,
      testCaseRef: stored.targetExercisedProof.testCaseRef,
      method: stored.targetExercisedProof.method,
    },
    expectedExitClass: stored.expectedExitClass,
    matchers: stored.matchers,
    acceptanceTargetRef: stored.acceptanceTargetRef,
  };
  assert.equal(computeAssertionDigest(reordered), DIGEST, 'CANON is key-order independent');
}

// ── 4. Content sensitivity: one changed matcher value moves the digest ───────
{
  const changed = baseAssertion();
  changed.matchers = [{ ...changed.matchers[0], value: 'Error: Cannot find module /repo/dist/y.js' }];
  assert.notEqual(computeAssertionDigest(changed), DIGEST,
    'two envelopes differing by ONE matcher value must produce DIFFERENT assertionDigests');
}

// ── 5. §0.4 omission of greenExempt:false (CHK-003) ─────────────────────────
{
  const absent = baseAssertion();
  const explicitFalse = baseAssertion();
  explicitFalse.matchers = [{ ...explicitFalse.matchers[0], greenExempt: false }];
  const explicitTrue = baseAssertion();
  explicitTrue.matchers = [{ ...explicitTrue.matchers[0], greenExempt: true }];

  assert.equal(
    computeAssertionDigest(explicitFalse),
    computeAssertionDigest(absent),
    'greenExempt:false is OMITTED per §0.4, so it cannot fork the digest from an absent field',
  );
  assert.notEqual(
    computeAssertionDigest(explicitTrue),
    computeAssertionDigest(absent),
    'greenExempt:true IS covered by assertionDigest (it is an assertion-subobject field)',
  );
  assert.ok(!canon(canonicalAssertionSubobject(explicitFalse)).includes('greenExempt'),
    'the canonical subobject omits greenExempt:false');
  assert.ok(canon(canonicalAssertionSubobject(explicitTrue)).includes('greenExempt'),
    'the canonical subobject keeps greenExempt:true');
}

// ── 6. The validator reports the SAME computed digest ───────────────────────
{
  const result = validateAssertionEnvelope({
    assertion: stored, policy, policyDigest: POLICY_DIGEST, committedBinding: COMMITTED,
  });
  assert.equal(result.ok, true, `the fixture envelope must be admissible; got ${JSON.stringify(result.rejections)}`);
  assert.equal(result.assertionDigest, DIGEST, 'the validator reports the computed assertionDigest');
  // A stored assertionDigest that does NOT recompute is reported as a named
  // structural diagnostic (it is not one of the four §1.6 rejection classes, and
  // inventing a tag for it would be a mis-tag).
  const tampered = { ...stored, assertionDigest: `sha256:${'0'.repeat(64)}` };
  const tamperedResult = validateAssertionEnvelope({
    assertion: tampered, policy, policyDigest: POLICY_DIGEST, committedBinding: COMMITTED,
  });
  assert.equal(tamperedResult.ok, false, 'a stored assertionDigest that does not recompute is not admissible');
  assert.ok(
    tamperedResult.diagnostics.some((d) => d.code === 'assertion-digest-mismatch'),
    `expected an assertion-digest-mismatch diagnostic, got ${JSON.stringify(tamperedResult.diagnostics)}`,
  );
  assert.equal(tamperedResult.rejections.length, 0,
    'a digest mismatch carries NO §1.6 rejection tag — the four tags are reserved for the classes §1.6 defines');
}

console.log('red-w2d-assertion-digest-scope: PASS');
console.log(`  assertionDigest ${DIGEST}`);
console.log('  positive: CANON(assertion minus assertionDigest) === stored');
console.log('  negative: CANON(full stored object) !== stored; CANON(subobject minus policyDigest) !== stored');
console.log('  greenExempt:false omitted (no digest fork); greenExempt:true covered; key order + JSON roundtrip stable');
