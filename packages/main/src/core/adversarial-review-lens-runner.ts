/**
 * adversarial-review-lens-runner — S1 of the adversarial-review program.
 *
 * Source of truth: docs/adversarial-review-spec.md §4.2 (lens → review_run lane
 * mapping) and §5 S1 (the lens runner). This module is PURE DATA + an injected
 * `runLens` seam: it plans one isolated request per lens, runs each lens through
 * the caller-supplied executor, and aggregates the raw findings. NO behavior
 * beyond plan/run/aggregate lives here — verification + the BLOCKER/MAJOR/MINOR →
 * finding_add severity mapping (S2), the completeness critic (S3), and escalation
 * wiring (S4) all build on this surface and are deliberately OUT of scope.
 *
 * The real review agent is NOT implemented here. At MVP the harness / main agent
 * supplies `runLens`; S4 wires in the production reviewer. Keeping the executor
 * injected is what makes this module hermetically testable.
 *
 * INDEPENDENCE IS LOAD-BEARING. Each lens reviews the change in isolation: the
 * request a lens receives (`LensRunRequest`) carries ONLY {lensId, lane, change}
 * and STRUCTURALLY cannot carry another lens's findings. `runLens` is invoked once
 * per request with that single request and nothing else, so no lens can be biased
 * by, or have its output mis-attributed to, a sibling lens. The two lenses that map
 * to the same lane (behavior/correctness and crash-safety/edge → proof-or-stop-
 * review-behavior) still run + report distinctly; their findings are never merged or
 * de-duplicated.
 *
 * The lane type is ALIASED to review-run.ts's `ReviewRunLane` (the six real
 * review_run_start lanes), so the §4.2 mapping is type-checked against the single
 * source of truth and can never drift to a non-real lane.
 */

import {
  type LensId,
  type LensDef,
  type Finding,
  CANONICAL_LENS_SET,
} from './adversarial-review.js';
import { type ReviewRunLane } from './review-run.js';

/**
 * The lane a lens reports into IS one of the six real review_run_start lanes
 * (single source of truth; NOT a parallel string-literal enum). Aliasing to
 * ReviewRunLane makes the compiler reject any mapping value that is not a real
 * lane.
 */
export type LensLane = ReviewRunLane;

/**
 * §4.2 lens → review_run lane mapping. Fully typed `Record<LensId, LensLane>` so
 * the compiler rejects any non-real lane. behavior/correctness and
 * crash-safety/edge intentionally map to the SAME lane (proof-or-stop-review-behavior);
 * there is no mapping to proof-or-stop-review-channel. The values must be a SUBSET of
 * REVIEW_RUN_LANES, not a bijection.
 */
export const LENS_TO_LANE: Record<LensId, LensLane> = {
  'concept/scope': 'proof-or-stop-review-concept',
  'code-quality': 'proof-or-stop-review-quality',
  'behavior/correctness': 'proof-or-stop-review-behavior',
  'test-coverage': 'proof-or-stop-review-test-coverage',
  'crash-safety/edge': 'proof-or-stop-review-behavior',
  'docs-consistency': 'proof-or-stop-review-docs',
};

/**
 * The ISOLATED input ONE lens receives. STRUCTURALLY independent: there is no
 * `findings` field nor any field that could carry another lens's output. A lens
 * sees only its own id, the lane it reports into, and the change under review.
 */
export interface LensRunRequest {
  lensId: LensId;
  lane: LensLane;
  change: string;
}

/**
 * Plan one INDEPENDENT request per UNIQUE lens (a lens set is a set — a duplicated
 * lens id yields a single request; first occurrence wins, order preserved). Each
 * request is a fresh object literal {lensId, lane, change} — no shared mutable
 * reference, and no other lens's data is ever threaded in. No side effects.
 */
export function buildLensRunPlan(
  change: string,
  lensSet: readonly LensDef[] = CANONICAL_LENS_SET,
): LensRunRequest[] {
  const seen = new Set<LensId>();
  const requests: LensRunRequest[] = [];
  for (const lens of lensSet) {
    if (seen.has(lens.id)) continue;
    seen.add(lens.id);
    requests.push({ lensId: lens.id, lane: LENS_TO_LANE[lens.id], change });
  }
  return requests;
}

/**
 * One lens's result: its id, the lane it reported into, and its raw findings.
 * `findings: []` means that lens PASSED.
 */
export interface LensRunResult {
  lensId: LensId;
  lane: LensLane;
  findings: Finding[];
}

/**
 * Run every lens in `lensSet` against `change` through the INJECTED `runLens`
 * executor. For each planned request, `runLens` is invoked EXACTLY ONCE with ONLY
 * that single request (never another lens's result/findings), and its return is
 * captured as that lens's findings. Both lensId AND lane are preserved on every
 * result, so the two behavior-mapped lenses stay distinct.
 */
export function runLenses(
  change: string,
  lensSet: readonly LensDef[],
  runLens: (req: LensRunRequest) => Finding[],
): LensRunResult[] {
  const plan = buildLensRunPlan(change, lensSet);
  return plan.map((req) => {
    const findings = runLens(req);
    return { lensId: req.lensId, lane: req.lane, findings };
  });
}

/**
 * Flatten all lens results' findings into a single Finding[] preserving order,
 * with NO de-duplication — findings from the two behavior-mapped lenses must both
 * survive distinctly.
 */
export function collectRawFindings(results: LensRunResult[]): Finding[] {
  return results.flatMap((r) => r.findings);
}
