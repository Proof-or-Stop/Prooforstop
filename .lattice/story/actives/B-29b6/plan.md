# B-29b6 Plan - Lattice Parallel Wave

## Goal

Productize a Lattice-compatible Parallel Wave surface for safe multi-story/worktree acceleration. A Parallel Wave is a collection-level planning artifact that references Canonical Stories, evaluates DAG/dependency/hotspot/capability constraints, emits visible degradations, preserves evidence/lineage/merge guidance, and never claims production authority without server receipts.

## Architecture Position

- Story remains the unit of work.
- Canonical Story remains the host-neutral per-story representation.
- Parallel Wave is a collection-level projection over multiple stories, not a replacement for Canonical Story.
- Capability diagnostics decide whether a host is a candidate executor, but availability is not evidence.
- Wave outputs can guide multi-worktree dispatch; they cannot satisfy lifecycle gates by themselves.
- Local DONE and production DONE remain separated by authority binding and server receipts.

## Command Surface

- `parallel_wave_create`: create a no-overwrite wave JSON projection from story ids and host hints.
- `parallel_wave_inspect`: read a wave JSON projection and report DAG, degradations, authority boundary, and merge order.
- `parallel_plan`: generate a current execution plan from an explicit wave file or active stories.

All commands are read-only or no-overwrite projection commands. They must be L0 in process fact levels and readOnly in command policy.

## CHK-001 Document the Lattice Parallel Wave execution contract

Steps:
1. Add `docs/requirements/decisions/lattice-parallel-wave.md`.
2. Define schema fields: waveId, rootIntent, stories, lanes, dependencies, sharedHotspots, hostCandidates, degradations, evidenceRefs, mergeOrder, authority.
3. State that the wave is scheduling/recovery guidance only.
4. Document the six-milestone execution chain: demand split, story DAG, parallel plan, worktree/host dispatch, evidence/lineage, ordered merge.

Verification:
- Docs mention Canonical Story boundary, visible degradations, capability diagnostics, and productionDone=false without receipts.
- Docs do not claim wave artifacts satisfy DONE or production authority.

## CHK-002 Implement the Parallel Wave core model

Steps:
1. Add `packages/main/src/core/lattice-parallel-wave.ts`.
2. Build a wave from story ids and host hints using `StoryStore`, `buildCanonicalStory`, `buildCapabilityProbe`, and existing parallel policy semantics.
3. Dependencies and shared hotspots must produce visible degradations.
4. Explicit unsafe metadata must not override mechanical dependency/hotspot risk in the final recommendation.

Verification:
- Happy: independent supporting story becomes parallel DEV candidate.
- Edge: active dependency produces plan-only/blocked guidance.
- Adversarial: shared hotspot and missing receipt capability produce visible degradation and productionDone=false.

## CHK-003 Add CLI surfaces for wave creation, inspection, and planning

Steps:
1. Add `packages/main/src/handlers/lattice-parallel-wave.ts`.
2. Wire `parallel_wave_create`, `parallel_wave_inspect`, and `parallel_plan` in `registry.ts` and `cli-engine.ts`.
3. Support `--format=json` and text output.
4. Support optional `--output` with no-overwrite behavior for wave creation.

Verification:
- CLI commands appear in `koala help`.
- JSON output is parseable and stable.
- Existing files are not overwritten.

## CHK-004 Integrate capability, degradation, evidence, and merge-order guidance

Steps:
1. Add authority section with `productionDone:false`, `authorityChanged:false`, and empty top-level receipt refs.
2. Add per-story host candidate capability summaries from `capability_probe`.
3. Add evidence refs from Canonical Story/evidence manifests where available.
4. Add deterministic merge order: mainline before dependents, independent supporting stories after dependency-ready candidates, exploratory last.

Verification:
- Conditional/unavailable host capabilities are visible degradations.
- Evidence refs are preserved as refs only and do not refresh evidence.
- Merge order is deterministic and names dependency blockers.

## CHK-005 Add focused smoke tests and command policy coverage

Steps:
1. Add `packages/main/src/tasks/lattice-parallel-wave-smoke.ts`.
2. Add `npm run test:lattice-parallel-wave-smoke`.
3. Assert MAIN_TOOLS, registry, command policy, and process fact level coverage.
4. Cover happy/edge/adversarial story graph behavior.

Verification:
- `npm --prefix packages/main run build`.
- `npm --prefix packages/main run test:lattice-parallel-wave-smoke`.
- Existing Lattice smokes still pass where relevant.

## CHK-006 Record validation evidence and product-facing usage

Steps:
1. Run scope contract check.
2. Run build and focused smoke tests.
3. Run `koala validate --story=B-29b6 --json`.
4. Record checklist verification evidence and summary.

Verification:
- Every checklist item has happy/edge/adversarial evidence.
- Scope check has no forbidden writes.
- Final user-visible transcript explains how to create and inspect a Parallel Wave.
