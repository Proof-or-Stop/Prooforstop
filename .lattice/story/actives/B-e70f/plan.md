# B-e70f Plan - Lattice Parallel Dispatch Operator Surfaces

## Goal

Turn the existing Lattice Parallel Wave read-only planning model into a more usable operator surface for multi-story parallel delivery: dispatch manifests, wave status, serial merge queue guidance, reports, and bounded project experience references. This is still local planning context, not execution evidence or production authority.

## Authority Boundary

- New outputs remain read-only projections.
- `spawned:false` and `requiresRunnerConfirmation:true` make it clear no Agent actually ran.
- `authority.productionDone:false`, `authority.authorityChanged:false`, and `authority.receiptRefs:[]` are invariant.
- Dev-memory entries are the project public experience library, but they remain `gateEvidence:false` and `authority:"non_authoritative"`.

## CHK-001 Document Parallel Dispatch operator contract and memory boundary

Update `docs/requirements/decisions/lattice-parallel-wave.md` with the new command semantics and JSON contracts. Clarify that dispatch/status/merge/report are operator surfaces: they help decide what to run, inspect, merge, or report, but they do not launch agents or satisfy gates. Add a small bridge back to `docs/requirements/decisions/dev-memory.md` stating that the project public experience library already exists as dev-memory and is only bounded context.

Verification: `rg -n "parallel_dispatch|parallel_status|parallel_merge_queue|parallel_report|public experience library|non-authoritative" docs/requirements/decisions/lattice-parallel-wave.md docs/requirements/decisions/dev-memory.md`.

## CHK-002 Add core dispatch, status, merge queue, and report projections

Extend `packages/main/src/core/lattice-parallel-wave.ts` over the existing `LatticeParallelWave` object. Add schema versions and builders for dispatch, status, merge queue, and report. Reuse existing story refs, merge order, host candidates, evidence refs, dependency summaries, hotspot degradations, and non-authority boundary.

Verification: `npm --prefix packages/main run test:lattice-parallel-wave-smoke` asserts schema versions, candidate/blocked/plan-only partitioning, merge blockers, report evidence summaries, and authority invariants.

## CHK-003 Expose CLI commands and policy/fact registrations

Extend `packages/main/src/handlers/lattice-parallel-wave.ts` and `packages/main/src/cli-engine.ts` with `parallel_dispatch`, `parallel_status`, `parallel_merge_queue`, and `parallel_report`. Register all four in `packages/main/src/core/config.ts`, `packages/main/src/core/command-policy.ts`, and `packages/main/src/core/process-fact-levels.ts` as read-only L0 commands. The existing lattice parallel handler registration in `packages/main/src/registry.ts` should continue to expose them through the same batch.

Verification: the smoke test checks `MAIN_TOOLS`, `createMainRegistry`, command policy, default phase tools, and process fact level entries for all four commands.

## CHK-004 Integrate project public experience library as bounded context

Reuse `packages/main/src/core/dev-memory.ts` helpers to search/read project and global memory. Add optional bounded `experienceRefs` to dispatch/report outputs when `includeExperience` is requested. Entries must be small summaries and retain `gateEvidence:false` plus `authority:"non_authoritative"`; no dev-memory entry may change authority or receipt refs. Empty or missing memory files should return an empty array, not fail.

Verification: seed project dev-memory in the smoke test, request `includeExperience`, assert relevant refs appear, then assert an empty-memory temp root still succeeds with `experienceRefs:[]`.

## CHK-005 Verify with focused smoke, build, policy checks, and Koala validation

Expand `packages/main/src/tasks/lattice-parallel-wave-smoke.ts` so it covers the old wave/inspect/plan paths plus the new dispatch/status/merge/report commands. Run TypeScript build, focused smoke, lifecycle registry/ownership contract checks if needed, `git diff --check`, scope contract check, and `koala validate --story=B-e70f`.

Verification commands:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:lattice-parallel-wave-smoke
npm --prefix packages/main run test:lifecycle-registry-contract
npm --prefix packages/main run test:command-ownership-contract
git diff --check
koala scope_contract_check --storyId=B-e70f
koala validate --story=B-e70f
```

## Non-Goals

- Do not auto-spawn Codex, Claude Code, Gemini, or a Mac runner.
- Do not change Python authority receipt semantics.
- Do not productize single-story multi-implementer sharding in this story.
- Do not duplicate dev-memory into another public experience store.
