## Trigger Event
On 2026-07-16, B-c163 receipts proved five successful routine validation reruns on identical materialHash and storyFilesHash, wasting 1,926,151ms. B-19ca then ran all 45 configured commands successfully, failed only because verificationEvidence was stale, and after refresh executed the identical suite again for another 370 seconds before entering TEST.

## Key Insights
The dominant issue is not a command timeout and not infra_failure phase rollback. Ordinary validate has no fresh-PASS reuse gate. HEAD alone is insufficient because validation metadata commits move HEAD without changing product material; safe reuse needs material and story-file identity, trusted metadata-descendant lineage, complete coverage, and a full validation-plan identity including command/config/entrypoint and focus or profile semantics.

## Solution Tradeoffs
Reuse must fail closed to execution, never fail open to PASS. The DONE reuse envelope cannot be copied wholesale because ordinary validate does not produce build-proof or DONE command-spec artifacts. Extract only the shared lineage core, add a routine-specific identity, make legacy evidence execute, place the check inside the validation lock with a second HEAD read, and avoid rewriting evidence on reuse so the optimization cannot create its own metadata drift.

## Conversational Texture
The user explicitly wants the approved workflow to run unattended and is frustrated by repeated multi-minute suites that add no confidence. The visible success criterion is simple: after an unchanged tree already has a complete PASS, refreshing verification evidence or making metadata-only progress should lead to a fast auditable reused result, while any meaningful code, command, policy, focus, profile, or environment identity change still runs the real validation suite.
