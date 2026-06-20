# Plan: B-1d4c Implement truth-first host handoff fact preflight and stale-doc supersession guard

## CHK-001: Build host handoff preflight pack including session_brief, memory preflight, stories/checklists, gap, and stale-validation signals

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lattice-handoff.ts, packages/main/src/handlers/lattice-handoff.ts, packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/lattice-hosts.ts
- Test: packages/main/tests/lattice-handoff.test.ts

**Verify**:
- `lattice validate`
- `npm --prefix packages/main run test -- lattice-handoff`

**DoneWhen**:
- `HostHandoffProjection` includes `sessionBrief` and `devMemoryPreflight` snapshots.
- `PrefetchManifest` is emitted on handoff inspect/accept paths.
- Core handoff projection contains active story/checklist and gap/learning summaries when available.

## CHK-002: Add plan supersession detection and completed-story references

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/lattice-handoff.ts, packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/lattice-hosts.ts
- Test: packages/main/tests/lattice-handoff.test.ts

**Verify**:
- `lattice validate`
- `npm --prefix packages/main run test -- lattice-handoff`

**DoneWhen**:
- Handoff projection includes a `supersession` object with `status/completedByStory/completionCommit/supersededBy/status` and provenance source.
- Completed/superseded docs with valid completion metadata are marked as stale for active-task claims.
- `completedByStory` and `completionCommit` are surfaced in host-ready output.

## CHK-003: Reject risky handoff claims without required evidence state

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/lattice-handoff.ts, packages/main/src/handlers/lattice-handoff.ts, packages/main/src/handlers/session.ts
- Test: packages/main/tests/lattice-handoff.test.ts

**Verify**:
- `npm --prefix packages/main run test -- lattice-handoff`
- Adversarial command check where docs indicate pending but DONE facts say complete.

**DoneWhen**:
- Handoff resume/accept returns explicit `prefetchManifest.verdict` and `winSignal` values.
- When evidence is missing/stale, verdict is `uncertain` and host output requests revalidation.
- Claims of “not done” are blocked or labeled as uncertainty when authoritative story facts disagree.

## CHK-004: Expose preflight payloads in host status/probe outputs and add regression tests

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-003
**Files**:
- Modify: packages/main/src/core/lattice-handoff.ts, packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/lattice-hosts.ts
- Test: packages/main/tests/lattice-handoff.test.ts, packages/main/tests/lattice-cli-probe.test.ts

**Verify**:
- `npm --prefix packages/main run test -- lattice-cli`
- Status/host probe output contains manifest keys with deterministic schema.

**DoneWhen**:
- Host status/probe output includes machine-readable preflight snapshot references.
- Regression tests assert manifest keys and values for blocked/no-block/uncertain cases.
