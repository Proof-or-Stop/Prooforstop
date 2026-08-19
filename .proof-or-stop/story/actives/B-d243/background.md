## Trigger Event
During story B-70e4 on 2026-06-24, every unrelated merge into main re-staled the signed delivery-check ("stale delivery-check: materialHash mismatch") three separate times, each forcing a full lattice-review-delivery re-sign + re-bind even though the story's own diff was byte-identical. An adversarial design panel then locked the sound scope of the fix.

## Key Insights
The storyFilesHash secondary-freshness signal (decision story-files-hash-material-drift) already downgrades whole-tree drift to a re-attestation advisory for review runs, verification evidence, and escalation verdicts, but NOT for the DONE delivery-check. delivery-check is a SIGNED attestation, so storyFilesHash must be folded INTO the signature before any downgrade keys on it, otherwise an unsigned field is a forgeable bypass. Gate A (completed-snapshot) is a frozen-ref integrity check where storyFilesHash is dead code and must stay strict; Gate B (done-required suite) stays strict so it genuinely re-runs on the merged tree.

## Solution Tradeoffs
Scope is Gate C only: fold storyFilesHash into signDeliveryCheck / recomputeDeliveryCheckHash and persist it in the writer + waiver re-sign; add an evaluateDeliveryCheckFreshness branch that, on materialHash mismatch with a matching SIGNED storyFilesHash, returns a mandatory loud advisory (never 'fresh', hash never rebound); a story-owned change (storyFilesHash mismatch) or a missing storyFilesHash stays strict-stale. Keep Gate B re-running and Gate A strict per the locked design. Re-fixture the delivery-check-freshness smoke to a story-branch topology so storyFilesHash is meaningful.

## Conversational Texture
The operator should stop being forced to re-sign the same reviewed diff on every unrelated main merge, and instead see a loud one-line advisory on the DONE delivery-check row that unrelated whole-tree drift occurred and re-attestation is available if the merged-in code could affect behavior.
