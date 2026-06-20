/**
 * adversarial-review-verifier — S2 of the adversarial-review program
 * (docs/adversarial-review-spec.md §2.3 + §4.2).
 *
 * Pure data + an INJECTED `runSkeptic` seam: the real skeptic agent is supplied
 * by the harness/main agent at MVP and wired in S4. This module performs NO I/O.
 *
 * Refute-by-default lives in the SKEPTIC role, not here. This module only counts
 * strict `isReal === true` verdicts and applies a threshold-confirm T (default
 * 1-of-2, NOT majority): a finding is confirmed once at least T skeptics confirm
 * it. Everything else is dropped.
 *
 * The §4.2 ledger map exists so an abstract methodology severity
 * (BLOCKER/MAJOR/MINOR) NEVER reaches finding_add (which would be a Zod error):
 * every emitted finding_add severity comes from SEVERITY_TO_FINDING_KIND. Calling
 * finding_add / review_run_start is OUT of scope (S4) — `toFindingAddArgs` only
 * SHAPES the args; it never performs the call.
 */

import { type Finding, type FindingSeverity, type Verdict } from './adversarial-review.js';

// ── §4.2 LEDGER MAP ───────────────────────────────────────────────────────────

/** The finding_add severity enum (the real ledger kinds). */
export type FindingAddSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * The §4.2 ledger map: abstract methodology severity → finding_add ledger kind.
 * Typed as `Record<FindingSeverity, FindingAddSeverity>` so the compiler forces a
 * mapping for EVERY abstract severity and rejects any non-FindingSeverity key.
 * `low` is reserved for cosmetic MINOR; the default map sends MINOR → medium.
 */
export const SEVERITY_TO_FINDING_KIND: Record<FindingSeverity, FindingAddSeverity> = {
  BLOCKER: 'critical',
  MAJOR: 'high',
  MINOR: 'medium',
};

/**
 * Compose the finding_add `desc` from a finding (§4.2 compose form:
 * `<title> — <issue> Fix: <fix>` with the line cited). The separator between
 * title and issue is the em dash " — " (U+2014, space-emdash-space).
 */
export function composeDesc(finding: Finding): string {
  return `${finding.title} — ${finding.issue} Fix: ${finding.fix} (line ${finding.line})`;
}

/** The shaped args for a single finding_add call (the call itself is S4). */
export interface FindingAddArgs {
  severity: FindingAddSeverity;
  desc: string;
  files: string[];
  category: 'happy' | 'edge' | 'adversarial' | 'missing';
  reviewRunId: string;
  agent: string;
}

/**
 * Shape (do NOT emit) the finding_add args for a finding. PURE: performs NO
 * finding_add call. The severity ALWAYS comes from SEVERITY_TO_FINDING_KIND, so
 * an abstract BLOCKER/MAJOR/MINOR can never leak into the ledger. `agent` is
 * caller-supplied (a real lattice-review-* lane); this function never invents it.
 */
export function toFindingAddArgs(
  finding: Finding,
  opts: { reviewRunId: string; agent: string; category: FindingAddArgs['category'] },
): FindingAddArgs {
  return {
    severity: SEVERITY_TO_FINDING_KIND[finding.severity],
    desc: composeDesc(finding),
    files: [finding.file],
    category: opts.category,
    reviewRunId: opts.reviewRunId,
    agent: opts.agent,
  };
}

// ── §2.3 PER-FINDING ADVERSARIAL VERIFICATION ─────────────────────────────────

/** Default number of skeptics run per finding (M). */
export const DEFAULT_SKEPTICS = 2;
/** Default confirm threshold (T): 1-of-M confirmations confirm the finding. */
export const DEFAULT_CONFIRM_THRESHOLD = 1;

/** One finding after adversarial verification. */
export interface VerifiedFinding {
  finding: Finding;
  verdicts: Verdict[];
  confirms: number;
  confirmed: boolean;
}

/**
 * Adversarially verify ONE finding: call `runSkeptic(finding, change)` exactly M
 * times (M = opts.skeptics ?? DEFAULT_SKEPTICS), collect the verdicts, count
 * STRICT `isReal === true` confirmations (refute-by-default: undefined/false/
 * anything-not-true does NOT count), and confirm when `confirms >= T`
 * (T = opts.threshold ?? DEFAULT_CONFIRM_THRESHOLD) — threshold-confirm, NOT
 * majority. A confirms=0 finding is `confirmed=false`.
 */
export function verifyFinding(
  finding: Finding,
  change: string,
  runSkeptic: (finding: Finding, change: string) => Verdict,
  opts?: { skeptics?: number; threshold?: number },
): VerifiedFinding {
  const skeptics = opts?.skeptics ?? DEFAULT_SKEPTICS;
  const threshold = opts?.threshold ?? DEFAULT_CONFIRM_THRESHOLD;
  const verdicts: Verdict[] = [];
  for (let i = 0; i < skeptics; i++) {
    verdicts.push(runSkeptic(finding, change));
  }
  const confirms = verdicts.filter((v) => v.isReal === true).length;
  const confirmed = confirms >= threshold;
  return { finding, verdicts, confirms, confirmed };
}

/**
 * Adversarially verify a LIST of findings — each finding judged INDEPENDENTLY
 * with its own M skeptic runs.
 */
export function verifyFindings(
  findings: Finding[],
  change: string,
  runSkeptic: (finding: Finding, change: string) => Verdict,
  opts?: { skeptics?: number; threshold?: number },
): VerifiedFinding[] {
  return findings.map((f) => verifyFinding(f, change, runSkeptic, opts));
}

/** Project the confirmed findings out of a verified set (drops the refuted). */
export function confirmedFindings(verified: VerifiedFinding[]): Finding[] {
  return verified.filter((v) => v.confirmed).map((v) => v.finding);
}
