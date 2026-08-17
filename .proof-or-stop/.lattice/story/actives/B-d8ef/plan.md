# Plan: B-d8ef Probe canonical host execution readiness and observable launchers

Rollback path: revert the B-d8ef implementation commits before DONE, or remove readiness gating from degraded fallback while keeping legacy version-only probe rows readable. No token values, raw transcripts, or auth profile contents may be persisted.

## CHK-001: Record canonical noninteractive launcher readiness per review host

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/review-escalation.ts, packages/main/src/handlers/review-escalation.ts, packages/main/src/core/types.ts, packages/main/src/cli/command-catalog.ts, packages/main/src/core/process-fact-levels.ts, packages/main/src/core/process-fact-registry.ts
- Create: packages/main/src/core/host-execution-readiness.ts
- Test: packages/main/src/tasks/review-host-execution-readiness-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/review-host-execution-readiness-smoke.js` prints `PASS claude launcher uses --print --verbose --output-format stream-json`, `PASS agy --prompt-file classified wrong_launcher`, and `PASS codex exec token_invalidated classified auth`.
- `lattice review_host_availability_probe --storyId=B-d8ef --json` emits codex, claude-code, and agy rows with `executionReady`, `reviewReady`, `progressMode`, `failureKind`, `firstProgressMs`, and `durationMs` without raw transcript text.

**DoneWhen**:
- Canonical host rows separate binary/version availability from launcher execution readiness.
- `reviewReadyHostCount` is derived from row-level `reviewReady=true` only and rejects contradictory counts.
- Retired completion fields remain false for backward-readable records.

## CHK-002: Use execution-ready host counts for degraded fallback and host dispatch diagnostics

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/review-escalation.ts, packages/main/src/core/review-assurance-floor.ts, packages/main/src/core/lattice-dispatch.ts, packages/main/src/core/command-policy.ts
- Create: none
- Test: packages/main/src/tasks/review-escalation-smoke.ts, packages/main/src/tasks/review-assurance-floor-smoke.ts, packages/main/src/tasks/dispatch-run-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/review-escalation-smoke.js` prints a PASS for degraded fallback requiring fresh `reviewReadyHostCount < 2`.
- `node packages/main/dist/tasks/review-assurance-floor-smoke.js` prints a PASS for refusing `single-host-environment` when two review-ready hosts exist.
- `node packages/main/dist/tasks/dispatch-run-smoke.js` prints a PASS for canonical Claude/agy launcher diagnostics.

**DoneWhen**:
- Non-human degraded fallback refuses `single-host-environment` / temporary host unavailability when at least two independent hosts are review-ready.
- Legacy B-7438 version-only probes do not satisfy the stronger readiness proof and tell the operator to rerun `review_host_availability_probe` or use explicit-human-approval.
- Diagnostics name concrete causes such as auth, wrong_launcher, timeout, or silent-final-output.

## CHK-003: Cover Claude stream-json verbose, Codex exec auth, and agy print launcher with smoke tests

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/review-escalation-smoke.ts, packages/main/src/tasks/review-assurance-floor-smoke.ts, packages/main/src/tasks/dispatch-run-smoke.ts, packages/main/src/tasks/command-catalog-smoke.ts, packages/main/src/providers/claude-cli.ts, packages/main/src/providers/codex-cli.ts
- Create: packages/main/src/tasks/review-host-execution-readiness-smoke.ts
- Test: packages/main/src/tasks/review-host-execution-readiness-smoke.ts, scripts/verify-process-fact-contract.mjs

**Verify**:
- `node packages/main/dist/tasks/review-host-execution-readiness-smoke.js` prints `PASS claude launcher uses --print --verbose --output-format stream-json`, `PASS agy --prompt-file classified wrong_launcher`, and `PASS codex exec token_invalidated classified auth`.
- `node packages/main/dist/tasks/command-catalog-smoke.js` prints a PASS for `review_host_availability_probe` exposing readiness fields and for launcher diagnostics being command-catalog visible.
- `node scripts/verify-process-fact-contract.mjs` passes.

**DoneWhen**:
- Claude reviewer launcher is modeled as `claude --print --verbose --output-format stream-json`, not plain final-output `--print` for long reviewer work.
- agy `--prompt-file` is mechanically classified as wrong_launcher and canonical agy uses `--print` plus `--print-timeout`.
- Codex `--version` or login presence is not enough; `codex exec` auth failures such as token_invalidated or refresh_token_invalidated classify as auth and are not review-ready.
