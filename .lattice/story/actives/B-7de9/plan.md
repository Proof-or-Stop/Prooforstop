# Plan: Control-arm memory JSON-leak isolation (B-7de9)

Adds a thin isolation layer on top of main's B-ab8d experiment-arm render gate,
keyed on the same resolveExperimentArm. The core primitive is
redactMemoryPackForControlArm (new core/runtime-memory-arm-gate.ts), applied at
every JSON/file pack surface B-ab8d leaves host-readable on control.

## CHK-001
redactMemoryPackForControlArm empties every serialized memory-pack surface on control.
- New core/runtime-memory-arm-gate.ts exports isControlArm(env) and
  redactMemoryPackForControlArm(pack): on control it empties results/items arrays,
  nulls sourceDigests string leaves, collapses packDigest to the empty-set digest,
  and FAILS CLOSED (a throwing pack yields a fresh empty pack, never the input);
  on treatment/no-experiment it returns the pack unchanged.
- Apply it at: done_closure --json (handlers/done-closure.ts), host_dispatch
  --json/--output + the prefetch manifest's memoryPackDigest/memoryTopHitIds
  (handlers/lattice-handoff.ts), handoff_create attach + handoff_resume
  source-or-rebuilt pack (handlers/lattice-handoff.ts), and
  playbook_runtime_health required-class topHitIds/packDigest
  (handlers/playbook-runtime-memory.ts).
- Verify: experience-arm-gate-smoke (unit: array/sourceDigests/packDigest empty +
  fail-CLOSED) and experience-arm-isolation-e2e (CLI: control JSON empty,
  treatment/normal populated).

## CHK-002
final_response_check (the 8th RuntimeConsumer) routes through the shared render gate and redacts its JSON pack.
- handlers/playbook-runtime-memory.ts: final_response_check calls
  surfaceRuntimeMemoryPack (fires experience_pack_surfaced on both arms,
  suppresses the TEXT summary on control via shouldRender) and returns
  redactMemoryPackForControlArm(pack) as memoryFreshnessPack.
- Strengthen the consumer-wiring health oracle to require surfaceRuntimeMemoryPack
  at the final_response_check site (drift guard).
- Verify: experience-arm-isolation-e2e asserts control final_response_check --json
  pack empty + text omits memoryTopHitIds; treatment/normal populated.

## CHK-003
parallel dispatch injects no experience on control; two corpus tools join the memoryRetrieval block.
- core/lattice-parallel-wave.ts: experienceRefs() returns [] when isControlArm,
  the single chokepoint for parallel_dispatch/report/plan injection.
- command-policy.ts: add memoryRetrieval: true to memory_benchmark_real_data and
  source_lineage_audit (re-derived from current main so quantum_claim +
  playbook_candidate_ingest policies stay intact).
- Verify: experience-arm-isolation-e2e asserts control parallel_dispatch
  experienceRefs=[] and both corpus tools refused on control, permitted on
  no-experiment; experience-arm-gate-smoke asserts main's block is a no-op unless control.
