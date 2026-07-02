## Trigger Event
During the Codex host-2 review of story B-047f (experience-ablation S1 tooling), the reviewer proved that the freeze rule written in the execution plan — freeze the powered N computed at the LOWER bound of the pilot Wilson 95% CI, labeled conservative — is mathematically not conservative under the pooled two-proportion sample-size formula.

## Key Insights
n(baseline, mde) peaks where the pooled mean (baseline - mde/2) is nearest 0.5. Therefore a Wilson lower bound below 0.5 + mde/2 yields a SMALLER n than the observed baseline. Concrete counterexample: pilot 36/60 defects gives Wilson lower bound 0.47366 -> 56/arm, while the observed 0.60 baseline needs 62/arm at mde 0.25. The merged S1 tooling (experiments/experience-ablation/sample-size.mjs pilotFreezeCheck) already implements the corrected rule: freeze at the N-maximizing baseline within the Wilson 95% CI, with analytic maximizer p* = 0.5 + mde/2 clamped to the CI. Only the prose in the decision doc lags behind the code.

## Solution Tradeoffs
Option A: amend only the S7 freeze-rule paragraph — cheapest, but leaves the S13 M6 exit-criteria row and the S17 step 2 echo contradicting S7. Option B (chosen): amend all three passages (S7 paragraph, S13 M6 row, S17 step 2 echo) to the corrected N-maximizing wording, keeping every other sentence of the doc byte-identical. Option C: also rewrite surrounding statistics prose — rejected as scope creep; the tooling is already correct and the plan asks only for wording alignment.

## Conversational Texture
User request (2026-07-02): author a small docs-only Lattice story that amends the plan wording to — freeze the powered N at the N-maximizing baseline within the Wilson 95% CI of the pilot rate (equivalently max over the CI; the lower bound alone is not conservative). Keep everything else unchanged; the doc must stay entirely English.
