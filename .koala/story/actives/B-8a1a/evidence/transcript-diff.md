# Transcript Diff - B-8a1a

Date: `2026-06-04`

## Expected

The story plan expected Lattice CLI to support a Claude Code first real-host unattended runner:

- `dispatch_auto --host=claude-code` may launch a real subprocess only when a dispatch policy explicitly sets `allowRealHostSubprocess=true`.
- The canonical launcher must be policy-bound by `commandAllowlist=["claude --print <prompt-file>"]`.
- Execution must happen in the isolated dispatch worktree with a filtered environment and bounded timeout.
- `dispatch_status`, `dispatch_watch`, `dispatch_review`, and `dispatch_merge_plan` must expose runner evidence while keeping `authorityChanged=false`, `receiptVerified=false`, `productionDone=false`, and `manualOnly=true`.
- Gemini and Codex real subprocess execution must remain scaffolded/refused in this version.

## Actual

Validation and smoke tests passed:

```text
npm --prefix packages/main run build
npm --prefix packages/utils run build
npm --prefix packages/main run test:unattended-dispatch-smoke
npm --prefix packages/main run test:dispatch-run-smoke
node bin/lattice.js validate --story=B-8a1a --json
```

Observed highlights:

- `unattended-dispatch-smoke` passed policy check, Claude capability probe, fake Claude success/env/nonzero/timeout coverage, dispatch watch/cancel/review/merge evidence, policy refusal paths, env filtering, mixed worker diagnostics, and authority invariants.
- `dispatch-run-smoke` passed runtime probes, overflow gating, fake/scaffold paths, receipt handling, manual merge guidance, dispatch policy contract, scheduler controls, and real-host unattended capability contract.
- `validate` passed with verification intent coverage `15/15 covered` and no required missing coverage.
- The CLI canary artifact records `runnerKind=claude-code-real`, `changedFiles=["packages/main/src/generated/cli-claude.txt"]`, `manualOnly=true`, `authorityChanged=false`, `receiptVerified=false`, and `productionDone=false`.
- The negative canary confirms a policy missing `claude --print <prompt-file>` in `commandAllowlist` is refused before dispatch record creation.

## Diff

The implementation matches the expected contract. The only intentional testing difference is provider substitution: the canary uses a fake `claude` executable on `PATH` while exercising the real `packages/main/dist/cli.js` dispatch flow. This avoids spending user Claude quota while still verifying subprocess launch, transcript capture, policy enforcement, changed-file scope, and authority-safe review/merge behavior.

Live Claude Code execution is therefore enabled by the policy-bound runner, but this delivery evidence treats deterministic fake-provider CLI execution as the auditable TEST artifact.
