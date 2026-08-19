## Trigger Event
During B-12a1 round-2 review on 2026-07-12, the docs reviewer flagged a pre-existing inventory omission: milestone-closeout.json is written by store.ts (writeJson ~line 706, via the milestone-status handler DONE-time capture at handlers/milestone-status.ts:145) but is absent from both packages/main/src/core/process-fact-registry.ts and the requiredArtifactFacts list in scripts/verify-process-fact-contract.mjs. Verified still true on 2026-07-13 against CLI 0.3.191 sources.

## Key Insights
The artifact is genuinely command-generated story metadata: story_advance DONE triggers the milestone-status handler capture, which builds a MilestoneCloseoutSnapshot and persists it through store.writeMilestoneCloseout. It already appears in lifecycle-registry.ts and scope-contract-smoke.ts, and the milestone_closeout read command is classified L0 in process-fact-levels.ts, so the process-fact registry and contract script are the only two inventory surfaces missing it. Every neighboring artifact entry follows one fixed pattern: a PROCESS_FACT_ARTIFACT_BY_COMMAND ref plus a registry fact entry plus one requiredArtifactFacts line asserting name/path/signed in the contract script.

## Solution Tradeoffs
Register the artifact in both surfaces following the adjacent artifact:milestone-ledger.json pattern (unsigned, consumer text naming the DONE-phase milestone_status / milestone_closeout frozen-snapshot read path), rather than inventing a new fact kind or restructuring the registry. The consumer description must reflect that the snapshot is read-side only and never re-blocks DONE, per the explicit non-blocking design comment in the milestone-status handler. No behavior change to the handler or store is in scope.

## Conversational Texture
The user asked for a small chore story that first verifies the artifact really is command-generated story metadata and then registers it in both places using whatever smoke/contract assertion pattern the neighboring entries use. They explicitly noted this is unrelated to the scope-classifier registry follow-up already running from B-12a1, so scope stays narrow: two files plus the contract test staying green.
