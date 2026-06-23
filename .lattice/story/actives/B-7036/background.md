## Trigger Event
The powered-ablation program (pre-reg docs/requirements/decisions/lattice-experiment-protocol.md rev3.1) reached infra-(a) piece 5 on 2026-06-23 after B-f248 (run driver, lattice 0.3.77) merged. Sections 5 and 8 specify a GLMM plus common-cell denominators plus a single FDR, but no script computes them from the section-7 JSONL the driver emits.

## Key Insights
The pre-reg is the authority: section 4.1 completion (section-5 null cells) plus section 4.2 not-amplified/recovered/safe-stop (section-6 scenarios) are the outcomes; section 5 mandates per-hypothesis common-cell denominators (rates ONLY over cells applicable to BOTH arms in a comparison) plus a GLMM (arm fixed; task/scenario/seed random) plus ONE Benjamini-Hochberg FDR with per-scenario tests EXPLORATORY only; section 7 the validity filter (void becomes re-run not dropped, task-failures kept, N/A excluded and logged); section 8 the cost co-metric plus denominator-bias mitigation. A pure-JS GLMM is unreliable, so the script computes the verifiable parts in Node (rates, Wilson CIs, a seeded cluster bootstrap for the A4-vs-A2prime contrast that respects within-cell clustering, BH-FDR) AND emits a ready-to-run glmm.R for the formal model -- honest about what Node verifies vs what R runs.

## Solution Tradeoffs
Keep all analysis pure and offline-testable with synthetic section-7 fixtures of known rates/contrasts. Reuse the driver contrast definitions (the 4 section-5 contrasts plus applicability) rather than re-deriving denominators, so the analysis denominators match what the driver stamped. Do NOT run the live campaign or invent data; the script operates only on recorded JSONL. The cluster bootstrap (seeded, deterministic) is the in-Node primary contrast; the GLMM is emitted as an R artifact, not run in Node.

## Conversational Texture
This is the final infrastructure piece before the multi-day powered run; the operator wants every paper percentage to state its common-cell denominator and every contrast to have an honest CI, so the analysis must publish denominators per hypothesis and be reproducible (seeded bootstrap, committed generator) -- no hidden compute, no fabricated numbers.
