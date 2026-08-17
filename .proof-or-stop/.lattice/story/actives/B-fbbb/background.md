## Trigger Event
On 2026-07-05, while verifying work adjacent to B-8128, `experience-layer-playbook-smoke` was found silently red at 27/31 on the main baseline. It is excluded from the curated `lattice validate` list, so the failures never surfaced.

## Key Insights
The four failures split into two INDEPENDENT causes, not a cascade. The import-fence violation trips exactly 2 checks: `packages/main/src/handlers/playbook.ts` imports `../core/source-lineage-audit.js` and `../core/playbook-seed.js`, outside its smoke allowlist. The other 2 (decision-doc-promotion + experience-layer-digest-extract) come from an unrelated stale assertion: commit 8892270bf reworded the `decision_doc_save` process-event authorityBoundary, but the decision-doc smoke still expected the retired substring "not remote receipt completion"; digest-extract fails only because it re-runs that smoke.

## Solution Tradeoffs
Moving the two helpers behind an allowed boundary is infeasible cleanly: `learning-store.ts` has a stricter fence and cannot absorb them (source-lineage-audit imports dev-memory.js; playbook-seed imports playbook-runtime-memory.js), and a barrel indirection would merely game the grep. So widen the positive allowlist: both helpers are legitimate members of the experience-layer/learning boundary and neither is a finding-writer, advisory, or gate, and the load-bearing negative assertion still holds independently. For the decision-doc smoke, update the stale substring to the current committed contract rather than reintroduce retired wording.

## Conversational Texture
The operator first asked to decide move-vs-widen for the fence and re-run to confirm 31/31, then explicitly requested this land through the Lattice story workflow for the audit trail, choosing a single combined chore story over splitting the decision-doc fix. The changes are test-maintenance plus one comment; no shipping behavior changes.
