# B-4eea Plan: Complete Playbook Runtime Memory M5-M12

## Scope Guard
B-cc94 already completed MVP1/M0-M4. This story is done only when CHK-001..CHK-010 and milestone rows M0/M5/M6/M7/M9/M10/P3/M8/M11/M12 are all verified. Memory packs remain advisory: authority=non_authoritative and gateEvidence=false.

## Execution Order
1. CHK-001: preserve red/repro/spike binding and full-scope ledger.
2. CHK-002..CHK-004: implement MVP2 advisory consumers for handoff, story lifecycle, and DONE.
3. CHK-005..CHK-006: implement M9/M10 generator and verifier; full 1M correctness must pass before full completion.
4. CHK-007: add registered warn/enforce policy gated by M10.
5. CHK-008: add capture-or-noop decision.
6. CHK-009: add health/drift scanner.
7. CHK-010: update rollout/runbook and complete Codex+Claude 3x2 verification; agy fallback only.

## CHK-001
Verify the repro-first candidate artifacts remain candidate-only and the ProofStory ledger prevents scope shrinkage. Evidence: repro/red/spike IDs, proofstory diagnostics, done_intent_equivalence_check.

## CHK-002
Wire buildMemoryFreshnessPack/renderMemoryFreshnessPack into handoff_create, handoff_resume, and host dispatch projection output. Include canonical host labels and agy fallback status only with primary-host failure signals.

## CHK-003
Wire the same runtime pack into story_create/repro-first intake and story_advance phase output. Keep registered blocking policy separate from playbook text.

## CHK-004
Wire done_prepare/done_closure/final-response advisory output. Full roadmap wording must point to ParentRollupResult/current facts, not playbook memory.

## CHK-005
Add deterministic baseline generator command with small/full profiles, manifest, stable digest, corrupt row fixtures, and temp/gitignored output.

## CHK-006
Add baseline verifier command with correctness thresholds, performance reporting, line cap/stale checks, and profile budget reporting.

## CHK-007
Add rollout policy: advisory default, warn on stale/missing pack, blocking only for registered critical consumers after M10 correctness passes.

## CHK-008
Add capture-or-noop end-of-work memory decision command/reminder. No automatic project/global promotion.

## CHK-009
Add playbook_runtime_health with project-configurable required runtime memory classes and consumer wiring drift checks.

## CHK-010
Update docs/help/runbook and run verification: build, MVP2 smoke, baseline smoke including full 1M profile, health smoke, validate, done_required_validate, and 3 rounds x 2 host Codex+Claude verdicts with agy fallback-only semantics.
