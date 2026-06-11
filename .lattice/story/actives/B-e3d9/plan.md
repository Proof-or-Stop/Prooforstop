# Plan: B-e3d9 Close the six high-priority gap_analyze uncovered requirements

## CHK-001: Reject unsupported production receipt algorithms fail-closed

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/authority-contracts.ts, packages/main/src/core/authority-client.ts, packages/main/src/core/lattice-authority-native.ts
- Create: none
- Test: packages/main/src/tasks/authority-client-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:authority-client-smoke` passes.
- A focused unsupported algorithm case rejects a discovered or supplied server key whose algorithm is not ed25519 before any receipt can become production-verified.

**DoneWhen**:
- Production receipt verification accepts only ed25519 server key/signature algorithm metadata.
- Missing or non-ed25519 algorithm material fails closed with an explicit reason.
- Existing valid ed25519 receipt verification remains green.

## CHK-002: Converge supportsDryRun requirement without speculative metadata work

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/cli-engine.ts, packages/main/src/core/command-policy.ts, docs/requirements/decisions/cc-learnings.md
- Create: none
- Test: packages/main/src/tasks/dispatch-run-smoke.ts or a narrower existing CLI/command policy smoke if it already covers metadata/help behavior

**Verify**:
- `lattice gap_analyze` no longer reports `supportsDryRun?: boolean` as uncovered.
- Any code change is consumed by help, command schema, or command policy; if no code change is needed, the requirement text is narrowly updated to the current command-policy truth.

**DoneWhen**:
- There is one consistent dry-run contract across ToolDef/schema/COMMAND_POLICIES/docs.
- No new parallel metadata source is introduced unless it is actually consumed.

## CHK-003: Link Authority worktree policy requirements to existing runtime enforcement

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/worktree-policy.ts, packages/main/src/core/planner.ts, docs/requirements/decisions/lattice-authority-live-integration.md
- Create: none
- Test: packages/main/src/tasks/worktree-policy-smoke.ts, packages/main/src/tasks/planner-unattended-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:worktree-policy-smoke` passes.
- `npm --prefix packages/main run test:planner-unattended-smoke` passes.
- `lattice gap_analyze` no longer reports `requiresAuthoritativeWorktree` or either `requiresCleanWorktree` requirement as uncovered.

**DoneWhen**:
- Runtime preflight still fails closed for missing authoritative worktree when required.
- Clean worktree enforcement remains step-or-policy driven and preserves unrelated dirty changes.
- Gap closure is backed by code/test linkage rather than dead text.

## CHK-004: Link planner confirmation policy to story creation blocking behavior

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/planner.ts, packages/main/src/handlers/planner.ts, docs/requirements/decisions/lattice-authority-live-integration.md
- Create: none
- Test: packages/main/src/tasks/planner-unattended-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:planner-unattended-smoke` proves default `requiresConfirmationBeforeStoryCreate` behavior and blocked story creation without confirmation.
- `lattice gap_analyze` no longer reports `requiresConfirmationBeforeStoryCreate` as uncovered.

**DoneWhen**:
- Authority/non-unattended planning still stops before story creation unless confirmation is recorded.
- Story creation remains fail-closed and idempotent.

## CHK-005: Prove gap convergence and host-neutral review evidence

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Modify: none beyond evidence metadata through Lattice CLI
- Create: optional advisory review artifacts under runtime artifact paths only if a host CLI returns output
- Test: lattice gap_analyze, focused package test scripts, lattice validate --story=B-e3d9

**Verify**:
- `lattice gap_analyze` reports `Gaps: 0 high / 0 medium`.
- Relevant focused tests pass.
- `lattice validate --story=B-e3d9` passes and records validation evidence.
- Claude/Codex host reviews are recorded as advisory; Lattice CLI/test evidence remains authoritative.

**DoneWhen**:
- The six original high gaps are absent from gap_analyze.
- Review evidence does not overclaim host output as Authority.
- Final summary states B-ce79 was not retroactively blocked and this story only closes the six convergence gaps.
