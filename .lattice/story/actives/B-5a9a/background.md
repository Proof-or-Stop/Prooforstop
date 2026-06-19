## Trigger Event
On 2026-06-19, B-12d7's DONE materialHash drifted (90f7436 -> e28f2b8) purely because an UNRELATED story merged into main, re-staling every escalation verdict and verification-evidence binding even though B-12d7's own diff was unchanged -- forcing a full re-establish dance. This recurs on every story whenever main advances during its lifetime.

## Key Insights
materialHash is a WHOLE-TREE sha256 of all tracked source excluding .lattice (currentMaterialHash, evidence-freshness.ts; host verdicts bind to it via host-independence.ts as an attestation of what was reviewed). Because it is whole-tree, ANY unrelated main merge drifts it. Infra for a per-story scope already exists: changedFilesBetween (evidence-freshness.ts) and "changed vs merge-base main" (scope-contract.ts) compute a story's own changed-files set.

## Solution Tradeoffs
ADD a secondary storyFilesHash (the story's own changed files vs merge-base main) ALONGSIDE the whole-tree materialHash -- keep both. Bindings (review verdicts, escalation, evidence) stay VALID while storyFilesHash is unchanged; whole-tree drift is DOWNGRADED from instant-reject to a re-attestation-REQUIRED WARNING (it still demands explicit re-attestation when something the story transitively depends on may have changed), NOT a silent rebind. Do NOT switch to story-diff-only: that is a soundness REGRESSION (it misses an unrelated main change that interacts with this story's code -- transitive deps). Load-bearing soundness work; design via a decision-doc first.

## Conversational Texture
The operator analyzed three workflow frictions; a workflow-verified review identified whole-tree materialHash as the shared root cause and recommended this secondary-hash approach (Option 1) as the real fix -- explicitly rejecting story-diff-only (Option 3) as unsound -- while noting it is large, load-bearing work. The operator approved drafting it.
