# Plan: B-c004 Complete Remaining Control-Plane and Proof Capability Gaps

Execution principle: close exactly the seven accepted milestone rows. Each row starts with audit/red or diagnostic evidence, then either implementation, already-covered proof, or explicit retirement/non-goal documentation. Authority Server runtime/conformance must not be reintroduced.

## CHK-001: Freeze the seven-capability ledger and coverage audit

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md, docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md
- Create: docs/requirements/decisions/control-plane-proof-capability-closure-audit.md
- Test: packages/main/src/tasks/lifecycle-control-smoke.ts, packages/main/src/tasks/proof-admissibility-hardening-smoke.ts

**Verify**:
- `node bin/lattice.js intent_coverage_check --storyId=B-c004 --dryRun --mode=warn --json` returns status pass.
- `node bin/lattice.js proofstory_gate_check --storyId=B-c004 --dryRun --mode=warn --json` returns status pass.
- Audit document lists all seven rows with status, evidence target, and action.

**DoneWhen**:
- The audit table contains M1-M7 exactly once.
- Every row is classified as implemented, already-covered, missing-to-implement, or retired/non-goal.
- No row can be marked done without evidence references.

## CHK-002: Retire active Authority Server future backlog language

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md, docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md, docs/requirements/decisions/authority-server-vocabulary-retirement.md, packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts
- Create: none
- Test: packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts

**Verify**:
- `node packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts` passes.
- `rg -n "Authority Server conformance|Authority production|server-backed production receipt parity" docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md` returns no active-future backlog language.

**DoneWhen**:
- Authority Server terms in the two referenced plans are retired/legacy-only or local/shadow compatibility wording.
- No active future milestone asks to rebuild Authority Server conformance.
- Compatibility constants such as consumer names remain only where tests prove they are required.

## CHK-003: Resolve Tier-C cleanup policy

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/lifecycle-control/control-status.ts, packages/main/src/core/lifecycle-control/queue/index.ts, packages/main/src/tasks/lifecycle-control-smoke.ts, docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md
- Create: none
- Test: packages/main/src/tasks/lifecycle-control-smoke.ts

**Verify**:
- `node packages/main/src/tasks/lifecycle-control-smoke.ts` passes.
- Tier-C experiment batches are preserved by policy or the row is explicitly retired as non-goal.
- Spoofed or malformed Tier-C-like rows remain cleanup-required.

**DoneWhen**:
- The control-plane capability row no longer implies unfinished automatic cleanup unless it is intentionally retained as a non-goal.
- Tests prove valid Tier-C experiment evidence is preserved.
- Tests prove malformed rows do not hide behind the Tier-C exception.

## CHK-004: Resolve append-only admissibility ledger capability

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/evidence/admissibility/index.ts, packages/main/src/core/lifecycle-control/consumption/index.ts, packages/main/src/core/proof-admissibility.ts, packages/main/src/core/proof-admissibility-gates.ts, packages/main/src/core/config.ts, packages/main/src/tasks/proof-admissibility-hardening-smoke.ts, docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md
- Create: none unless implementation requires a new admissibility ledger helper under packages/main/src/core/evidence/admissibility
- Test: packages/main/src/tasks/proof-admissibility-hardening-smoke.ts

**Verify**:
- `node packages/main/src/tasks/proof-admissibility-hardening-smoke.ts` passes.
- If implemented, ledger writes are append-only and durable under the configured evidence root.
- If retired, docs and tests prevent diagnostic waterline output from claiming durable ledger support.

**DoneWhen**:
- The row is resolved as implemented or formally retired/non-goal.
- No waterline or gate output overclaims append-only ledger storage when absent.
- Proof consumers cannot overwrite or forge ledger rows if a ledger is implemented.

## CHK-005: Complete queue cleanup enforcement guard

**Owner**: main-agent
**DependsOn**: CHK-003
**Files**:
- Modify: packages/main/src/core/lifecycle-control/queue/index.ts, packages/main/src/core/lifecycle-control/control-status.ts, packages/main/src/tasks/lifecycle-control-smoke.ts, docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md
- Create: none
- Test: packages/main/src/tasks/lifecycle-control-smoke.ts

**Verify**:
- `node packages/main/src/tasks/lifecycle-control-smoke.ts` passes.
- Duplicate/superseded cleanup classifications are guarded and cannot delete Tier-C experiment evidence.
- Cleanup-required rows remain visible to the operator.

**DoneWhen**:
- Queue cleanup enforcement behavior is tested or explicitly bounded as non-mutating governance.
- Tier-C experiment exception remains preserved.
- Spoofed queue rows cannot bypass cleanup-required classification.

## CHK-006: Complete runtime closure enforce rollout

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/lifecycle-control/runtime/index.ts, packages/main/src/handlers/transition-orchestrator.ts, packages/main/src/tasks/lifecycle-control-smoke.ts, docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md
- Create: none
- Test: packages/main/src/tasks/lifecycle-control-smoke.ts

**Verify**:
- `node packages/main/src/tasks/lifecycle-control-smoke.ts` passes.
- warn mode remains diagnostic and does not overclaim blocking.
- enforce mode blocks unsafe runtime closure findings and reports rollback to `lifecycleControl.runtimeEnforcement=warn`.

**DoneWhen**:
- Runtime closure status accurately reports warn/enforce/unavailable behavior.
- Docs state whether default config is warn or enforce.
- Unsafe wrong cwd, stale lock, dirty tree, and worktree-authority drift are represented by tests or explicit non-goal boundaries.

## CHK-007: Complete CommandSpec envelope and project waterline coverage

**Owner**: main-agent
**DependsOn**: CHK-004, CHK-006
**Files**:
- Modify: packages/main/src/core/evidence/types.ts, packages/main/src/core/repro-intake.ts, packages/main/src/core/lifecycle-control/consumption/index.ts, packages/main/src/core/lifecycle-control/dashboard/index.ts, packages/main/src/core/proof-admissibility.ts, packages/main/src/core/proof-admissibility-gates.ts, packages/main/src/core/config.ts, packages/main/src/cli/command-catalog.ts, packages/main/src/tasks/proof-admissibility-hardening-smoke.ts, packages/main/src/tasks/lifecycle-control-smoke.ts, docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md, docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md
- Create: none unless implementation needs a focused helper under packages/main/src/core/evidence
- Test: packages/main/src/tasks/proof-admissibility-hardening-smoke.ts, packages/main/src/tasks/lifecycle-control-smoke.ts

**Verify**:
- `node packages/main/src/tasks/proof-admissibility-hardening-smoke.ts` passes.
- `node packages/main/src/tasks/lifecycle-control-smoke.ts` passes.
- Project-level consumption waterline distinguishes unknown/no-data from green/pass.
- High-risk command-backed evidence either carries CommandSpec or is explicitly non-goal/diagnostic.

**DoneWhen**:
- CommandSpec envelope adoption gaps are covered by tests or explicit non-goal docs.
- Project waterline rollup reports real aggregate state and does not promote diagnostic output to proof authority.
- The final seven-row table has evidence for M1-M7 and B-c004 passes validation/DONE gates.
