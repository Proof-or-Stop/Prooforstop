#!/usr/bin/env node
/**
 * RED artifact (W2d / B-9ff1, CHK-009) — the §1.11.4 entropy formula is
 * TOTAL BITS, not per-symbol.
 *
 * Repro-first RED: written and committed BEFORE
 * packages/main/src/core/red-evidence/specificity.ts exists. At that point the
 * import of ../../dist/core/red-evidence/specificity.js fails
 * (ERR_MODULE_NOT_FOUND) and the process exits non-zero — that import failure IS
 * the RED evidence that the entropy formula has no implementation yet.
 *
 * WHY THIS FILE IS A PROOF AND NOT A RUBBER STAMP
 * -----------------------------------------------
 * A test that merely asserts `entropyBits(v) >= floor` for values the
 * implementation already admits proves nothing: a per-symbol implementation
 * (`H` alone, without the `len(value) x` factor) would satisfy an equally
 * plausible-looking assertion set. So this file builds a fixture TABLE and, for
 * every row, computes BOTH candidate formulas from independent reference code
 * defined here (never imported from the implementation):
 *
 *   spec (§1.11.4)  entropyBits(v) = byteLength(v) x H(v)     <- TOTAL bits
 *   rival           entropyBits(v) = H(v)                     <- per-symbol
 *
 * and asserts (a) the two candidates give DIFFERENT admissibility verdicts on at
 * least MIN_DIFFERENTIAL_ROWS rows, and (b) the implementation reproduces the
 * SPEC verdict on every row. Rows where both candidates agree are kept and
 * LABELLED as non-differential so the table cannot be mistaken for a proof it is
 * not.
 *
 * A third rival — measuring UTF-16 code units instead of bytes — is separated by
 * the multi-byte row at the end.
 *
 * Assurance scope (§0.6 practical tier): this detects an incorrect or drifted
 * formula through the registered surfaces. It is not a defence against a hostile
 * local agent with filesystem control (that is the Tier-C program).
 */
import { strict as assert } from 'node:assert';

const DIST = new URL('../../dist', import.meta.url).pathname;

const { entropyBits, valueByteLength, matcherValueSpecificity } =
  await import(`${DIST}/core/red-evidence/specificity.js`);
const { resolveRedEvidencePolicy } = await import(`${DIST}/core/red-evidence/policy.js`);

// The frozen default policy (W2a): minMatcherLen 8, minMatcherEntropyBits 24.
const resolved = resolveRedEvidencePolicy({ pinnedPath: ['/usr/bin'] });
assert.equal(resolved.ok, true, 'frozen default policy must resolve');
const policy = resolved.snapshot;
assert.equal(policy.minMatcherEntropyBits, 24, 'frozen default entropy floor is 24 bits');
assert.equal(policy.minMatcherLen, 8, 'frozen default length floor is 8 bytes');

// ── Independent reference implementations (NOT imported) ─────────────────────

/** Empirical per-byte Shannon entropy H over the byte-frequency distribution. */
function refPerByteH(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length === 0) return 0;
  const freq = new Map();
  for (const b of bytes) freq.set(b, (freq.get(b) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** SPEC §1.11.4: total bits = byteLength x H. */
function refTotalBits(value) {
  return Buffer.byteLength(value, 'utf8') * refPerByteH(value);
}

/** RIVAL A: per-symbol entropy (H alone) — the formula §1.11.4 explicitly is NOT. */
function rivalPerSymbol(value) {
  return refPerByteH(value);
}

/** RIVAL B: UTF-16 code-unit measurement instead of bytes. */
function rivalCodeUnits(value) {
  if (value.length === 0) return 0;
  const freq = new Map();
  for (const unit of value) freq.set(unit, (freq.get(unit) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    h -= p * Math.log2(p);
  }
  return value.length * h;
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

// ── 1. Exact formula anchors (§1.11.4) ───────────────────────────────────────
// Hand-computable values: 'ab' is 2 bytes over 2 equiprobable symbols (H = 1),
// so TOTAL bits = 2 while per-symbol stays 1. 'aabb' doubles the length with the
// SAME per-symbol entropy: total bits grows to 4, per-symbol is still 1. That
// growth-with-length IS the multiplication by byte length.
assert.ok(close(entropyBits('ab'), 2), `entropyBits('ab') must be 2.0 total bits, got ${entropyBits('ab')}`);
assert.ok(close(entropyBits('aabb'), 4), `entropyBits('aabb') must be 4.0 total bits, got ${entropyBits('aabb')}`);
assert.ok(close(rivalPerSymbol('ab'), 1) && close(rivalPerSymbol('aabb'), 1),
  'the per-symbol rival is CONSTANT (1.0) across both, while the spec formula doubles — the growth is the discriminator');
assert.ok(close(entropyBits('a'), 0), 'a single distinct byte has H = 0, so entropyBits = 1 x 0 = 0');
assert.ok(close(entropyBits(''), 0), 'the empty string carries 0 bits (degenerate, rejected elsewhere by the bounds layer)');
// 8 distinct equiprobable bytes: H = 3 exactly, so total = 8 x 3 = 24 exactly.
assert.ok(close(entropyBits('abcdefgh'), 24), `entropyBits('abcdefgh') must be exactly 24.0, got ${entropyBits('abcdefgh')}`);

// ── 2. THE DIFFERENTIAL TABLE (total-bits vs per-symbol) ─────────────────────
// Each row records both candidate verdicts under the frozen default entropy
// floor of 24 bits. `differential: true` rows are the proof; `false` rows are
// kept for honesty (they prove nothing about which formula is implemented).
const MIN_DIFFERENTIAL_ROWS = 8;
const TABLE = [
  { value: "Error: Cannot find module '/repo/dist/x.js'", note: 'realistic module-resolution failure' },
  { value: 'AssertionError: expected 1 to equal 2', note: 'realistic assertion failure' },
  { value: 'npm ERR! missing script: test', note: 'realistic npm failure line' },
  { value: 'TypeError: x is not a function', note: 'realistic type failure' },
  { value: 'ENOENT: no such file or directory', note: 'realistic errno line' },
  { value: 'FAIL packages/main/tests/red/x.mjs', note: 'realistic reporter line' },
  { value: 'exit status 1 (expected 0)', note: 'realistic exit line' },
  { value: 'abcdefgh', note: 'boundary: exactly 24.0 total bits (>= is inclusive)' },
  { value: 'aabbccddeeff', note: '12 bytes over 6 symbols = 31.0 total bits' },
  { value: 'aabbccdd', note: 'AGREE: 8 bytes over 4 symbols = 16.0 total bits, below the floor' },
  { value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', note: 'AGREE: 28 identical bytes, H = 0 so total = 0 (zero-entropy boundary)' },
  { value: 'ab', note: 'AGREE: 2.0 total bits, below the floor either way' },
];

let differentialRows = 0;
const renderedTable = [];
for (const row of TABLE) {
  const specBits = refTotalBits(row.value);
  const rivalBits = rivalPerSymbol(row.value);
  const specVerdict = specBits >= policy.minMatcherEntropyBits;
  const rivalVerdict = rivalBits >= policy.minMatcherEntropyBits;
  const differential = specVerdict !== rivalVerdict;
  if (differential) differentialRows += 1;

  // (a) the implementation reproduces the SPEC number ...
  assert.ok(
    close(entropyBits(row.value), specBits),
    `entropyBits(${JSON.stringify(row.value)}) must equal byteLength x H = ${specBits}, got ${entropyBits(row.value)}`,
  );
  // ... and (b) the implementation's ENTROPY-FLOOR verdict is the spec verdict,
  // never the rival's.
  const impl = matcherValueSpecificity(row.value, policy);
  assert.equal(
    impl.entropyFloor,
    specVerdict,
    `${JSON.stringify(row.value)}: implementation entropy verdict ${impl.entropyFloor} must equal the TOTAL-BITS verdict ${specVerdict} (per-symbol rival would say ${rivalVerdict})`,
  );
  renderedTable.push(
    `  ${differential ? 'DIFFER ' : 'agree  '} ${JSON.stringify(row.value).padEnd(46)} total=${specBits.toFixed(2).padStart(7)} perSymbol=${rivalBits.toFixed(2).padStart(5)} spec=${specVerdict ? 'ADMIT ' : 'REJECT'} rival=${rivalVerdict ? 'ADMIT' : 'REJECT'}  ${row.note}`,
  );
}

assert.ok(
  differentialRows >= MIN_DIFFERENTIAL_ROWS,
  `the table must contain at least ${MIN_DIFFERENTIAL_ROWS} rows where total-bits and per-symbol give DIFFERENT verdicts (found ${differentialRows}) — without them the table proves nothing`,
);
// The per-symbol rival can never clear a 24-bit floor (max per-byte H is 8), so
// every spec-ADMIT row is a differential row. Assert that structural fact so a
// future floor change cannot silently make the table vacuous.
assert.ok(
  TABLE.every((row) => !(refTotalBits(row.value) >= policy.minMatcherEntropyBits) || rivalPerSymbol(row.value) < policy.minMatcherEntropyBits),
  'every spec-ADMIT row must be one the per-symbol rival REJECTS',
);

// ── 3. RIVAL B: bytes, not UTF-16 code units ─────────────────────────────────
// A 4-byte / 2-code-unit emoji makes Buffer.byteLength differ from String.length,
// so the byte-based formula and the code-unit-based formula land on OPPOSITE
// sides of the 24-bit floor.
const MULTIBYTE = '\u{1F4A5} boom';
assert.equal(valueByteLength(MULTIBYTE), 9, 'the emoji row is 9 UTF-8 bytes');
assert.equal(MULTIBYTE.length, 7, 'the same row is only 7 UTF-16 code units');
const byteBits = refTotalBits(MULTIBYTE);
const unitBits = rivalCodeUnits(MULTIBYTE);
assert.ok(close(entropyBits(MULTIBYTE), byteBits),
  `entropyBits must measure BYTES (${byteBits}), got ${entropyBits(MULTIBYTE)} (code-unit rival would be ${unitBits})`);
assert.ok(
  (byteBits >= policy.minMatcherEntropyBits) !== (unitBits >= policy.minMatcherEntropyBits),
  `the multi-byte row must SEPARATE the two measurements: bytes=${byteBits} units=${unitBits} against floor ${policy.minMatcherEntropyBits}`,
);
assert.equal(matcherValueSpecificity(MULTIBYTE, policy).entropyFloor, byteBits >= policy.minMatcherEntropyBits,
  'the implementation follows the BYTE measurement on the multi-byte row');

console.log('red-w2d-entropy-differential: PASS');
console.log(`  formula anchors: ab=2.0 aabb=4.0 a=0.0 abcdefgh=24.0 (per-symbol rival is constant 1.0 for ab/aabb)`);
console.log(`  differential rows: ${differentialRows}/${TABLE.length} (floor ${MIN_DIFFERENTIAL_ROWS})`);
for (const line of renderedTable) console.log(line);
console.log(`  multi-byte separation: bytes=${byteBits.toFixed(2)} (ADMIT) vs code-units=${unitBits.toFixed(2)} (REJECT)`);
