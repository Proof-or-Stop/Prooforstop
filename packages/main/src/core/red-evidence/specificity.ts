// §1.3 minimum-specificity rules + the §1.11.4 entropy formula for the trusted
// RED-evidence subsystem (W2d / B-9ff1).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §1.3 (the
// three rules) and §1.11.4 (the exact entropy formula). This module is PURE:
// no filesystem, no environment, no process execution. It never runs a RED
// envelope — it only decides whether one would be admissible. Envelope-level
// assembly (which matcher is subject to which rule, and which §1.6 tag a
// failure carries) lives in envelope.ts.
//
// TWO TRAPS THIS MODULE EXISTS TO CLOSE
// -------------------------------------
//  1. TOTAL BITS, NOT PER-SYMBOL. §1.11.4 pins
//        entropyBits(value) = len(value) x H
//     where `len` is the BYTE length and `H` is the empirical per-byte Shannon
//     entropy. A per-symbol implementation (H alone) can never clear a 24-bit
//     floor (H <= 8 for bytes), so it would reject every realistic failure line
//     the spec admits. The committed differential table in
//     packages/main/tests/red/red-w2d-entropy-differential.mjs pins rows where
//     the two formulas give DIFFERENT verdicts.
//  2. CONJUNCTION, NOT DISJUNCTION. §1.3 rule 2 admits a literal iff the length
//     floor AND the entropy floor are both met (both inclusive `>=`). An OR
//     implementation admits long zero-entropy literals like `aaaaaaaaaaaa`,
//     which assert nothing. packages/main/tests/red/red-w2d-specificity-conjunction.mjs
//     pins rows that satisfy exactly ONE floor, where AND and OR must disagree.
//
// Both floors and the blocklist are read from the RESOLVED policy snapshot
// (§1.2 / §1.12) — never hard-coded here.
//
// Assurance scope (§0.6 practical tier): this detects drifted or incorrect
// admissibility through the registered surfaces. It does not resist a hostile
// local agent with filesystem control — that is the separate Tier-C program.

/** The policy fields the §1.3 rules read (a structural subset of the §1.2 snapshot). */
export interface SpecificityPolicy {
  minMatcherLen: number;
  minMatcherEntropyBits: number;
  forbiddenCatchAlls: readonly string[];
}

/** BYTE length of `value` (UTF-8), which is what §1.1.1 and §1.11.4 measure. */
export function valueByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * §1.11.4 empirical per-byte Shannon entropy `H = -SUM p(b) log2 p(b)` over the
 * byte-frequency distribution of `value`. The empty string has no distribution
 * and yields 0.
 *
 * This is the PER-SYMBOL quantity — it is deliberately NOT the admissibility
 * measure. {@link entropyBits} multiplies it by the byte length.
 */
export function perByteShannonEntropy(value: string): number {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length === 0) return 0;
  const frequency = new Map<number, number>();
  for (const byte of bytes) frequency.set(byte, (frequency.get(byte) ?? 0) + 1);
  let h = 0;
  for (const count of frequency.values()) {
    const p = count / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * §1.11.4 (EXACT): `entropyBits(value) = len(value) x H`, `len` in BYTES.
 *
 * TOTAL bits, not per-symbol: "a long low-variety string and a short
 * high-variety string are both measured honestly". Measuring UTF-16 code units
 * instead of bytes is a third wrong variant — a 4-byte / 2-code-unit character
 * separates them, and the committed differential test pins the byte answer.
 */
export function entropyBits(value: string): number {
  return valueByteLength(value) * perByteShannonEntropy(value);
}

/** The per-value §1.3 verdicts for one `literal-line` matcher value. */
export interface MatcherValueSpecificity {
  /** BYTE length of the value. */
  byteLength: number;
  /** §1.11.4 total entropy bits of the value. */
  entropyBits: number;
  /** §1.3 rule 1 clause a: the value is non-empty. */
  nonEmpty: boolean;
  /** §1.3 rule 1 clause b: the value is stored trimmed (also a §1.6 R1-3 bounds rule). */
  trimmed: boolean;
  /** §1.3 rule 1 clause c: the value is NOT a member of `policy.forbiddenCatchAlls`. */
  notBlocklisted: boolean;
  /** §1.3 rule 1: all three clauses above. */
  rule1: boolean;
  /** §1.3 rule 2 first conjunct: `len(value) >= policy.minMatcherLen`. */
  lengthFloor: boolean;
  /** §1.3 rule 2 second conjunct: `entropyBits(value) >= policy.minMatcherEntropyBits`. */
  entropyFloor: boolean;
  /** §1.3 rule 2: the CONJUNCTION `lengthFloor && entropyFloor` (never a disjunction). */
  rule2: boolean;
  /** Rules 1 and 2 together (rule 3 is an envelope-level rule; see envelope.ts). */
  admissible: boolean;
}

/**
 * Evaluate §1.3 rules 1 and 2 for a `literal-line` matcher value under the
 * resolved policy.
 *
 * NO SILENT TRIMMING (deliberate): §1.1.1 requires the value to be STORED
 * trimmed, and §1.6 assigns an untrimmed value to R1-3 (bounds). Trimming here
 * would convert `" .* "` into the blocklisted `".*"` and report a
 * minimum-specificity failure (R1-2) instead of the bounds failure that actually
 * occurred — exactly the R1-2/R1-3 collapse §1.6 forbids. The blocklist clause
 * therefore tests membership against the value AS GIVEN, and the envelope layer
 * evaluates §1.3 only over matchers that already cleared the bounds layer, so a
 * whitespace violation is reported once, as R1-3.
 */
export function matcherValueSpecificity(value: string, policy: SpecificityPolicy): MatcherValueSpecificity {
  const byteLength = valueByteLength(value);
  const bits = entropyBits(value);
  // Rule 1: a degenerate literal — the three §1.3 clauses, kept separable so a
  // caller (and the committed regressions) can tell WHICH clause failed.
  const nonEmpty = value.length > 0;
  const trimmed = value === value.trim();
  const notBlocklisted = !policy.forbiddenCatchAlls.includes(value);
  const rule1 = nonEmpty && trimmed && notBlocklisted;
  const lengthFloor = byteLength >= policy.minMatcherLen;
  const entropyFloor = bits >= policy.minMatcherEntropyBits;
  // Rule 2 is a CONJUNCTION. Do not "simplify" this to `||`.
  const rule2 = lengthFloor && entropyFloor;
  return {
    byteLength,
    entropyBits: bits,
    nonEmpty,
    trimmed,
    notBlocklisted,
    rule1,
    lengthFloor,
    entropyFloor,
    rule2,
    admissible: rule1 && rule2,
  };
}
