#!/usr/bin/env node
/**
 * RED artifact (W2d / B-9ff1, CHK-006 + CHK-007 + CHK-008) — the §1.3
 * minimum-specificity rules, with rule 2 proven to be a CONJUNCTION.
 *
 * Repro-first RED: written and committed BEFORE
 * packages/main/src/core/red-evidence/{specificity,envelope}.ts exist; the
 * import failure below IS the RED evidence.
 *
 * WHY THIS FILE IS A PROOF AND NOT A RUBBER STAMP
 * -----------------------------------------------
 * §1.3 rule 2 admits a literal iff
 *     len(value) >= minMatcherLen  AND  entropyBits(value) >= minMatcherEntropyBits
 * An OR implementation passes any test whose rows satisfy both floors or neither.
 * So the table below is built from rows that satisfy EXACTLY ONE floor, where AND
 * and OR necessarily disagree, and every row asserts the AND verdict.
 *
 * Both single-floor directions are covered:
 *   - length passes / entropy fails: reachable under the frozen default policy
 *     (a long low-variety literal).
 *   - length fails / entropy passes: NOT reachable under the frozen default
 *     policy, because a value shorter than 8 bytes can carry at most
 *     7 x log2(7) = 19.65 bits, below the 24-bit floor. It is therefore proven
 *     under a policy that RAISES minMatcherLen to 16 (§1.12 permits raising) —
 *     which additionally proves the floors are read from the RESOLVED policy and
 *     are not hard-coded constants.
 *
 * Rule 1 (blocklist) and rule 3 (a class matcher can never be the sole
 * present-in-red evidence) are asserted here too, each with its EXACT §1.6 tag:
 * both are R1-2 (minimum-specificity), never R1-3 (bounds).
 *
 * Assurance scope (§0.6 practical tier): registered-surface drift detection, not
 * a defence against a hostile local agent (Tier-C).
 */
import { strict as assert } from 'node:assert';

const DIST = new URL('../../dist', import.meta.url).pathname;

const { entropyBits, valueByteLength, matcherValueSpecificity } =
  await import(`${DIST}/core/red-evidence/specificity.js`);
const { validateAssertionEnvelope } = await import(`${DIST}/core/red-evidence/envelope.js`);
const { resolveRedEvidencePolicy } = await import(`${DIST}/core/red-evidence/policy.js`);
const { targetBindingDigest } = await import(`${DIST}/core/red-evidence/target-bindings.js`);
const { DEFAULT_FORBIDDEN_CATCH_ALLS } = await import(`${DIST}/core/red-evidence/registries.js`);

const FROZEN = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] });
assert.equal(FROZEN.ok, true, 'frozen default policy resolves');
assert.equal(
  FROZEN.policyDigest,
  'sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767',
  'frozen default policyDigest is the W2a pinned literal',
);
const policy = FROZEN.snapshot;

// A policy that RAISES the length floor to 16 (legal: §1.12 floor is >= 4).
const RAISED = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'], minMatcherLen: 16 });
assert.equal(RAISED.ok, true, 'a raised minMatcherLen policy resolves');
const raisedPolicy = RAISED.snapshot;

// ── Envelope fixture plumbing (rules 1 and 3 are envelope-level) ─────────────
const BINDING = { acceptanceTargetRef: 'M1', adapterId: 'npm-script@1', testCaseRef: 'npm-script:test:x' };
const COMMITTED = { ...BINDING, createdAt: '2026-08-01T00:00:00.000Z' };
const ADMISSIBLE = "Error: Cannot find module '/repo/dist/x.js'";

function assertionWith(matchers) {
  return {
    acceptanceTargetRef: 'M1',
    matchers,
    expectedExitClass: 'nonzero',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: BINDING.testCaseRef,
      adapterId: BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(BINDING),
    },
  };
}

function validate(matchers, usePolicy = policy, useDigest = FROZEN.policyDigest) {
  return validateAssertionEnvelope({
    assertion: assertionWith(matchers),
    policy: usePolicy,
    policyDigest: useDigest,
    committedBinding: COMMITTED,
  });
}

const tagsOf = (result) => [...new Set(result.rejections.map((r) => r.tag))].sort();
const literal = (id, value, polarity = 'present-in-red', stream = 'combined') =>
  ({ id, kind: 'literal-line', value, stream, polarity });
const klass = (id, value, polarity = 'present-in-red', stream = 'stderr') =>
  ({ id, kind: 'class', value, stream, polarity });

// Baseline: the fixture itself is admissible, so every rejection below is caused
// by the one thing the row changes (no silent background failure).
{
  const ok = validate([literal('A1', ADMISSIBLE)]);
  assert.equal(ok.ok, true, `baseline fixture must be admissible; got ${JSON.stringify(ok.rejections)}`);
}

// ── 1. §1.3 rule 1 — the forbiddenCatchAlls BLOCKLIST (R1-2) ─────────────────
assert.equal(DEFAULT_FORBIDDEN_CATCH_ALLS.length, 8, 'the frozen default blocklist has 8 entries');
for (const entry of DEFAULT_FORBIDDEN_CATCH_ALLS) {
  assert.equal(matcherValueSpecificity(entry, policy).rule1, false,
    `blocklist entry ${JSON.stringify(entry)} must fail rule 1`);
  const result = validate([literal('A1', entry)]);
  assert.equal(result.ok, false, `blocklist entry ${JSON.stringify(entry)} must reject`);
  assert.ok(
    result.rejections.some((r) => r.tag === 'R1-2'),
    `blocklist entry ${JSON.stringify(entry)} must be tagged R1-2 (minimum-specificity), got ${JSON.stringify(tagsOf(result))}`,
  );
}
// Membership, NOT substring: a value that merely CONTAINS a blocklist entry passes rule 1.
assert.equal(matcherValueSpecificity('Error: .* pattern not found', policy).rule1, true,
  'rule 1 is exact membership, not substring containment');
assert.equal(validate([literal('A1', 'Error: .* pattern not found')]).ok, true,
  'a literal merely CONTAINING a blocklist entry is admissible');
// No silent trimming: the blocklist clause tests the value AS STORED, so ' .* '
// is NOT a blocklist member (it differs from '.*'); what it violates is the
// TRIMMED clause, which §1.6 assigns to R1-3 (bounds). A validator that silently
// trimmed would report R1-2 here and hide the whitespace violation — the exact
// R1-2/R1-3 collapse §1.6 forbids.
{
  const untrimmedSpecificity = matcherValueSpecificity(' .* ', policy);
  assert.equal(untrimmedSpecificity.notBlocklisted, true,
    'blocklist membership is tested on the value AS STORED: " .* " is not the member ".*"');
  assert.equal(untrimmedSpecificity.trimmed, false, 'the untrimmed clause is what " .* " violates');
  const untrimmed = validate([literal('A1', ' .* ')]);
  assert.equal(untrimmed.ok, false, 'an untrimmed value rejects');
  assert.deepEqual(tagsOf(untrimmed), ['R1-3'],
    `an untrimmed value is a BOUNDS failure tagged R1-3 ALONE, got ${JSON.stringify(tagsOf(untrimmed))}`);
}

// ── 2. §1.3 rule 2 — THE AND-vs-OR DIFFERENTIAL TABLE ───────────────────────
// Every row records both candidate verdicts. `differential: true` rows satisfy
// exactly one floor and therefore SEPARATE AND from OR.
const MIN_DIFFERENTIAL_ROWS = 10;

function tableRow(value, usePolicy) {
  const len = valueByteLength(value);
  const bits = entropyBits(value);
  const lenOk = len >= usePolicy.minMatcherLen;
  const entOk = bits >= usePolicy.minMatcherEntropyBits;
  return { value, len, bits, lenOk, entOk, and: lenOk && entOk, or: lenOk || entOk, policy: usePolicy };
}

const DEFAULT_ROWS = [
  // length PASSES, entropy FAILS -> AND rejects, OR admits (DIFFERENTIAL)
  'aaaaaaaa',
  'aaaaaaaaaaaa',
  'xxxxxxxx',
  '========',
  '--------',
  'abababababab',
  'aabbaabb',
  'abcabcabcabc',
  'ababababab',
  'aaaaaaaaab',
  'zzzzzzzzzzzz',
  'abcabcab',
  // both floors PASS -> AND and OR agree (admit)
  'aabbccddeeff',
  "Error: Cannot find module '/repo/dist/x.js'",
  'abcdefgh',
  // both floors FAIL -> AND and OR agree (reject)
  'Err',
  'ab',
].map((value) => tableRow(value, policy));

// The other direction is unreachable under the frozen default policy (a value
// below 8 bytes cannot carry 24 bits), so it is proven under the raised-length
// policy — which also proves the floors come from the resolved policy.
const RAISED_ROWS = ['Cannot find', 'no such file'].map((value) => tableRow(value, raisedPolicy));

let differentialRows = 0;
let lengthOnlyRows = 0;
let entropyOnlyRows = 0;
const rendered = [];
for (const row of [...DEFAULT_ROWS, ...RAISED_ROWS]) {
  const differential = row.and !== row.or;
  if (differential) differentialRows += 1;
  if (row.lenOk && !row.entOk) lengthOnlyRows += 1;
  if (!row.lenOk && row.entOk) entropyOnlyRows += 1;

  const impl = matcherValueSpecificity(row.value, row.policy);
  assert.equal(impl.lengthFloor, row.lenOk, `${JSON.stringify(row.value)}: length-floor verdict`);
  assert.equal(impl.entropyFloor, row.entOk, `${JSON.stringify(row.value)}: entropy-floor verdict`);
  assert.equal(
    impl.rule2,
    row.and,
    `${JSON.stringify(row.value)}: rule 2 must be the AND verdict ${row.and} (an OR implementation would say ${row.or}); len=${row.len}>=${row.policy.minMatcherLen}?${row.lenOk} bits=${row.bits.toFixed(2)}>=${row.policy.minMatcherEntropyBits}?${row.entOk}`,
  );
  // ... and the whole-envelope verdict follows rule 2 with the R1-2 tag.
  const envelope = validateAssertionEnvelope({
    assertion: assertionWith([literal('A1', row.value)]),
    policy: row.policy,
    policyDigest: row.policy === policy ? FROZEN.policyDigest : RAISED.policyDigest,
    committedBinding: COMMITTED,
  });
  if (row.and) {
    assert.equal(envelope.ok, true, `${JSON.stringify(row.value)}: AND-admissible literal must produce an admissible envelope`);
  } else {
    assert.equal(envelope.ok, false, `${JSON.stringify(row.value)}: AND-inadmissible literal must reject`);
    assert.ok(
      envelope.rejections.some((r) => r.tag === 'R1-2'),
      `${JSON.stringify(row.value)}: a rule-2 failure is tagged R1-2, got ${JSON.stringify(tagsOf(envelope))}`,
    );
    assert.ok(
      !envelope.rejections.some((r) => r.tag === 'R1-3'),
      `${JSON.stringify(row.value)}: a rule-2 failure must NOT be tagged R1-3 (bounds) — R1-2 and R1-3 must never be collapsed`,
    );
  }
  rendered.push(
    `  ${differential ? 'DIFFER ' : 'agree  '} ${JSON.stringify(row.value).padEnd(46)} len=${String(row.len).padStart(3)}>=${String(row.policy.minMatcherLen).padStart(2)}?${row.lenOk ? 'Y' : 'N'} bits=${row.bits.toFixed(2).padStart(7)}>=${row.policy.minMatcherEntropyBits}?${row.entOk ? 'Y' : 'N'}  AND=${row.and ? 'ADMIT ' : 'REJECT'} OR=${row.or ? 'ADMIT' : 'REJECT'}`,
  );
}

assert.ok(
  differentialRows >= MIN_DIFFERENTIAL_ROWS,
  `the table needs at least ${MIN_DIFFERENTIAL_ROWS} rows where AND and OR DIVERGE (found ${differentialRows})`,
);
assert.ok(lengthOnlyRows > 0, 'the table must contain rows satisfying ONLY the length floor');
assert.ok(entropyOnlyRows > 0, 'the table must contain rows satisfying ONLY the entropy floor (the other single-floor direction)');

// Boundary inclusivity: exactly at BOTH floors is admissible (>=, not >).
{
  const atBoundary = 'abcdefgh'; // 8 bytes = minMatcherLen, 24.0 bits = minMatcherEntropyBits
  assert.equal(valueByteLength(atBoundary), policy.minMatcherLen);
  assert.equal(entropyBits(atBoundary), policy.minMatcherEntropyBits);
  assert.equal(matcherValueSpecificity(atBoundary, policy).rule2, true, 'both floors are inclusive (>=)');
  const justBelow = 'abcdefga'; // 8 bytes but one repeat: 22.0 bits, just under the floor
  assert.ok(entropyBits(justBelow) < policy.minMatcherEntropyBits);
  assert.equal(matcherValueSpecificity(justBelow, policy).rule2, false, 'one bit below the entropy floor rejects');
}

// ── 3. §1.3 rule 3 — a class matcher is never the sole present-in-red (R1-2) ──
function assertRule3Rejection(matchers, label) {
  const result = validate(matchers);
  assert.equal(result.ok, false, `${label}: must reject`);
  assert.ok(
    result.rejections.some((r) => r.tag === 'R1-2'),
    `${label}: rule 3 is a MINIMUM-SPECIFICITY failure tagged R1-2, got ${JSON.stringify(tagsOf(result))}`,
  );
}

assertRule3Rejection([klass('C1', 'stderr-nonempty')], 'class-only present-in-red');
assertRule3Rejection(
  [klass('C1', 'stderr-nonempty'), klass('C2', 'nonzero-exit', 'present-in-red', 'combined')],
  'multiple class matchers as the only present-in-red',
);
assertRule3Rejection(
  [klass('C1', 'stderr-nonempty'), literal('L1', ADMISSIBLE, 'absent-in-green'), literal('L2', ADMISSIBLE, 'present-in-green')],
  'literal-line matchers exist but none is present-in-red',
);
assertRule3Rejection(
  [klass('C1', 'stderr-nonempty'), literal('L1', 'aaaaaaaaaaaa')],
  'the only present-in-red literal is INADMISSIBLE (fails rule 2), so the class matcher is left as the sole evidence',
);
// An envelope with NO present-in-red matcher at all is the same vacuous-RED
// family (§1.1.1 / §1.3 rule 3 "at least one") and is likewise R1-2.
assertRule3Rejection(
  [literal('L1', ADMISSIBLE, 'absent-in-green'), literal('L2', ADMISSIBLE, 'present-in-green')],
  'no present-in-red matcher at all',
);

// Accepting side of rule 3: a class matcher is legal when an admissible
// literal-line present-in-red matcher supplements it, and a pure literal set is
// fine on its own (rule 3 constrains only class matchers).
assert.equal(validate([literal('L1', ADMISSIBLE), klass('C1', 'stderr-nonempty')]).ok, true,
  'an admissible literal + a class matcher satisfies rule 3');
assert.equal(validate([literal('L1', ADMISSIBLE)]).ok, true,
  'a pure literal-line present-in-red set needs no class matcher');
// Class matchers stay EXEMPT from rule 2 (§1.3): the SAME string that is
// inadmissible as a literal-line value is admissible as a registered class NAME,
// because a class's breadth is bounded by the policy registry instead.
{
  const CUSTOM = resolveRedEvidencePolicy({
    pinnedPath: ['/usr/bin'],
    matcherClassRegistry: [{ name: 'ex', predicateKind: 'stream-nonempty' }],
  });
  assert.equal(CUSTOM.ok, true, 'a policy with a custom class registry resolves');
  assert.equal(valueByteLength('ex'), 2);
  assert.equal(matcherValueSpecificity('ex', CUSTOM.snapshot).rule2, false,
    '"ex" is 2 bytes / 2.0 bits — it fails BOTH rule-2 floors');
  const asLiteral = validateAssertionEnvelope({
    assertion: assertionWith([literal('L1', 'ex')]),
    policy: CUSTOM.snapshot, policyDigest: CUSTOM.policyDigest, committedBinding: COMMITTED,
  });
  assert.equal(asLiteral.ok, false, 'as a literal-line VALUE, "ex" fails rule 2 and rejects');
  const asClass = validateAssertionEnvelope({
    assertion: assertionWith([literal('L1', ADMISSIBLE), klass('C1', 'ex')]),
    policy: CUSTOM.snapshot, policyDigest: CUSTOM.policyDigest, committedBinding: COMMITTED,
  });
  assert.equal(asClass.ok, true,
    'the SAME string as a registered class NAME is exempt from rule 2 — kind, not value, decides');
}

// ── CHARACTERIZATION: short real-world failure constants (B-9ff1 F-060) ──────
// Pins the CURRENT verdicts of §1.3 rule 2 on short, well-known failure
// signatures. NOT an endorsement of those verdicts: B-9ff1:F-058 records that
// the rule INVERTS on exactly this class, because character-level Shannon
// entropy measures alphabet diversity rather than semantic specificity, so
// signal names, errno codes and HTTP status lines fall below the floors while
// the vaguer phrase "test failed" clears them on character variety alone.
// Whether the metric should change is a §1.2/§1.3/§1.12 spec decision deferred
// to the spec owner. Until it lands, these rows make any future change to the
// entropy formula fail HERE mechanically, instead of needing another reviewer
// hand-probe as F-058 did. Measured values are DERIVED from the same functions
// under test, never restated as literals - a hand-typed 15.65 would drift the
// moment the formula moves, which is the defect this story has recorded twice.
{
  const CHARACTERIZATION = [
    { value: 'SIGSEGV', admitted: false, why: 'both floors fail' },
    { value: 'ENOMEM', admitted: false, why: 'both floors fail; also below the NON-TUNABLE hard entropy floor, so no policy can ever admit it' },
    { value: 'HTTP 404', admitted: false, why: 'length clears, entropy alone rejects' },
    { value: 'Error 500', admitted: false, why: 'length clears, entropy alone rejects' },
    { value: 'test failed', admitted: true, why: 'THE INVERSION: vaguer than every row above, yet admitted on character variety alone' },
  ];
  let admittedCount = 0;
  const rows = [];
  for (const row of CHARACTERIZATION) {
    const len = valueByteLength(row.value);
    const bits = entropyBits(row.value);
    const result = validate([literal('L1', row.value)]);
    assert.equal(
      result.ok, row.admitted,
      `characterization drift on ${JSON.stringify(row.value)} (len=${len}, bits=${bits.toFixed(2)}, ${row.why}): `
      + `expected admitted=${row.admitted}, got ${result.ok}. The specificity metric changed, so the set of `
      + 'pinnable real-world failure signatures moved with it. Re-derive these expectations from the new rule '
      + '(see B-9ff1:F-058) rather than editing them to pass.',
    );
    if (result.ok) admittedCount += 1;
    rows.push(`    ${JSON.stringify(row.value).padEnd(15)} len=${String(len).padStart(2)} bits=${bits.toFixed(2).padStart(6)} -> ${result.ok ? 'ADMIT' : 'REJECT'}`);
  }
  assert.equal(
    admittedCount, 1,
    'exactly one characterization row is admitted today and it is the VAGUEST one; if that stops holding, the F-058 inversion has changed shape',
  );
  const vaguest = CHARACTERIZATION.find((r) => r.admitted);
  assert.ok(
    entropyBits(vaguest.value) > Math.max(...CHARACTERIZATION.filter((r) => !r.admitted).map((r) => entropyBits(r.value))),
    'the inversion is that the admitted row scores HIGHER than every rejected one; if that ordering breaks the metric changed',
  );
  console.log(`  characterization (F-060): ${CHARACTERIZATION.length} short real-world constants pinned; ${admittedCount} admitted (the vaguest) - documents the F-058 inversion`);
  for (const line of rows) console.log(line);
}

console.log('red-w2d-specificity-conjunction: PASS');
console.log(`  rule 1: all ${DEFAULT_FORBIDDEN_CATCH_ALLS.length} blocklist entries reject R1-2; membership not substring; no silent trim (untrimmed is R1-3)`);
console.log(`  rule 2 differential rows: ${differentialRows} (length-only ${lengthOnlyRows}, entropy-only ${entropyOnlyRows}, floor ${MIN_DIFFERENTIAL_ROWS})`);
for (const line of rendered) console.log(line);
console.log('  rule 3: class-only / multi-class / no-present-in-red / inadmissible-literal+class all reject R1-2 (never R1-3)');
