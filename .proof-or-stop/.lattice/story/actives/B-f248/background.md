## Trigger Event
The powered-ablation program (pre-reg docs/requirements/decisions/lattice-experiment-protocol.md rev3.1) reached infra-(a) piece 4 on 2026-06-23 after B-ebbb (scoring-checks, v0.3.72) and B-2d4c (adjudicator, v0.3.70) merged. The §7 run-record schema and §3 applicability matrix are specified but no driver enumerates the matrix or emits records in that exact shape yet.

## Key Insights
The pre-reg is the authority: §1 defines 5 arms, §2 the 24-task stratified corpus, §3 the 15 recovery scenarios B1-B15 with a per-arm applicability table (B4/B5/B10 exclude A1; the other 12 apply to all arms), §5 the GLMM + common-cell denominators, §7 the exact run-record field list and the validity filter (infra failure => void+re-run+log; task-level failures kept; N/A cells excluded+logged). The driver must honour every one of these and must be deterministic and offline-testable by injecting the per-cell engine.

## Solution Tradeoffs
Keep the live-model invocation behind a pluggable engine function so the driver core (enumeration, applicability filter, denominator-set assignment, record canonicalisation, validity filter, seeded order) is unit-tested with a stub engine and no model calls. Reuse run-recovery.mjs as the real engine and adjudicate.mjs + checks.mjs for outcome/scoring rather than re-deriving them. Do not run the powered campaign in this story; only build and self-test the driver.

## Conversational Texture
This is part of a multi-day, daily-chunk experimental-infrastructure program; the operator wants the harness pieces built and self-validated deterministically before the real compute campaign, and every percentage in the eventual paper must state its common-cell denominator, so the driver must record denominator-set membership per run from the start.
