# B-99d4 Plan

## Goal

Add a role-aware worker reassignment path for completed dispatch/worker work. The follow-up worker uses a fresh bounded context, explicit instructions, and the requested worker role rather than relying on a full-history fork.

## Non-Goals

- Do not implement long-term worker memory.
- Do not inherit the full parent conversation history.
- Do not change receipt verification, authority, merge, DONE, or production readiness semantics.

## CHK-001

**Owner**: main-agent

**Promise**: The operator can run a follow-up worker reassignment command and see `Worker reassignment ready`, `mode: fresh-context`, the previous dispatch id, the new dispatch id, the requested role, and the prompt file.

**Files**: `packages/main/src/core/lattice-dispatch.ts`, `packages/main/src/handlers/lattice-dispatch.ts`, `packages/main/src/cli/command-catalog.ts`, `packages/main/src/cli/alias-normalizer.ts`, `packages/main/src/core/config.ts`, `packages/main/src/core/command-policy.ts`, `packages/main/src/core/process-fact-levels.ts`, `packages/main/src/tasks/dispatch-run-smoke.ts`.

**Plan**:
- Add a `dispatch_reassign` command that takes a completed/prior `dispatchId`, optional `role`, follow-up `objective`, explicit `executionInstructions`, and normal dispatch constraints.
- Create a new dispatch id by default and keep the prior dispatch immutable.
- Store lineage via `parentDispatchId` on the new dispatch record.
- Render a concise reassign result that makes the role and fresh-context mode visible.

**Verify**:
- `CHK-001:happy:0`: smoke creates a prior dispatch, runs `dispatch_reassign` with `role=lattice-implementer`, and asserts output/result fields include previous id, new id, fresh-context mode, role, and promptFile.
- `CHK-001:edge:0`: smoke covers omitted role and confirms the default worker role is used explicitly.
- `CHK-001:adversarial:0`: smoke asserts the prior dispatch record is not overwritten and the new record has `parentDispatchId` set to the prior id.

## CHK-002

**Owner**: main-agent

**Promise**: The generated prompt says continuity is summary-only fresh context, references the previous dispatch, carries explicit follow-up instructions, and does not imply full conversation history inheritance.

**Files**: `packages/main/src/core/lattice-dispatch.ts`, `packages/main/src/handlers/lattice-dispatch.ts`, `packages/main/src/cli/command-catalog.ts`, `packages/main/src/tasks/dispatch-run-smoke.ts`.

**Plan**:
- Make dispatch prompt material role-aware by rendering role and objective that already exist in the handoff pack.
- Add a follow-up continuity block for reassignment prompts: previous dispatch id, fresh-context mode, and explicit prior-summary/follow-up instructions.
- Keep continuity wording conservative: summary/instruction based only, no inherited memory claim.

**Verify**:
- `CHK-002:happy:0`: inspect the follow-up prompt and assert role, objective, explicit instructions, and previous-dispatch continuity are present.
- `CHK-002:edge:0`: prior dispatch without receipt/transcript summary still renders bounded lineage rather than claiming hidden memory.
- `CHK-002:adversarial:0`: prompt and command output do not claim full-history inheritance, receipt verification, release readiness, or production DONE.

## CHK-003

**Owner**: main-agent

**Promise**: Verification passes for role propagation, fresh-context prompt wording, parentDispatchId lineage, existing dispatch_resume behavior, and process-fact registration.

**Files**: `scripts/verify-process-fact-contract.mjs`, `packages/main/src/tasks/dispatch-run-smoke.ts`, `packages/main/src/tasks/unattended-dispatch-smoke.ts`.

**Plan**:
- Extend dispatch smoke coverage for `dispatch_reassign`.
- Keep `dispatch_resume` regression coverage so resume remains same-dispatch recovery/rerun.
- Register `dispatch_reassign` as L1 diagnostic dispatch metadata in command policy, phase tools, and process-fact levels, with no gate-evidence or authority semantics.

**Verify**:
- `CHK-003:happy:0`: smoke proves completed fake worker reassignment with explicit role/instructions.
- `CHK-003:edge:0`: smoke proves `dispatch_resume` does not silently create a reassignment.
- `CHK-003:adversarial:0`: `node scripts/verify-process-fact-contract.mjs` passes with `dispatch_reassign` recognized as diagnostic-only L1 process fact.
