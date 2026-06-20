/**
 * adversarial-review-critic — S3 of the adversarial-review program
 * (docs/adversarial-review-spec.md §2.4 + §4.3).
 *
 * The completeness critic is a DISTINGUISHED lens that does not ask "is this
 * code correct?" but rather "what did the review MISS?". In the S4 orchestration
 * it runs AFTER lens-finding verification, so its `confirmedFindings` input is
 * the VERIFIED set (post §2.3) — never the raw/unverified lens output. The
 * critic itself is supplied at MVP as an injected seam (`runCritic`): the real
 * critic agent is wired by the harness/main agent in S4, and this module only
 * forwards to it.
 *
 * The critic's output is RAW + UNPRIVILEGED: each finding it returns is a fresh
 * claim that must RE-ENTER §2.3 adversarial verification before it can become a
 * defect. That re-verification loop (and the reopen/escalation/finding_add
 * calls) is S4 — NONE of it lives here. This module performs NO I/O: pure
 * pass-through composition over S0 types + the S2 arg shaper, all imported
 * read-only.
 *
 * WHY the `[completeness-critic]` provenance goes in `--desc` and `--agent`
 * stays a REAL review lane: a finding / review pass only counts as reviewer
 * evidence when its agent satisfies `agent.startsWith('lattice-review-')`
 * (review-run.ts `isReviewerAgent`). There is NO `lattice-review-completeness`
 * lane today (§4.3), so putting `completeness-critic` in `--agent` would store
 * the finding as NON-reviewer provenance and the REVIEW→TEST gate would not
 * count it as lane evidence. Instead the critic's provenance is carried as a
 * `[completeness-critic]` prefix in `--desc`, while `--agent` is one of the
 * §4.3 recommended REAL lanes — so the finding both counts as reviewer evidence
 * AND remains attributable to the critic.
 */

import { type CompletenessCriticInput, type Finding } from './adversarial-review.js';
import { toFindingAddArgs, type FindingAddArgs } from './adversarial-review-verifier.js';
import { type ReviewRunLane } from './review-run.js';

/**
 * Run the completeness critic (§2.4). The critic sees ONLY
 * `{change, confirmedFindings}` (the VERIFIED set), and its output is returned
 * UNCHANGED — raw + unprivileged, because it re-enters §2.3 verification in S4.
 * Pure pass-through: no I/O, no reshaping, no filtering.
 */
export function runCompletenessCritic(
  input: CompletenessCriticInput,
  runCritic: (input: CompletenessCriticInput) => Finding[],
): Finding[] {
  return runCritic(input);
}

/**
 * Convenience wrapper: assemble the §2.4 `{change, confirmedFindings}` input and
 * forward to {@link runCompletenessCritic}.
 */
export function runCompletenessCriticOn(
  change: string,
  confirmedFindings: Finding[],
  runCritic: (input: CompletenessCriticInput) => Finding[],
): Finding[] {
  return runCompletenessCritic({ change, confirmedFindings }, runCritic);
}

/**
 * Provenance prefix carried in `--desc` (NOT `--agent`) for completeness-critic
 * findings. See the file header for WHY this lives in desc.
 */
export const COMPLETENESS_CRITIC_DESC_TAG = '[completeness-critic]';

/**
 * The §4.3 recommended REAL reviewer lanes for critic findings. Both are members
 * of `REVIEW_RUN_LANES`, so a critic finding recorded under either still counts
 * as lane evidence.
 */
export const CRITIC_PROVENANCE_RECOMMENDED_LANES = ['lattice-review-quality', 'lattice-review-behavior'] as const;

/**
 * Shape (do NOT emit) the finding_add args for a completeness-critic finding.
 * Computes the S2 base args via {@link toFindingAddArgs} and prefixes the desc
 * with the `[completeness-critic]` provenance tag + a space. The severity stays
 * the S2-mapped ledger kind (critical|high|medium|low) — S2 owns the
 * BLOCKER/MAJOR/MINOR mapping, so an abstract severity can never leak here.
 *
 * `agent` is typed `ReviewRunLane` so the compiler STRUCTURALLY rejects
 * `'completeness-critic'`: only a REAL review lane is accepted (§4.3). PURE — it
 * performs NO finding_add call (that is S4).
 */
export function toCriticFindingAddArgs(
  finding: Finding,
  opts: { reviewRunId: string; agent: ReviewRunLane; category: FindingAddArgs['category'] },
): FindingAddArgs {
  const base = toFindingAddArgs(finding, opts);
  return { ...base, desc: COMPLETENESS_CRITIC_DESC_TAG + ' ' + base.desc };
}
