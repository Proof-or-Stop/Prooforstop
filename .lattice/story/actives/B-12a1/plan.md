# Plan — B-12a1: Register ProofStory intent artifacts in the scope classifier

## Problem

`classifyLifecycleArtifact` (packages/main/src/core/lifecycle-registry.ts) recognizes a story-dir top-level file as a Proofbound lifecycle artifact only when its filename is in the closed set `LATTICE_LIFECYCLE_ARTIFACT_FILENAMES`. The ten ProofStory intent-hardening artifacts written by `store.ts` (lines ~668–798) were never registered, so under a `mode=enforce` scope contract they classify `rule=out_of_scope` (fail, blocking) at the DEV→REVIEW scope gate — pure friction that recurs for every high-assurance story (trigger: B-623a, 2026-07-12).

Repro (current main dist): `classifyScopePath` on `.lattice/story/actives/B-fixture/<name>` returns `unknown/BLOCKED` for all ten names while `checklist.json` returns `lifecycle_artifact PASS`.

## CHK-001 — registry addition

File: `packages/main/src/core/lifecycle-registry.ts`

Add the ten filenames to `LATTICE_LIFECYCLE_ARTIFACT_FILENAMES`, grouped with a comment naming the source (ProofStory intent-hardening block in store.ts):

- `original-intent-snapshot.json`
- `milestone-ledger.json`
- `milestone-closeout.json`
- `slice-plan.json`
- `parent-ledger-rollup.json`
- `proofstory.json`
- `intent-collision.json`
- `scope-shrinkage-decision.json`
- `red-evidence.json`
- `spike.json`

No logic change to `classifyLifecycleArtifact` / `classifyScopePath`. The closed-set trust policy (B-b9d0) is preserved: only exact known filenames at story-dir top level pass; unknown files still fail closed.

Deliberate non-goals (carved out in background.md): `grill.json`, `clusters.json` (registry's `cluster.json` singular entry looks stale), `scope-extension-decisions.json` — different command families, tracked as a separate follow-up story.

## CHK-002 — smoke assertions

File: `packages/main/src/tasks/scope-contract-smoke.ts`

Extend the existing `lifecycleRuntimePositive` block (enforce contract `waveContract` whose allowed sets do NOT list story-metadata paths): call `checkScopeContract` with the ten paths `.lattice/story/actives/B-scope/<name>` and assert each produces a `scope.lifecycle_artifact:B-scope:<name>` row with `status=pass`, `blocking=false`, and overall status stays `pass`. Before the registry fix these assertions fail (rows come back `scope.out_of_scope`, status `fail`) — this is the red→green pair for the story's red evidence.

## Verification

1. Red (pre-fix, recorded via red_evidence_create): node repro against the built dist shows all ten paths `unknown/BLOCKED`.
2. Green: `npm --prefix packages/main run build && node packages/main/dist/tasks/scope-contract-smoke.js` passes with the new assertions.
3. Full smoke selection unchanged: scope-contract-smoke already runs inside the standard suite; no new test wiring needed.

## Risks

- Widening the trust set: these files are command-generated story metadata, same provenance class as the already-registered names; the classifier still requires a valid story-dir prefix + storyId, so no arbitrary-file hole is opened.
- Name drift: smoke pins all ten names; a future rename in store.ts fails the smoke loudly.
