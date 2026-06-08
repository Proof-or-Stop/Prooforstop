# Plan: B-7a34 Implement Lattice Review Reflection Loop

## CHK-001: Implement review loop data model and storage

**Owner**: koala-implementer (Claude CLI host A), supervised by main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/store.ts, packages/main/src/core/types.ts
- Create: packages/main/src/core/review-loop.ts
- Test: packages/main/src/tasks/review-loop-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` compiles the new model/store types.
- `npm --prefix packages/main run test:review-loop-smoke` proves start/iteration/close records persist and latest status is derived from the newest record.

**DoneWhen**:
- review-loops artifact can store start, iteration, and close records for a story.
- invalid trigger input is rejected before persistence.
- reflection context is stored but not exposed as review pass or validation evidence.

## CHK-002: Expose minimal review_loop CLI surface

**Owner**: koala-implementer (Codex CLI host), supervised by main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/registry.ts, packages/main/src/cli-engine.ts, packages/main/src/core/command-policy.ts, packages/main/src/core/process-fact-levels.ts, packages/main/src/core/process-fact-registry.ts
- Create: packages/main/src/handlers/review-loop.ts
- Test: packages/main/src/tasks/review-loop-smoke.ts, scripts/verify-process-fact-contract.mjs

**Verify**:
- `lattice help | rg 'review_loop_'` lists the five v0.1 commands.
- `node scripts/verify-process-fact-contract.mjs` accepts the new L4/read-only command facts.
- `npm --prefix packages/main run test:review-loop-smoke` proves the commands do not spawn hosts or claim authority.

**DoneWhen**:
- review_loop_start, review_loop_iteration_add, review_loop_status, review_loop_close, and review_loop_policy_show are registered and schema-validated.
- mutating commands are story-scoped metadata writes and read-only commands remain L0.
- no command includes productionDone, authorityChanged, receiptVerified, receiptRefs, or host execution behavior.

## CHK-003: Integrate active loop blocking with REVIEW gate and status surfaces

**Owner**: koala-implementer (Claude CLI host B), supervised by main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/machine.ts, packages/main/src/handlers/phase-gates.ts, packages/main/src/handlers/session.ts
- Create: none
- Test: packages/main/src/tasks/review-loop-smoke.ts, packages/main/tests/fixtures/phase-gate-protocol.json

**Verify**:
- `npm --prefix packages/main run test:review-loop-smoke` proves an open latest ReviewLoopRecord blocks REVIEW -> TEST.
- `koala session_brief` or `review_loop_status` surfaces active loop next action.
- Existing reviewer/finding/validation gates still run after a resolved loop close.

**DoneWhen**:
- active open loop produces a clear Cannot enter TEST gate failure.
- resolved close only clears the loop gate when trigger refs are resolved or superseded at the current material hash.
- blocked/escalated close does not unblock underlying finding, bug, scope, or validation gates.

## CHK-004: Add focused contract and smoke tests

**Owner**: main-agent with Claude/Codex review
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: package.json, packages/main/package.json, scripts/verify-process-fact-contract.mjs
- Create: packages/main/src/tasks/review-loop-smoke.ts
- Test: packages/main/src/tasks/review-loop-smoke.ts, scripts/verify-process-fact-contract.mjs

**Verify**:
- `npm --prefix packages/main run test:review-loop-smoke` passes.
- `node scripts/verify-process-fact-contract.mjs` passes.
- `npm --prefix packages/main run build` passes.

**DoneWhen**:
- policy priority, open-loop gate blocking, close invariants, JSON command shape, and host-neutral no-authority behavior are covered.
- tests are scoped to correctness and do not assert cosmetic wording beyond required user-visible gate text.

## CHK-005: Run multi-host implementation review and record evidence

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Modify: none
- Create: none
- Test: manual host review transcripts and verificationEvidence records

**Verify**:
- Claude CLI host A reviews data model/storage.
- Claude CLI host B reviews gate/process-fact/host-neutral boundary.
- Codex CLI reviews executable consistency and command reality.

**DoneWhen**:
- unresolved must-fix correctness issues from hosts are fixed.
- advisory-only optimization suggestions are not implemented unless tied to correctness.
- checklist verificationEvidence records the host review commands/results and final test commands.
