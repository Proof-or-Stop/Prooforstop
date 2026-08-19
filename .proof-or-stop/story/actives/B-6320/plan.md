# Plan: B-6320 Support host-neutral Authority runner provider declarations

## CHK-001: Parse and preserve Authority runner provider declaration as host-neutral metadata

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/authority-mode.ts, packages/main/src/handlers/lattice-cli.ts
- Create: none
- Test: packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-status-smoke.ts, packages/main/src/tasks/authority-enforce-runner-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:authority-client`
- `npm --prefix packages/main run test:authority-status`
- `npm --prefix packages/main run test:authority-enforce-runner`

**DoneWhen**:
- `LATTICE_AUTHORITY_RUNNER_PROVIDER=codex-cli` and `antigravity` are accepted as valid host-neutral declarations.
- Missing provider still defaults to `codex`.
- Existing `claude` / `CLAUDE_CODE` compatibility still normalizes to `claude-code`.
- Custom declarations do not make `productionDone`, `receiptVerified`, or Authority readiness true by themselves.

## CHK-002: Propagate provider declaration through register, heartbeat, SSE watch, claim, and takeover diagnostics

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/authority-runner.ts, packages/main/src/core/authority-job-loop-live.ts, packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/authority-client.ts, packages/main/src/handlers/verdict.ts, packages/main/src/cli/command-catalog.ts, docs/requirements/decisions/lattice-authority-live-integration.md, docs/requirements/decisions/authority-runner-session-evidence-envelope.md
- Create: none
- Test: packages/main/src/tasks/authority-runner-client-smoke.ts, packages/main/src/tasks/authority-job-loop-live-smoke.ts, packages/main/src/tasks/authority-enforce-runner-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:authority-runner-client`
- `npm --prefix packages/main run test:authority-job-loop-live`
- `npm --prefix packages/main run test:authority-enforce-runner`

**DoneWhen**:
- Actor-key registration, runner registration, heartbeat, and signed claim payloads carry the same declared provider string.
- `authority_job_create` no longer rejects a non-enum provider locally before the Authority Server can evaluate policy.
- `jobs.available` SSE is documented and tested as the streaming hint for the same availability/claim contract, not a second interface with separate provider semantics.
- Ownership still requires a signed claim accepted by the server.

## CHK-003: Add focused regression tests for non-enum Authority provider declarations

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-status-smoke.ts, packages/main/src/tasks/authority-enforce-runner-smoke.ts, packages/main/src/tasks/authority-runner-client-smoke.ts, packages/main/src/tasks/authority-job-loop-live-smoke.ts
- Create: none
- Test: packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-status-smoke.ts, packages/main/src/tasks/authority-enforce-runner-smoke.ts, packages/main/src/tasks/authority-runner-client-smoke.ts, packages/main/src/tasks/authority-job-loop-live-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:authority-client`
- `npm --prefix packages/main run test:authority-status`
- `npm --prefix packages/main run test:authority-enforce-runner`
- `npm --prefix packages/main run test:authority-runner-client`
- `npm --prefix packages/main run test:authority-job-loop-live`
- `npm --prefix packages/main run build`

**DoneWhen**:
- Focused smoke coverage proves arbitrary provider declarations are accepted and propagated.
- Existing `codex`, `claude`, and Antigravity-adjacent behavior remains compatible.
- Tests explicitly cover that provider declaration acceptance does not bypass credentials, signatures, leases, or server policy.
