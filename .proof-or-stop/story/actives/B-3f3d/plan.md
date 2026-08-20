# B-3f3d Execution Plan

Implement one signed, gate-consumed frozen review-inventory epoch around the existing ReviewRun and ReviewPass facts. The epoch freezes a REVIEW cutoff, observes required-lane and completeness-critic evidence on that cutoff, produces a receipt only after a clean zero-new-finding wave, and authorizes one aggregated REVIEW-to-remediation-DEV transition. It never certifies remediated code or authorizes TEST.

## CHK-001

Create core/review-inventory-epoch.ts as the deep owner of the epoch and receipt schema, canonical hashing, signing, verification, state machine and status projection. Persist one history file through StoryStore helpers. Add review_inventory_begin, review_inventory_status, review_inventory_finalize and review_inventory_cancel handlers and CLI schemas, wire them through registry and command policy, and register every gate fact in the process-fact registry and contract verifier. Begin resolves current REVIEW workspace, required reviewers, round, scope and material lineage; status always emits state, cutoff, wave, lanes, finding counts, blockers and one next command.

Verification: unit/pure tests cover signature tamper, replay, duplicate epoch identity, idempotent reload, cancellation and receipt scope. CLI smoke proves exact operator-visible output.

## CHK-002

Centralize assertOpenInventoryFresh and call it before review run creation, finding/pass persistence, epoch finalization and lifecycle transition consumption. Recompute material lineage at each consumer. If an unmediated change is observed, atomically persist INVALIDATED with old/current hashes and make all epoch evidence advisory. Add an OPEN-epoch prewrite/commit guard projection for supported adapters while retaining consumer-side revalidation as the authoritative safety net. Metadata-only runtime/story records remain allowed according to the canonical material hash exclusions.

Verification: exercise direct edit bypass, alternate handler, TOCTOU-style second check, concurrent receipt/mutation serialization, metadata-only update, source/test/prompt/policy changes and restored-old-hash attempts. Every rejection includes epoch ID, blocker code and exactly one recovery command.

## CHK-003

Derive each wave from existing signed ReviewRun/ReviewPass/Finding evidence bound to the epoch cutoff. Required lanes come from the canonical active-reviewer calculation; coverage/read manifests and unique reviewer/host/prompt identities must be terminal. The completeness critic is mandatory. Finalize only when all required lanes and critic are complete and the current wave adds zero new verified finding families. New verified findings extend the immutable aggregate digest and require the next bounded wave on unchanged material. Missing, timeout, cancellation, unsupported host, prose PASS, duplicate identity and unresolved duplicate disposition remain blockers. Budget exhaustion yields replan/decompose/escalate/human-adjudication status, never a receipt.

Verification: deterministic wave fixtures cover clean saturation, new-finding reopen, duplicate family disposition, incomplete lanes, unavailable host, forged coverage and budget exhaustion.

## CHK-004

Consume a verified FINALIZED receipt only on REVIEW-to-DEV rollback, once, carrying the complete finding-set digest and explicitly not authorizing TEST. Mark it consumed by the transition. After remediation changes material, the receipt is historical. Replace the round-two-plus one-receipt shortcut for final-review sufficiency with impacted required lanes derived from canonical impact/dependency closure; unknown closure, scope or policy impact fails closed to the full active lane set and preserves host/escalation assurance. Any regression follows the ordinary finding and remediation path.

Verification: test missing/stale/wrong-story/wrong-round/wrong-lineage/cancelled/invalidated/consumed receipt rejection, replay rejection, direct TEST rejection, narrow impacted-lane success, unknown-impact full-lane fallback and post-remediation regression.

## CHK-005

Add one deterministic B-cdf6 replay smoke and report. Encode the historical baseline as first-finding mutation followed by at least five mutation-driven redispatches RR-047 through RR-051. The new path must show one discovery epoch, zero accepted OPEN material commits, zero stale pass acceptance, one aggregated remediation DEV transition, zero mutation-driven redispatches and at most one clean final-review epoch. Required lane and host counts remain unchanged and all critical/high escape, historical mutation survival, post-cert mutation, stale acceptance and budget-manufactured-PASS counters remain zero.

Verification: run the replay twice for determinism, inject every declared historical and adversarial case, run focused typecheck/build/smokes, process-fact contract verification, Codex adapter verification when adapter assets change, and routine lattice validate. Record checklist evidence by intentRef only after commands pass.

## CHK-006

Implement canonical post-remediation impact closure as the deep owner of final-review lane selection. Derive changed-file and transitive dependency inputs from current repaired material, map them to active reviewer lanes, preserve required host and escalation assurance, and sign or otherwise bind the selection to story, review round, headHash, materialHash and storyFilesHash. A proven narrow repair selects exactly the impacted active lanes; missing, ambiguous, stale, unsupported or policy-sensitive inputs fail closed to the complete active lane set. Project the ordered gate-consumed lane list, selection mode and machine-derived reason in operator status. Remove the broken dependency on the excluded untracked B-cdf6 analysis document and replace it with tracked RR, Finding and exact commit provenance.

Verification: focused logic and handler smokes cover deterministic transitive closure, duplicate and alias normalization, narrow selection, full-set fallback, unchanged host assurance, stale/forged/cross-story/cross-round rejection, regression and scope-expansion recomputation, no return of the round-two any-one shortcut, exact status text, and repository-resolvable evidence references.

## Delivery order

1. Core epoch model, store and command surface.
2. Freshness/mutation barriers and review evidence binding.
3. Saturation evaluator and receipt.
4. Lifecycle remediation/final-review gates.
5. Replay, documentation and contract checks.
6. Post-remediation impact closure, tracked provenance repair and full validation.

Rollback is configuration- and artifact-safe: cancelled or invalidated epochs cannot authorize any transition; removing the feature leaves existing REVIEW evidence historical and the old gate is not re-enabled by artifact absence.
