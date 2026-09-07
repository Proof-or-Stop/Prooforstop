## Trigger Event

On 2026-09-06, probe rp-mtptbazb-cvxkwb reproduced a concrete bootstrap failure at baseline commit f2d3fd54c320a07f4e71e8e40ecbbb28329609d4. A reader can confirm that compiled dist files exist and no build is active, then a concurrent builder can acquire the production build lock and move the old dist tree before the reader imports it. The admitted reader then exits with a missing-module recovery error even though the builder succeeds, interrupting normal local Proof-or-Stop commands during a legitimate rebuild.

## Key Insights

The independent repro review rr-mtpu1szj-90a952 accepted this as the target bug rather than harness or environment noise. The durable spike archive sr-mtpu1soj-559bfe contains the executable harness, fixed production snapshots, hashes, controls, and raw traces. Its controlled schedule observed reader failures in all three baseline runs, no reader failures in three experimental protected runs, and failures again in three runs after that protection was removed. These records establish the starting failure and causal direction, but they are candidate evidence rather than proof that the final production code is correct.

## Solution Tradeoffs

The experimental repair serialized the initial module import with the same build mutex, proving that reader-writer coordination can close the race. It is not production-ready because importing the existing mutex helper would load proper-lockfile before dependencies are installed and would break the fresh-checkout diagnostic path. PLAN must choose the smallest bounded coordination that prevents promotion during the initial import while retaining dependency-free bootstrap startup, actionable missing-artifact failures, finite waiting, lock cleanup, and relevant platform compatibility. Broader direct-dist consumers, lifecycle reconciliation, global executable ownership, compilation-time source edits, desktop-package locking, rename-crash recovery, and unrelated cleanup remain excluded.

## Conversational Texture

The maintainer should be able to run a local Proof-or-Stop command while another legitimate build promotes dist and see the command complete from one coherent compiled tree, not a transient missing-module error. A genuinely unbuilt checkout should still stop quickly with the existing recovery instructions. Completion therefore requires a fresh final-code regression that reuses the archived controlled schedule, demonstrates baseline RED, final GREEN, and removed-protection RED, confirms every builder and control succeeds, and then passes independent REVIEW, TEST, validation, and local DONE convergence.
