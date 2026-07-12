## Trigger Event
During B-623a on 2026-07-12, the four ProofStory intent artifacts (original-intent-snapshot.json, intent-collision.json, red-evidence.json, proofstory.json) written by lattice commands into .lattice/story/actives/B-623a/ were classified rule=out_of_scope (fail, blocking under mode=enforce) at the DEV->REVIEW scope gate, and the owner had to hand-acknowledge story-metadata paths in the story's own scope contract.

## Key Insights
The classifier consults a single closed registry, LATTICE_LIFECYCLE_ARTIFACT_FILENAMES in packages/main/src/core/lifecycle-registry.ts, which already lists other command-generated story metadata (understanding.json, decision.json, scope-contract.json, verification-evidence.json, ...). The ProofStory family was added later (store.ts writeJson sites) and its six filenames were never registered, so classifyLifecycleArtifact returns null and classifyScopePath falls through to out_of_scope. The fix is a data-level registry addition, not a classifier-logic change; milestone-ledger.json and spike.json are the same command family and hit the same friction, so they belong in the same change.

## Solution Tradeoffs
Registering the six exact filenames in the existing closed set keeps the narrow trust policy intact (only known story-dir top-level filenames pass); the alternative of allowing any *.json under a story dir would reopen the implicit-pass hole B-b9d0 deliberately closed. A smoke assertion in scope-contract-smoke.ts pins the behavior so a future rename of the artifacts fails loudly.

## Conversational Texture
The owner running a high-assurance story cares that command-generated metadata never blocks their own phase gates: after this fix, scope_contract_check and story_advance should show these files as lifecycle_artifact pass rows with no manual acknowledgement, exactly like checklist.json does today.
