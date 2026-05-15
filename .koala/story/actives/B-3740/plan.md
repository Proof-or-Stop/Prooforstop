# Plan: B-3740 Lifecycle Registry V1 — single-source-of-truth for phase commands and artifacts

## CHK-001: Add phase-commands and phase/transition-artifacts dimensions to the registry

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lifecycle-registry.ts (add `LIFECYCLE_ARTIFACTS` typed enum + per-phase command projection + artifact projection helpers)
- Test: packages/main/src/tasks/flow-stability-smoke.ts (or a dedicated lifecycle-registry contract task)

**Verify**:
- `lifecycleCommandsByPhase()` returns a stable phase→commands map
- `lifecycleArtifactsByPhase()` (or transition-keyed) returns a stable map of typed artifact-file enum values
- `npm --prefix packages/main run build` clean

**DoneWhen**:
- A typed artifact enum (`LifecycleArtifact`) covers known artifact files: init-check.json / scope-check.json / delivery-check.json / test-evidence.json / summary.json / declared-artifacts.json / review-passes.json / review-runs.json
- New command + artifact dimensions are SEPARATE exported projections — not new fields woven into `LIFECYCLE_TRANSITIONS` objects that phase-flow.ts consumes
- Projection helpers are pure functions mirroring the `lifecycleForwardTransitionsByPhase` pattern

## CHK-002: Registry consistency contract test

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/tasks/lifecycle-registry-contract.ts (or extend an existing contract task)
- Modify: packages/main/package.json (add `test:lifecycle-registry-contract` script if a new task)
- Modify: packages/main/src/core/lifecycle-registry.ts (if a resolved-command-set helper is needed)

**Verify**:
- Contract test passes when registry / command-policy allowedPhases / DEFAULT_PHASE_TOOLS / process-fact lifecycle agree
- Injecting a DEFAULT_PHASE_TOOLS command absent from the registry command dimension makes the test FAIL naming the command
- Contract asserts every oracleRows/gate artifact reference resolves to a declared `LifecycleArtifact`

**DoneWhen**:
- Contract test models the same resolution semantics as DEFAULT_PHASE_TOOLS: the `*` wildcard bucket commands resolve as legal in every phase + per-phase additions — checks the resolved effective command set, no false positive on `*` (preMortem #1)
- Contract cross-checks command-policy.ts `allowedPhases`, config.ts `DEFAULT_PHASE_TOOLS`, and process-fact lifecycle references against the registry
- Failure output names the divergent command/artifact, not a generic message

## CHK-003: Regression — zero public behavior change

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (snapshot phase-flow output before/after)

**Verify**:
- phase-flow.ts `getPhaseInfo` / `checkPhaseTransition` output byte-identical for every phase
- `npm --prefix packages/main run build` + existing smokes green
- `git diff main...HEAD` touches only registry projections + contract test + regression test

**DoneWhen**:
- Regression test snapshots `getPhaseInfo` + `checkPhaseTransition` for all LIFECYCLE_PHASES and asserts byte-identical vs a captured baseline
- context.ts derived output unchanged
- No TEST semantics change, no legacy main-type change, no story_advance restructure

## Validation

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:lifecycle-registry-contract` (new)
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:runtime-fact-contract` (regression)
- `koala validate --story=B-3740 --json`

## Rollback

All changes are additive (new projections + new contract test + new regression test). Reverting removes the projections and tests; phase-flow.ts / context.ts / command-policy.ts / DEFAULT_PHASE_TOOLS are untouched in behavior, so rollback is zero-risk.
