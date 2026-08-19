// §1.1 assertion-envelope schema + §1.6 tagged admissibility validation for the
// trusted RED-evidence subsystem (W2d / B-9ff1).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §1.1 (the
// envelope schema and every field rule), §1.2 (policy-owned bounds and
// registries), §1.3 (minimum specificity, implemented in specificity.ts), §1.6
// (the rejection rules and their tags), §1.11 (matcher evaluation semantics).
//
// THIS LEAF VALIDATES AN ENVELOPE AND NEVER EXECUTES ONE. This module is PURE:
// no filesystem, no environment, no child process, no clock. It writes no
// record, no receipt, no chain entry, and no gate verdict. Reading the committed
// target binding (W2b `readCommittedTargetBindings`) happens in the handler and
// is passed in as `committedBinding`; running the RED command, deriving argv,
// evaluating matchers against real output, and every gate consumption are
// reserved for later leaves (W2e+ / W3).
//
// NO PATTERN LANGUAGE EXISTS HERE (§1.11 rule 1, rev 6 MOVE 1). `literal-line`
// is a whole-line trimmed STRING EQUALITY at evaluation time; nothing is
// compiled, there are no anchors and no quantifiers, and `kind` is the closed
// two-member set below. An unknown `kind` — including `anchored-regex` or any
// alias — is a §1.6 R1-3 bounds rejection.
//
// THE TAG DISCIPLINE (the single most important invariant in this module)
// ----------------------------------------------------------------------
//   R1-1  the target-exercised proof is MISSING or structurally incomplete
//   R1-2  MINIMUM SPECIFICITY (§1.3): a degenerate literal (EMPTY or
//         blocklisted, §1.3 rule 1), a literal below the length-AND-entropy
//         floor (rule 2), or a `present-in-red` set with no admissible
//         `literal-line` matcher (rule 3)
//   R1-3  matcher and path BOUNDS: matcher COUNT, value byte length, untrimmed
//         value, duplicate id, unknown kind, unregistered class name, closed-enum
//         violations, the decidable timeout/script-exit linkage incompatibility,
//         and supplementary-artifact PATH syntax
//   R1-5  `adapterId` absent from `policy.runnerAdapterRegistry`, or a
//         `testCaseRef` the adapter's registered `testCaseRefPattern` does not
//         match (§1.2 argv resolution: "no match → reject (R1-5)") — the
//         envelope-decidable half of R1-5; instantiating `argvTemplate` and
//         comparing it to the observed receipt argv stays with the runner (W2e)
//   R1-6  the target binding is UNREGISTERED or MISMATCHED (adapterId,
//         testCaseRef, or a `targetBindingDigest` that does not recompute over
//         the createdAt-stripped three-field subobject)
//
// R1-2 and R1-3 are NEVER collapsed. A below-threshold literal is a specificity
// failure (R1-2); an invalid path, an unregistered class name, and a matcher
// count violation are bounds failures (R1-3). The ordering that keeps them
// crisp: the bounds layer runs first, and §1.3 is evaluated ONLY over matchers
// that cleared it — so a whitespace or over-length value is reported once, as
// R1-3, instead of also masquerading as a degenerate literal.
//
// WHERE THE §1.3 RULE-1 TRIPLE SPLITS (review B-9ff1 F-005/F-006). Rule 1 has
// three clauses — trimmed, non-empty, not-blocklisted — and they do NOT all
// carry the same tag, because §1.6 assigns tags by ENUMERATION and its two
// enumerations are not symmetric: R1-3's list names "value ... carrying leading
// or trailing whitespace" but says nothing about an EMPTY value, while R1-2's
// list names "a degenerate/blocklisted literal". So `trimmed` -> R1-3 (named
// there), and BOTH `non-empty` and `not-blocklisted` -> R1-2 (a zero-byte
// literal is the most degenerate literal there is). An earlier revision tagged
// the empty value R1-3 by attaching it to the `1 <= len <= maxMatcherLen`
// sentence of §1.1.1; that sentence bounds the length, but the TAG for the
// lower end follows §1.3 rule 1 / §1.6 R1-2, which is where non-emptiness is
// actually legislated.
//
// COUNT AND SPECIFICITY ARE INDEPENDENT (review B-9ff1 F-009). A matcher COUNT
// outside `1..policy.maxMatchers` is one R1-3 finding; it must NOT suppress the
// §1.3 block, or a 9-matcher envelope whose only `present-in-red` evidence is a
// class matcher would report the count bound and silently drop the rule-3
// violation. §1.3 is gated ONLY on there being at least one bounds-clean matcher
// to reason about (the layering above), never on the count being legal.
//
// WHAT THE `value` BOUNDS DO AND DO NOT COVER (review B-9ff1, adjudicated).
// `maxMatcherLen`, the trimmed requirement and the §1.3 floors are `literal-line`
// rules ONLY. §1.1.1 scopes them explicitly ("`value` — for `literal-line`: ...
// Length in bytes MUST satisfy ..."). For `kind: "class"` the PRECEDING bullet
// governs: `value` IS the registry class name and the only test is exact,
// case-sensitive membership in `policy.matcherClassRegistry`, because §1.3 says
// a class matcher's breadth "is bounded by the policy registry itself". Applying
// `maxMatcherLen` to a class name would make a legal registry self-contradictory
// (a registered 600-byte name would be unusable), so it is deliberately not done.
//
// Inconsistencies §1.6 assigns NO tag to (a non-object assertion, a declared
// `policyDigest` that is not the resolved one, a declared `assertionDigest` that
// does not recompute, a missing `acceptanceTargetRef`) are reported as NAMED
// structural `diagnostics` instead. Inventing a §1.6 tag for them would be the
// same mis-tagging error in a different direction.
//
// ARE `policyDigest` / `assertionDigest` REQUIRED HERE? (review B-9ff1,
// adjudicated; the reasoning is recorded so a reviewer can check it, not so a
// reviewer can skip it.) §1.1 numbers them among the four envelope
// fields, and for a STORED v2 record they ARE required: §1.10 embeds both and
// §3.4 makes them idempotency-key components, so a record missing either is
// malformed. THIS function does not validate a stored record. It validates a
// CANDIDATE envelope whose entire purpose is to COMPUTE and report
// `assertionDigest` before a run is spent, and `assertionDigest` covers
// `policyDigest`, which in turn covers a policy the operator resolves from
// config rather than authors. Demanding that the operator pre-supply the two
// values this pre-flight exists to derive is OPERATIONALLY circular — not
// mathematically circular, since `assertionDigest` excludes itself by
// construction (§1.1.4), a distinction the cross-vendor reviewer drew and this
// comment previously blurred — and it would force
// hand-computed digests into candidate files — the exact fabrication surface
// §1.1.4 exists to remove. THE RULE, therefore:
//   - a candidate MAY omit either field (they are then computed / resolved), and
//   - if either IS supplied it MUST equal the computed value, else the envelope
//     is inadmissible with a NAMED diagnostic (`policy-digest-mismatch` /
//     `assertion-digest-mismatch`) rather than a fabricated §1.6 tag.
// Both directions are pinned by committed fixtures: supplied-and-MATCHING is
// admissible, supplied-and-MISMATCHED is not. The requiredness of the fields on
// a stored record is enforced where records are written, not here.
//
// Assurance scope (§0.6 practical tier): this detects fabricated, drifted, or
// under-specified envelopes through the registered surfaces BEFORE a run is
// spent. It does not resist a hostile local agent with filesystem control —
// that adversary is the separate Tier-C program's, not W2's.

import { canonDigest, omitUndefinedDeep } from './canon.js';
import type { RedEvidencePolicySnapshot } from './policy.js';
import { matcherValueSpecificity, valueByteLength, type MatcherValueSpecificity } from './specificity.js';
import {
  strippedBindingIdentity,
  targetBindingDigest,
  type RedTargetBindingIdentity,
} from './target-bindings.js';

/** §1.1.1 the COMPLETE matcher language. There is no pattern kind, by design. */
export const MATCHER_KINDS = ['literal-line', 'class'] as const;
export type MatcherKind = (typeof MATCHER_KINDS)[number];

/** §1.1.1 closed stream enum. */
export const MATCHER_STREAMS = ['stdout', 'stderr', 'combined'] as const;
export type MatcherStream = (typeof MATCHER_STREAMS)[number];

/** §1.1.1 closed polarity enum. */
export const MATCHER_POLARITIES = ['present-in-red', 'absent-in-green', 'present-in-green'] as const;
export type MatcherPolarity = (typeof MATCHER_POLARITIES)[number];

/** §1.1.3 closed supplementary-artifact expectation enum. */
export const ARTIFACT_EXPECTATIONS = ['present', 'absent-in-red-present-in-green', 'absent'] as const;
export type ArtifactExpectation = (typeof ARTIFACT_EXPECTATIONS)[number];

/** §1.1.3 the one supported target-exercised proof method. */
export const TARGET_EXERCISED_PROOF_METHOD = 'harness-token' as const;

/** The §1.6 tags this envelope-only leaf can decide. */
export const REJECTION_TAGS = ['R1-1', 'R1-2', 'R1-3', 'R1-5', 'R1-6'] as const;
export type RedEvidenceRejectionTag = (typeof REJECTION_TAGS)[number];

/** One tagged §1.6 rejection. `code` is stable and DISTINCT per trigger. */
export interface EnvelopeRejection {
  tag: RedEvidenceRejectionTag;
  code: string;
  message: string;
  /** The matcher `id` (or index label) a matcher-scoped rejection came from. */
  matcherRef?: string;
}

/**
 * A named structural problem §1.6 assigns NO rejection tag to. It still makes
 * the envelope inadmissible — the check cannot honestly proceed — but it is
 * reported without a fabricated tag.
 */
export interface EnvelopeDiagnostic {
  code: string;
  message: string;
}

export interface ValidateAssertionEnvelopeArgs {
  /** The candidate `assertion` subobject (§1.1), as parsed from the operator's file. */
  assertion: unknown;
  /** The RESOLVED §1.2 policy snapshot (bounds, floors, registries). */
  policy: RedEvidencePolicySnapshot;
  /** `CANON(policySnapshot)` for the SAME snapshot (§1.1.4). */
  policyDigest: string;
  /**
   * The story's COMMITTED target binding for this `acceptanceTargetRef` (W2b
   * committed-tree reader), or null when the target has none registered.
   * A stored entry carrying `createdAt` is fine — the digest scope strips it.
   */
  committedBinding: (RedTargetBindingIdentity & { createdAt?: string }) | null | undefined;
}

export interface ValidateAssertionEnvelopeResult {
  /** True iff there is neither a §1.6 rejection nor a structural diagnostic. */
  ok: boolean;
  rejections: EnvelopeRejection[];
  diagnostics: EnvelopeDiagnostic[];
  /** The computed §1.1.4 digest — reported ONLY on an admissible envelope. */
  assertionDigest: string | null;
  /** The matched binding reference — reported ONLY on an admissible envelope. */
  binding: RedTargetBindingIdentity | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * §1.1.4 / §0.4: the exact object `assertionDigest` is CANON'd over —
 * the assertion subobject INCLUDING `policyDigest` and EXCLUDING
 * `assertionDigest` itself, with `greenExempt: false` OMITTED (§0.4: an absent
 * optional field and an explicit false are the same value, so they must not fork
 * the digest) and every `undefined` member stripped.
 */
export function canonicalAssertionSubobject(assertion: unknown): Record<string, unknown> {
  if (!isPlainObject(assertion)) {
    throw new Error('red_evidence_envelope: the assertion subobject must be a JSON object');
  }
  const clone: Record<string, unknown> = { ...assertion };
  delete clone.assertionDigest; // a digest can never cover itself
  if (Array.isArray(clone.matchers)) {
    clone.matchers = clone.matchers.map((matcher) => {
      if (!isPlainObject(matcher)) return matcher;
      const copy: Record<string, unknown> = { ...matcher };
      if (copy.greenExempt === false || copy.greenExempt === undefined) delete copy.greenExempt;
      return copy;
    });
  }
  return omitUndefinedDeep(clone) as Record<string, unknown>;
}

/**
 * §1.1.4 `assertionDigest` = CANON over {@link canonicalAssertionSubobject}.
 *
 * Both failure directions are pinned by
 * packages/main/tests/red/red-w2d-assertion-digest-scope.mjs: CANON over the
 * FULL stored object (self field not stripped) and CANON over a subobject with
 * `policyDigest` removed must each DIFFER from this value.
 */
export function computeAssertionDigest(assertion: unknown): string {
  return canonDigest(canonicalAssertionSubobject(assertion));
}

/**
 * A DRIVE-QUALIFIED path prefix (`C:/x`, `c:\x`, and the drive-RELATIVE `C:x`).
 * None of these is repo-relative: they are resolved against a drive root or a
 * per-drive working directory, not against the repository root.
 */
const DRIVE_QUALIFIED_PREFIX = /^[A-Za-z]:/;

/**
 * §1.1.3 SYNTACTIC repo-relative path validation for
 * `supplementaryArtifact.targetArtifactRef`.
 *
 * Syntactic on purpose: `realpath` cannot classify a path that does not exist
 * yet, and "does not exist yet" is exactly the RED case. Component-by-component
 * observation (lstat + symlink-escape classification) happens at RUN time and
 * belongs to the runner leaf.
 *
 * NOT-ABSOLUTE IS A GENERAL TEST, NOT A LEADING-SLASH TEST (review B-9ff1
 * F-010). §1.1.3 requires the ref to be slash-normalized AND RELATIVE, so every
 * non-relative FORM rejects, not just the POSIX one: a leading `/` (also
 * covering the `//server/share` UNC form, whose empty segment rejects as well),
 * a backslash anywhere, and a drive qualifier such as `C:/outside`, `C:\outside`
 * or the drive-relative `C:outside`. Checking only `startsWith('/')` admitted
 * `C:/outside` — slash-normalized, unmistakably absolute, and accepted.
 */
export function classifyArtifactPath(ref: unknown): { ok: boolean; reason: string } {
  if (typeof ref !== 'string') return { ok: false, reason: 'not-a-string' };
  if (ref.length === 0) return { ok: false, reason: 'empty' };
  if (ref.includes('\\')) return { ok: false, reason: 'backslash' };
  if (ref.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (DRIVE_QUALIFIED_PREFIX.test(ref)) return { ok: false, reason: 'drive-qualified' };
  const segments = ref.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: 'empty-segment' };
    if (segment === '.') return { ok: false, reason: 'dot-segment' };
    if (segment === '..') return { ok: false, reason: 'dot-dot-segment' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * §1.1.2 closed `expectedExitClass` enum: `nonzero`, `timeout-is-failure`, or
 * `exit:<n>` with `0 < n <= 255` in canonical (no leading zero) form. `exit:0`
 * is rejected because 0 is the GREEN success code the predicate fixes.
 */
const EXIT_CLASS_EXACT = /^exit:(0|[1-9][0-9]*)$/;

function isValidExpectedExitClass(value: unknown): boolean {
  if (value === 'nonzero' || value === 'timeout-is-failure') return true;
  if (typeof value !== 'string') return false;
  const match = EXIT_CLASS_EXACT.exec(value);
  if (!match) return false;
  const code = Number(match[1]);
  return code > 0 && code <= 255;
}

/** A matcher that cleared the bounds layer and can therefore be reasoned about. */
interface BoundedMatcher {
  ref: string;
  kind: MatcherKind;
  value: string;
  stream: MatcherStream;
  polarity: MatcherPolarity;
  specificity: MatcherValueSpecificity | null;
}

/**
 * Validate a candidate §1.1 assertion envelope against the resolved policy and
 * the story's committed target binding, producing the §1.6-tagged rejection set.
 *
 * Every check runs — nothing short-circuits — so co-occurring faults are ALL
 * reported and no tag suppresses another (§1.6 gives no precedence order, and an
 * operator fixing one fault should not have to re-run to discover the next).
 */
export function validateAssertionEnvelope(args: ValidateAssertionEnvelopeArgs): ValidateAssertionEnvelopeResult {
  const { assertion, policy, policyDigest, committedBinding } = args;
  const rejections: EnvelopeRejection[] = [];
  const diagnostics: EnvelopeDiagnostic[] = [];
  const reject = (tag: RedEvidenceRejectionTag, code: string, message: string, matcherRef?: string): void => {
    rejections.push({ tag, code, message, ...(matcherRef ? { matcherRef } : {}) });
  };
  const diagnose = (code: string, message: string): void => {
    diagnostics.push({ code, message });
  };

  if (!isPlainObject(assertion)) {
    diagnose(
      'assertion-not-an-object',
      'assertion-not-an-object: the envelope file must contain a JSON object holding the §1.1 assertion subobject',
    );
    return { ok: false, rejections, diagnostics, assertionDigest: null, binding: null };
  }

  // ── acceptanceTargetRef (needed to resolve the binding) ────────────────────
  const acceptanceTargetRef = assertion.acceptanceTargetRef;
  if (!isNonBlankString(acceptanceTargetRef)) {
    diagnose(
      'acceptance-target-ref-invalid',
      `acceptance-target-ref-invalid: assertion.acceptanceTargetRef must be a non-blank string, got ${JSON.stringify(acceptanceTargetRef)}`,
    );
  }

  // ── declared policyDigest (§1.1.4: it is INSIDE the assertion digest) ──────
  if (assertion.policyDigest !== undefined && assertion.policyDigest !== policyDigest) {
    diagnose(
      'policy-digest-mismatch',
      `policy-digest-mismatch: the envelope declares policyDigest ${JSON.stringify(assertion.policyDigest)} but the resolved policy digest is ${policyDigest} — the assertion is bound to a different policy`,
    );
  }

  // ── §1.1.1 matcher BOUNDS (R1-3) ──────────────────────────────────────────
  const bounded: BoundedMatcher[] = [];
  let matcherSetEvaluable = false;
  const rawMatchers = assertion.matchers;
  if (!Array.isArray(rawMatchers)) {
    reject('R1-3', 'matchers-not-an-array', `matchers must be an array of 1..${policy.maxMatchers} matcher objects (§1.1.1), got ${JSON.stringify(rawMatchers)}`);
  } else {
    if (rawMatchers.length === 0) {
      reject('R1-3', 'matcher-count-below-minimum', 'matchers is EMPTY: an envelope with 0 matchers asserts nothing and is rejected (§1.6 R1-3 count bound)');
    }
    if (rawMatchers.length > policy.maxMatchers) {
      reject('R1-3', 'matcher-count-above-maximum', `matchers carries ${rawMatchers.length} entries, above policy.maxMatchers=${policy.maxMatchers} (§1.6 R1-3 count bound)`);
    }
    const seenIds = new Set<string>();
    rawMatchers.forEach((rawMatcher, index) => {
      const ref = isPlainObject(rawMatcher) && isNonBlankString(rawMatcher.id) ? rawMatcher.id : `#${index}`;
      let matcherOk = true;
      const fail = (code: string, message: string): void => {
        matcherOk = false;
        reject('R1-3', code, message, ref);
      };

      if (!isPlainObject(rawMatcher)) {
        reject('R1-3', 'matcher-not-an-object', `matcher ${ref} must be an object (§1.1.1)`, ref);
        return;
      }
      const { id, kind, value, stream, polarity, greenExempt } = rawMatcher;

      if (!isNonBlankString(id)) {
        fail('matcher-id-invalid', `matcher ${ref}: id must be a non-blank string, unique within the envelope (§1.1.1)`);
      } else if (seenIds.has(id)) {
        fail('matcher-id-duplicate', `matcher id ${JSON.stringify(id)} is DUPLICATED; matcher ids must be unique within the envelope (§1.6 R1-3)`);
      } else {
        seenIds.add(id);
      }

      const kindOk = typeof kind === 'string' && (MATCHER_KINDS as readonly string[]).includes(kind);
      if (!kindOk) {
        fail(
          'matcher-kind-unknown',
          `matcher ${ref}: kind ${JSON.stringify(kind)} is outside the closed, case-sensitive set ${JSON.stringify(MATCHER_KINDS)} — no pattern language exists in this subsystem (§1.11 rule 1)`,
        );
      }
      const streamOk = typeof stream === 'string' && (MATCHER_STREAMS as readonly string[]).includes(stream);
      if (!streamOk) {
        fail('matcher-stream-unknown', `matcher ${ref}: stream ${JSON.stringify(stream)} is outside the closed, case-sensitive enum ${JSON.stringify(MATCHER_STREAMS)}`);
      }
      const polarityOk = typeof polarity === 'string' && (MATCHER_POLARITIES as readonly string[]).includes(polarity);
      if (!polarityOk) {
        fail('matcher-polarity-unknown', `matcher ${ref}: polarity ${JSON.stringify(polarity)} is outside the closed, case-sensitive enum ${JSON.stringify(MATCHER_POLARITIES)}`);
      }

      // §1.1.1 greenExempt: OPTIONAL boolean, "legal ONLY on
      // `polarity: "present-in-red"` matchers (any other polarity CARRYING IT is
      // rejected)". THE TEST IS PRESENCE, NOT TRUTH (review B-9ff1 F-007): the
      // spec rejects a matcher that CARRIES the field on the wrong polarity, so
      // `greenExempt: false` on an `absent-in-green` matcher is as illegal as
      // `true`. An earlier revision accepted an explicit `false` anywhere,
      // reasoning from §0.4 that a false is OMITTED from the canonical subobject
      // and so cannot change the assertion identity. That reasoning is sound
      // about IDENTITY and irrelevant to LEGALITY: §0.4 governs how a canonical
      // digest is taken, not which fields an envelope may carry, and this clause
      // is a schema rule. Digest behaviour is unchanged — `false` is still
      // stripped by canonicalAssertionSubobject — but an envelope declaring it
      // off-polarity is now rejected instead of silently normalized away.
      if (greenExempt !== undefined) {
        if (typeof greenExempt !== 'boolean') {
          fail('matcher-green-exempt-not-boolean', `matcher ${ref}: greenExempt must be a boolean when present (§1.1.1), got ${JSON.stringify(greenExempt)}`);
        } else if (polarity !== 'present-in-red') {
          fail(
            'matcher-green-exempt-illegal-polarity',
            `matcher ${ref}: greenExempt is legal ONLY on polarity "present-in-red" (§1.1.1) — any other polarity CARRYING the field is rejected, whatever its value; got polarity ${JSON.stringify(polarity)} with greenExempt ${JSON.stringify(greenExempt)}`,
          );
        }
      }

      if (typeof value !== 'string') {
        fail('matcher-value-not-a-string', `matcher ${ref}: value must be a string (§1.1.1), got ${JSON.stringify(value)}`);
      } else if (kind === 'literal-line') {
        // §1.1.1 literal-line value bounds. BYTE length, never code units.
        // The EMPTY value is deliberately NOT decided here: §1.6 R1-3 enumerates
        // only "longer than maxMatcherLen" and "leading/trailing whitespace",
        // while non-emptiness is §1.3 rule 1 and therefore R1-2 (see the header).
        if (value !== value.trim()) {
          fail('matcher-value-untrimmed', `matcher ${ref}: value carries leading/trailing whitespace; literal values are stored TRIMMED (§1.6 R1-3)`);
        }
        const bytes = valueByteLength(value);
        if (bytes > policy.maxMatcherLen) {
          fail('matcher-value-too-long', `matcher ${ref}: value is ${bytes} BYTES (not code units), above policy.maxMatcherLen=${policy.maxMatcherLen} (§1.6 R1-3)`);
        }
      } else if (kind === 'class') {
        // §1.1.1 / §1.2: for kind "class" the value IS the registry class name —
        // the EXACT, case-sensitive `name` key of a matcherClassRegistry entry.
        // A value naming no entry is a BOUNDS failure (R1-3), never a
        // minimum-specificity failure. Class matchers are exempt from §1.3
        // rule 2 because their breadth is bounded by this registry instead.
        const registered = policy.matcherClassRegistry.find((entry) => entry.name === value);
        if (!registered) {
          fail(
            'matcher-class-unregistered',
            `matcher ${ref}: class value ${JSON.stringify(value)} names no policy.matcherClassRegistry entry (exact, case-sensitive); registered names: ${policy.matcherClassRegistry.map((entry) => entry.name).join(', ') || '<none>'} (§1.6 R1-3)`,
          );
        } else if (registered.predicateKind === 'exit-code-in' && stream !== 'combined') {
          // §1.2: an exit-code class consults NO stream, so the matcher must
          // declare "combined"; any other declared stream rejects.
          fail(
            'matcher-class-exit-code-stream',
            `matcher ${ref}: class ${JSON.stringify(value)} is an exit-code-in class, which consults no stream — the matcher stream must be "combined", got ${JSON.stringify(stream)} (§1.2)`,
          );
        }
      }

      if (matcherOk && kindOk && streamOk && polarityOk && typeof value === 'string') {
        bounded.push({
          ref,
          kind: kind as MatcherKind,
          value,
          stream: stream as MatcherStream,
          polarity: polarity as MatcherPolarity,
          specificity: kind === 'literal-line' ? matcherValueSpecificity(value, policy) : null,
        });
      }
    });
    // §1.3 is evaluated over the matchers that CLEARED the bounds layer, and is
    // gated on that alone. It is deliberately NOT gated on the COUNT being legal
    // (review B-9ff1 F-009): a count violation is its own R1-3 finding and must
    // not suppress a co-occurring specificity finding, or an over-count envelope
    // whose only present-in-red evidence is a class matcher would report the
    // count and silently drop the rule-3 violation the operator also has to fix.
    matcherSetEvaluable = bounded.length > 0;
  }

  // ── §1.3 MINIMUM SPECIFICITY (R1-2), over bounds-clean matchers only ──────
  if (matcherSetEvaluable) {
    for (const matcher of bounded) {
      if (matcher.kind !== 'literal-line' || !matcher.specificity) continue;
      const { specificity } = matcher;
      // §1.3 rule 1, non-emptiness clause. R1-2, not R1-3 — see the header note
      // on where the rule-1 triple splits.
      if (!specificity.nonEmpty) {
        reject(
          'R1-2',
          'matcher-value-empty',
          `matcher ${matcher.ref}: value is EMPTY; §1.3 rule 1 requires a literal-line value to be non-empty, and a zero-byte literal asserts nothing (§1.6 R1-2)`,
          matcher.ref,
        );
      }
      if (!specificity.notBlocklisted) {
        reject(
          'R1-2',
          'matcher-value-blocklisted',
          `matcher ${matcher.ref}: value ${JSON.stringify(matcher.value)} is a member of policy.forbiddenCatchAlls, so it is a degenerate literal (§1.3 rule 1)`,
          matcher.ref,
        );
      }
      if (!specificity.rule2) {
        const failed = [
          specificity.lengthFloor ? null : `len=${specificity.byteLength} < minMatcherLen=${policy.minMatcherLen}`,
          specificity.entropyFloor ? null : `entropyBits=${specificity.entropyBits.toFixed(2)} < minMatcherEntropyBits=${policy.minMatcherEntropyBits}`,
        ].filter((part): part is string => part !== null);
        reject(
          'R1-2',
          'matcher-below-specificity-floor',
          `matcher ${matcher.ref}: value ${JSON.stringify(matcher.value)} fails the §1.3 rule 2 CONJUNCTION (length floor AND entropy floor, both inclusive) — ${failed.join('; ')}`,
          matcher.ref,
        );
      }
    }
    // §1.3 rule 3: at least one `present-in-red` matcher MUST be a `literal-line`
    // that passes rules 1-2. This single check covers BOTH vacuous-RED shapes:
    // an envelope with no `present-in-red` matcher at all, and one whose only
    // `present-in-red` evidence is a class matcher (or an inadmissible literal).
    const presentInRed = bounded.filter((matcher) => matcher.polarity === 'present-in-red');
    const admissibleLiterals = presentInRed.filter(
      (matcher) => matcher.kind === 'literal-line' && matcher.specificity?.admissible === true,
    );
    if (admissibleLiterals.length === 0) {
      const presentInRedLiterals = presentInRed.filter((matcher) => matcher.kind === 'literal-line');
      let why: string;
      if (presentInRed.length === 0) {
        why = 'no matcher carries polarity "present-in-red", so the RED assertion is vacuous (§1.1.1 / §1.3 rule 3)';
      } else if (presentInRedLiterals.length === 0) {
        why = `every "present-in-red" matcher is a class matcher (${presentInRed.map((matcher) => matcher.ref).join(', ')}); a class matcher can never be the sole present-in-red evidence (§1.3 rule 3)`;
      } else {
        why = `every "present-in-red" literal-line matcher (${presentInRedLiterals.map((matcher) => matcher.ref).join(', ')}) fails §1.3 rules 1-2, so no matcher of the required kind survives (§1.3 rule 3)`;
      }
      reject('R1-2', 'present-in-red-not-admissible-literal', why);
    }
  }

  // ── §1.1.2 expectedExitClass (R1-3) ───────────────────────────────────────
  const expectedExitClass = assertion.expectedExitClass;
  if (!isValidExpectedExitClass(expectedExitClass)) {
    reject(
      'R1-3',
      'expected-exit-class-unknown',
      `expectedExitClass ${JSON.stringify(expectedExitClass)} is outside the closed, case-sensitive enum: "nonzero", "timeout-is-failure", or "exit:<n>" with 0 < n <= 255 (§1.1.2)`,
    );
  }

  // ── §1.1.3 targetExercisedProof (R1-1) ────────────────────────────────────
  const proof = assertion.targetExercisedProof;
  const proofIsObject = isPlainObject(proof);
  if (proof === undefined || proof === null || !proofIsObject) {
    reject(
      'R1-1',
      'target-exercised-proof-absent',
      `assertion.targetExercisedProof is absent or is not an object (§1.6 R1-1): a RED that cannot prove it exercised the named acceptance target cannot satisfy the gate`,
    );
  }
  let proofAdapterId: string | null = null;
  let proofTestCaseRef: string | null = null;
  let proofBindingDigest: string | null = null;
  if (proofIsObject) {
    const proofObject = proof as Record<string, unknown>;
    if (proofObject.method !== TARGET_EXERCISED_PROOF_METHOD) {
      reject(
        'R1-1',
        'target-exercised-proof-method-unsupported',
        `targetExercisedProof.method ${JSON.stringify(proofObject.method)} is not the one supported method ${JSON.stringify(TARGET_EXERCISED_PROOF_METHOD)} (§1.1.3); artifact-presence-standalone and path-touch were REMOVED`,
      );
    }
    // A proof missing a required identity field is an INCOMPLETE proof, i.e. no
    // target-exercised proof at all (R1-1) — deliberately not a binding
    // MISMATCH (R1-6), which is reserved for a field that is present and differs
    // from the committed binding.
    for (const field of ['adapterId', 'testCaseRef', 'targetBindingDigest'] as const) {
      if (!isNonBlankString(proofObject[field])) {
        reject(
          'R1-1',
          `target-exercised-proof-${field.toLowerCase()}-absent`,
          `targetExercisedProof.${field} is absent or blank, so the proof is incomplete (§1.6 R1-1)`,
        );
      }
    }
    proofAdapterId = isNonBlankString(proofObject.adapterId) ? proofObject.adapterId : null;
    proofTestCaseRef = isNonBlankString(proofObject.testCaseRef) ? proofObject.testCaseRef : null;
    proofBindingDigest = isNonBlankString(proofObject.targetBindingDigest) ? proofObject.targetBindingDigest : null;

    // §1.1.3 supplementaryArtifact (optional, never standalone) — PATH SYNTAX is
    // R1-3, explicitly a BOUNDS tag and never a specificity one.
    const supplementary = proofObject.supplementaryArtifact;
    if (supplementary === null) {
      // §0.4: "every OTHER optional field is OMITTED entirely when absent —
      // never written as `null` or `""`". An explicit null is therefore a
      // MALFORMED envelope, not an omission, and treating it as absent (as an
      // earlier revision did) let a malformed envelope through as admissible
      // (review B-9ff1 F-011). The tag is R1-3, the same bounds tag every other
      // structural defect of this subobject carries.
      reject(
        'R1-3',
        'supplementary-artifact-null',
        'targetExercisedProof.supplementaryArtifact is explicitly null; §0.4 requires an absent optional field to be OMITTED entirely and never written as null or "" — an explicit null is a malformed envelope, not an omission (§1.6 R1-3)',
      );
    } else if (supplementary !== undefined) {
      if (!isPlainObject(supplementary)) {
        reject('R1-3', 'supplementary-artifact-not-an-object', `supplementaryArtifact must be an object with targetArtifactRef + expectation (§1.1.3), got ${JSON.stringify(supplementary)}`);
      } else {
        const pathVerdict = classifyArtifactPath(supplementary.targetArtifactRef);
        if (!pathVerdict.ok) {
          reject(
            'R1-3',
            'supplementary-artifact-path-invalid',
            `supplementaryArtifact.targetArtifactRef ${JSON.stringify(supplementary.targetArtifactRef)} is not a valid slash-normalized repo-relative path (${pathVerdict.reason}); absolute paths and empty / "." / ".." segments and backslashes reject at schema time (§1.6 R1-3)`,
          );
        }
        if (typeof supplementary.expectation !== 'string' || !(ARTIFACT_EXPECTATIONS as readonly string[]).includes(supplementary.expectation)) {
          reject(
            'R1-3',
            'supplementary-artifact-expectation-unknown',
            `supplementaryArtifact.expectation ${JSON.stringify(supplementary.expectation)} is outside the closed enum ${JSON.stringify(ARTIFACT_EXPECTATIONS)} (§1.1.3)`,
          );
        }
      }
    }
  }

  // ── §1.2 adapter resolution: registry membership (R1-5) + the decidable ────
  //    timeout/script-exit linkage incompatibility (R1-3, §1.1.2)
  if (proofAdapterId !== null) {
    const adapter = policy.runnerAdapterRegistry.find((entry) => entry.adapterId === proofAdapterId);
    if (!adapter) {
      reject(
        'R1-5',
        'adapter-unregistered',
        `targetExercisedProof.adapterId ${JSON.stringify(proofAdapterId)} is absent from policy.runnerAdapterRegistry (§1.6 R1-5); registered adapters: ${policy.runnerAdapterRegistry.map((entry) => entry.adapterId).join(', ') || '<none>'}`,
      );
    } else {
      if (expectedExitClass === 'timeout-is-failure' && adapter.linkageKind === 'script-exit') {
        reject(
          'R1-3',
          'timeout-with-script-exit-linkage',
          `expectedExitClass "timeout-is-failure" is legal ONLY with a reporter-event adapter: a timed-out script never runs to completion, so script-exit linkage is unobtainable. Adapter ${JSON.stringify(proofAdapterId)} declares linkageKind "script-exit" — REJECTED at schema time, before a run is spent (§1.1.2, R1-3)`,
        );
      }
      // §1.2 argv resolution, step 1: "match `testCaseRef` against
      // `testCaseRefPattern`; no match → reject (R1-5)". This half IS
      // envelope-decidable — the pattern is registry material in the resolved
      // policy and the ref is in the envelope — so it is decided here, beside the
      // registry-membership check, instead of costing a run. Only the SECOND half
      // of R1-5 (instantiating argvTemplate and comparing it with the observed
      // receipt argv) needs a run and stays with the runner (W2e). Without this,
      // a free-form testCaseRef that no template can ever resolve was admitted.
      if (proofTestCaseRef !== null) {
        // The policy resolver already fails closed on a pattern that does not
        // compile or is unanchored (§1.2), so a live compile error here can only
        // mean the caller passed an unresolved snapshot: treat it as NO MATCH
        // (fail closed) rather than letting an exception escape the validator.
        let matchesPattern = false;
        try {
          matchesPattern = new RegExp(adapter.testCaseRefPattern, 'u').test(proofTestCaseRef);
        } catch {
          matchesPattern = false;
        }
        if (!matchesPattern) {
          reject(
            'R1-5',
            'test-case-ref-pattern-mismatch',
            `targetExercisedProof.testCaseRef ${JSON.stringify(proofTestCaseRef)} does not match the registered testCaseRefPattern ${JSON.stringify(adapter.testCaseRefPattern)} of adapter ${JSON.stringify(proofAdapterId)}, so no argv can be derived from its template (§1.2 argv resolution, §1.6 R1-5)`,
          );
        }
      }
    }
  }

  // ── §1.1.3 committed target binding (R1-6) ────────────────────────────────
  let matchedBinding: RedTargetBindingIdentity | null = null;
  if (proofIsObject && isNonBlankString(acceptanceTargetRef)) {
    if (!committedBinding) {
      reject(
        'R1-6',
        'target-binding-unregistered',
        `no committed target binding is registered for acceptanceTargetRef ${JSON.stringify(acceptanceTargetRef)} (§1.6 R1-6): register it with red_evidence_binding_set and COMMIT it — the binding that authorizes a run is always part of the committed, reviewable tree`,
      );
    } else {
      const identity = strippedBindingIdentity(committedBinding);
      if (identity.acceptanceTargetRef !== acceptanceTargetRef) {
        reject(
          'R1-6',
          'target-binding-target-mismatch',
          `the committed binding is registered for ${JSON.stringify(identity.acceptanceTargetRef)}, not for the assertion's acceptanceTargetRef ${JSON.stringify(acceptanceTargetRef)} (§1.6 R1-6)`,
        );
      }
      if (proofAdapterId !== null && proofAdapterId !== identity.adapterId) {
        reject(
          'R1-6',
          'target-binding-adapter-mismatch',
          `targetExercisedProof.adapterId ${JSON.stringify(proofAdapterId)} does not equal the committed binding's adapterId ${JSON.stringify(identity.adapterId)} (§1.6 R1-6)`,
        );
      }
      if (proofTestCaseRef !== null && proofTestCaseRef !== identity.testCaseRef) {
        reject(
          'R1-6',
          'target-binding-test-case-mismatch',
          `targetExercisedProof.testCaseRef ${JSON.stringify(proofTestCaseRef)} does not equal the committed binding's testCaseRef ${JSON.stringify(identity.testCaseRef)} — the binding EXISTS but names a different test case, so this is a MISMATCH (R1-6), not a missing proof (R1-1)`,
        );
      }
      if (proofBindingDigest !== null) {
        // THE DIGEST-SCOPE TRAP: the digest covers the createdAt-STRIPPED
        // three-field identity subobject ONLY (allowlist, not blocklist), so a
        // digest computed over the STORED entry does not recompute here.
        const expected = targetBindingDigest(identity);
        if (proofBindingDigest !== expected) {
          reject(
            'R1-6',
            'target-binding-digest-mismatch',
            `targetExercisedProof.targetBindingDigest ${proofBindingDigest} does not recompute over the committed binding: CANON of the createdAt-stripped {acceptanceTargetRef, adapterId, testCaseRef} subobject is ${expected} (§1.1.3, R1-6)`,
          );
        }
      }
      matchedBinding = identity;
    }
  }

  // ── §1.1.4 assertionDigest (computed; a declared one must recompute) ───────
  let computedDigest: string | null = null;
  try {
    computedDigest = computeAssertionDigest({ ...assertion, policyDigest });
  } catch (error) {
    diagnose('assertion-not-canonicalizable', `assertion-not-canonicalizable: ${(error as Error).message}`);
  }
  if (computedDigest !== null && assertion.assertionDigest !== undefined && assertion.assertionDigest !== computedDigest) {
    diagnose(
      'assertion-digest-mismatch',
      `assertion-digest-mismatch: the envelope declares assertionDigest ${JSON.stringify(assertion.assertionDigest)} but CANON over the assertion subobject (policyDigest INCLUDED, assertionDigest EXCLUDED) is ${computedDigest} (§1.1.4)`,
    );
  }

  const ok = rejections.length === 0 && diagnostics.length === 0;
  return {
    ok,
    rejections,
    diagnostics,
    // Success output is reported ONLY for a genuinely admissible envelope.
    assertionDigest: ok ? computedDigest : null,
    binding: ok ? matchedBinding : null,
  };
}
