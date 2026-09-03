## Trigger Event
During B-5952 on 2026-08-31, the registered command node scripts/run-proofstory-pre-review-live-proof.mjs failed before it could produce canonical authority evidence. The first Red was ENOENT for .lattice-codex/agents/lattice-implementer.md while only .proof-or-stop-codex is tracked. After an isolated compatibility alias exposed the next layer, acceptance_rollout_report failed because acceptance-rollout-verifier was rejected by review_run_start as agent_dispatch_actor_unknown.

## Key Insights
Both failures are in the canonical proof producer rather than in B-5952's instrumentation change. The adapter directory is a brand-path fact and should come from the shared canonical path contract. The cohort verifier is an internal service identity that invokes a bounded set of reviewer mutations; treating it as an arbitrary host would be overbroad, while leaving it unknown makes the registered production verifier impossible to execute.

## Solution Tradeoffs
The preferred path is to resolve the adapter directory through the existing brand-path registry and introduce an explicit least-privilege internal verifier authority whose permitted mutations are only those exercised by the registered cohort. A temporary alias or setting PROOF_OR_STOP_AGENT=main would make the command run faster but would hide the identity defect and weaken attribution. Negative tests must preserve denial for misspellings and prefix lookalikes.

## Conversational Texture
The operator asked that critical or high findings and evidence-integrity blockers not be deferred: record a Red reproduction, repair immediately, and then record Green proof. This Story stays separate from B-5952 so the instrumentation-bound scope is not expanded. Completion is visible when the exact registered cohort and pre-review live-proof commands run on the canonical repository layout without a legacy alias and the unknown-actor defenses still reject unregistered identities.
