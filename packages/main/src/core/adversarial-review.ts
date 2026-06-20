/**
 * adversarial-review — FROZEN CONTRACT for the adversarial multi-lens review mode.
 *
 * Source of truth: docs/adversarial-review-spec.md §2 (methodology + data shapes),
 * §3 (convergence + loop semantics), and §5 S0 (frozen contract, SERIAL, first).
 *
 * This module is the single source-of-truth for the methodology TYPES, const data,
 * and the review-mode interface that every later story (S1–S4) imports:
 *   - Finding schema                     → §2.2
 *   - Verdict schema                     → §2.3
 *   - canonical lens set + task-tunable  → §2.1
 *   - completeness-critic IO contract    → §2.4
 *   - the ONE canonical round order      → §2.4 / §3.2 / §4.2 (single declared source)
 *
 * NO behavior lives here — types, interfaces, and const data ONLY. The lens runner
 * (S1), adversarial verifier (S2), completeness critic (S3), and escalation-flow
 * integration (S4) fill the surface this module declares. The abstract methodology
 * severities (BLOCKER/MAJOR/MINOR) are NOT the finding_add ledger enum
 * (critical|high|medium|low) — that mapping is S2's job (§4.2) and is deliberately
 * kept OUT of this contract.
 */

// ── §2.2 FINDING (frozen) ─────────────────────────────────────────────────────

/**
 * Abstract methodology severity (§2.2). NOT the finding_add ledger enum
 * (critical|high|medium|low) — the BLOCKER/MAJOR/MINOR → critical/high/medium
 * mapping is S2's concern (§4.2), not S0's.
 */
export const FINDING_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const;
export type FindingSeverity = typeof FINDING_SEVERITIES[number];

/**
 * A raw/unverified review finding (§2.2). A lens returns PASS (zero findings) or
 * one-or-more `Finding`s; at this stage a finding is a *claim*, not yet a defect.
 */
export interface Finding {
  severity: FindingSeverity;
  title: string; // one-line summary
  file: string; // path
  line: number; // anchor (best-effort; symbols are more stable)
  issue: string; // what is wrong + why it matters
  fix: string; // concrete remediation
}

// ── §2.3 VERDICT (frozen) ─────────────────────────────────────────────────────

/**
 * The agreed severity a skeptic returns (§2.3) — the §2.2 set plus NOT_A_DEFECT
 * (the refute-by-default outcome).
 */
export const AGREED_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR', 'NOT_A_DEFECT'] as const;
export type AgreedSeverity = typeof AGREED_SEVERITIES[number];

/**
 * A skeptic's per-finding verdict (§2.3). Refute-by-default: `isReal` defaults to
 * false and only flips true on a concrete confirmation against the code; `reasoning`
 * must cite the concrete code that confirms/refutes.
 */
export interface Verdict {
  isReal: boolean;
  agreedSeverity: AgreedSeverity;
  reasoning: string; // must cite the concrete code that confirms/refutes
}

// ── §2.1 CANONICAL LENS SET (task-tunable) ────────────────────────────────────

/**
 * The canonical lens ids (§2.1). Each id corresponds to one facet a lens reviews.
 * (Spec §2.1 displays the names as `concept/scope`, `behavior/correctness`,
 * `crash-safety/edge`; the stable ids hyphenate those.)
 */
export const LENS_IDS = [
  'concept-scope',
  'code-quality',
  'behavior-correctness',
  'test-coverage',
  'crash-safety-edge',
  'docs-consistency',
] as const;
export type LensId = typeof LENS_IDS[number];

/** One lens definition (§2.1): the facet it reviews and what it asks. */
export interface LensDef {
  id: LensId;
  facet: string;
  asks: string;
}

/**
 * Canonical lens set (spec §2.1). TASK-TUNABLE: a change may subset/extend this set;
 * the completeness critic (§2.4) is always present regardless.
 *
 * facet + asks text is verbatim from the §2.1 table.
 */
export const CANONICAL_LENS_SET: readonly LensDef[] = [
  {
    id: 'concept-scope',
    facet: 'intent ↔ implementation',
    asks: 'does the code do what the story claims, within scope?',
  },
  {
    id: 'code-quality',
    facet: 'correctness of *this* code',
    asks: 'null/throw/type/comparator/refactor-equivalence',
  },
  {
    id: 'behavior-correctness',
    facet: 'runtime semantics',
    asks: 'does the changed path behave per contract on real inputs?',
  },
  {
    id: 'test-coverage',
    facet: 'does the test reach the risk?',
    asks: 'do assertions exercise the actual sink, not a proxy?',
  },
  {
    id: 'crash-safety-edge',
    facet: 'failure modes',
    asks: 'corrupt input, missing file, boundary, fail-open vs fail-closed',
  },
  {
    id: 'docs-consistency',
    facet: 'claims ↔ reality',
    asks: 'registries/metadata/docs match the runtime',
  },
] as const;

// ── §2.4 COMPLETENESS-CRITIC IO (frozen — TYPE only) ──────────────────────────

/**
 * The completeness critic's input (§2.4): the change diff + the CONFIRMED lens
 * findings (post §2.3). The critic never sees the raw/unverified set.
 */
export interface CompletenessCriticInput {
  change: string;
  confirmedFindings: Finding[];
}

/**
 * Shape of the completeness critic's contract (§2.4): {change, confirmedFindings}
 * in, new raw `Finding[]` out (which re-enter §2.3 verification). TYPE only — no impl.
 */
export interface CompletenessCriticIO {
  input: CompletenessCriticInput;
  output: Finding[];
}

// ── §2.4 / §3.2 / §4.2 CANONICAL ROUND ORDER (single declared source of truth) ─

/**
 * The ONE canonical round order (§2.4, §3.2 and §4.2 all agree): run lenses →
 * adversarially verify lens raw findings → run the critic on the CONFIRMED set →
 * adversarially verify critic raw findings → converge or reopen. This ordered tuple
 * is the single declared source of truth; S1–S4 must not drift from it.
 */
export const REVIEW_MODE_PHASES = [
  'lenses',
  'verify-lens-findings',
  'critic',
  'verify-critic-findings',
  'converge-or-reopen',
] as const;
export type ReviewModePhase = typeof REVIEW_MODE_PHASES[number];

/**
 * The result of one adversarial-review round (§3.1/§3.2). Behavior is S1–S4; this
 * is the surface they fill.
 */
export interface RoundResult {
  lensFindings: Finding[]; // raw findings from the lenses (pre-verification)
  confirmedFindings: Finding[]; // lens findings that passed §2.3 verification
  criticFindings: Finding[]; // confirmed completeness-critic findings (§2.4)
  reopen: boolean; // a confirmed critic finding reopened the round (§3.2)
  converged: boolean; // all lenses PASS + all findings refuted-or-fixed + critic found nothing new (§3.1)
}

/**
 * The review-mode interface S4 wires to: a round runs the phases in
 * REVIEW_MODE_PHASES order.
 */
export interface ReviewModeRound {
  readonly phases: typeof REVIEW_MODE_PHASES;
}
