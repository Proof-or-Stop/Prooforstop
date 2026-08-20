# B-364f Plan

## CHK-001

**Owner**: main-agent

**Goal**: Add the required `@changes` field to the two B-5f5b smoke file-level `@task` annotations so the existing annotation validator can parse them as compliant.

**Touchpoints**:
- `packages/main/src/tasks/playbook-seed-backfill-smoke.ts`
- `packages/main/src/tasks/playbook-trial-automation-smoke.ts`

**Implementation**:
- Add a short `@changes` block to each annotation describing the smoke coverage it provides.
- Do not edit runtime playbook logic, learning stores, validator semantics, command policy, or historical backfill/trial data.

**Verify**:
- Run the direct annotation validator import against `packages/main/src` and confirm `errors.length === 0`.
- Run `lattice convergence_check --json` and confirm `Code annotations compliant` passes.

**Docs Promise**:
- This story does not add user-facing command behavior; it restores convergence accuracy for the already-completed B-5f5b playbook backfill/trial automation story.
