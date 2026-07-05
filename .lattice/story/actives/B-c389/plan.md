# Plan — B-c389 Capability release lifecycle: live backfill + exposure + promotion

Follow-up to B-8128 (DONE). Spec: docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md (M6/M7/M8 + Follow-up Story).

Scope reality (verified on live data): the generic playbook lifecycle already carries most of M6/M7 — PBP-882 already appears in `playbook_promotion_status` pendingLearning (892 candidates), and `playbook_outcome_record` already enforces the M7 contract (exposureMode candidate-inspection/active-advisory/none; helped requires exposure != none + structured verdictSource), and `playbook_promotion_sweep --dryRun/--apply` already emits idempotent promotion recommendations that never activate. So the genuinely-new work is M8 (the capability_release_backfill command that finally binds the LIVE PBP-882), plus capability exposure records (M6) and wiring/asserting capability candidates through the existing outcome/promotion machinery (M7). Do not rebuild existing machinery.

## CHK-001 — M8 capability_release_backfill CLI + live B-785e/PBP-882 backfill
Approach: new `capability_release_backfill` handler mirroring the seed-backfill/dry-run→apply→--digest pattern. Dry-run reads readCapabilityReleaseLedger + readPlaybooks, finds candidates whose lineage lacks capabilityReleaseId but whose sourceStoryId has a capability release; emits a plan + plan digest. --apply (requires matching --digest) enriches exactly those via the existing enrichSeedWithCapabilityLineage-style lineage copy on the live playbooks.json, committing nothing to active state. Register across the standard sites (catalog, registry, handler, command-policy — writer classification, config phase-tools, process-fact-levels). Then RUN it on the real B-785e/PBP-882.
Pre-mortem: double-enrich / duplicate candidate → keyed on canonicalSourceKey + lineage-already-present check; never activate; never infer helped.

## CHK-002 — M6 capability candidate exposure records
Approach: candidates already surface (pendingLearning + B-8128's capabilityRelease column). Add an exposure RECORD written when a capability candidate is exposed via candidate-inspection: {playbookId, capabilityReleaseId, exposureMode, surface, storyId|sessionId, observedAt}. Reuse the learning-store append pattern. Verify post-backfill PBP-882 shows its capabilityRelease in playbook_promotion_status.
Pre-mortem: exposure must never change status or count as helped; only pendingLearning/promotionRecommendations/candidate-inspection surfaces (matchActivePlaybook guard unchanged).

## CHK-003 — M7 wire + assert capability candidates through outcome/promotion
Approach: prove a capability candidate flows through the existing playbook_outcome_record (structured verdict + concrete exposureMode) and playbook_promotion_sweep (idempotent recommendation on decisive evidence, never activates). Assert the already-enforced rules for capability candidates: DONE-success != helped; helped requires exposureMode != none + structured verdictSource; decisiveSamples excludes done-settlement/neutral/unknown. Minimal new code — mostly a capability-aware smoke; extend learning-store/handlers only if a capability candidate needs a distinct path.
Pre-mortem: do NOT weaken the invariants; a capability candidate must not promote to active without concrete exposure + structured verdict.

## CHK-004 — Validation + live idempotency proof
Approach: tsc clean; three new smokes green; add them to lattice.config.json validate.commands; lattice validate --json status=pass. Prove the LIVE B-785e backfill is idempotent: re-run is a no-op, PBP-882 stays status=candidate, usage.surfacedCount unchanged, no helped outcome produced.
