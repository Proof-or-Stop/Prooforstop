# B-5cdc Plan

## Story Goal

Implement the first explicit headless authority runner slice for Lattice CLI:

- a manually invoked enforce runner command with once/dry-run behavior
- bounded fake-provider job execution for tests
- signed provider event submission tied to claimed job/run identity
- mechanical smokes proving ordinary local lifecycle commands remain unaffected

This story does not wire real Claude Code, Codex, Gemini, or production Python authority deployment behavior.

## CHK-001: Explicit Authority Enforce Runner Command

### Implementation

- Add an explicit command surface for `authority_enforce_runner`.
- Accept `--once`, `--dry-run`, and `--json`.
- Resolve authority mode/config, runner id, actor key presence, and session readiness.
- In dry-run, project planned steps only:
  - `register_runner`
  - `runner_heartbeat`
  - `claim_job`
  - `spawned:false`
  - `providerEvents:[]`
- Fail inside the runner command when enforce prerequisites are missing, while leaving ordinary local lifecycle commands usable.

### Verification

- Smoke dry-run output and confirm no fake server mutation/provider execution occurs.
- Smoke missing URL/actor key failure message.
- Adversarial smoke that `story_advance` / `verification_evidence_add` do not invoke runner paths.

## CHK-002: Fake-Provider Job Execution And Provider Events

### Implementation

- Add a bounded runner execution helper for controlled fake/local jobs.
- Execute only a claimed, allowed fake job in once mode.
- Hash stdout/stderr transcript and emit signed provider events:
  - `stdout_delta`
  - `stderr_delta` when applicable
  - `completed` with `exitCode:0`
  - `failed` for non-zero exit
- Reject unleased/mismatched provider/run/job identities before evidence submission.

### Verification

- Smoke a successful fake job and assert `stdout_delta`, `completed`, and `transcriptHash`.
- Smoke a failing fake job and assert `failed` with non-zero exit.
- Adversarial fake server/client case rejects unleased or mismatched provider/run IDs.

## Scope

Allowed implementation touchpoints are limited to authority runner command handling, authority client/contracts/signing helpers, focused runner smokes, package scripts, and the authority-client-role decision doc if wording needs to be synchronized.

Out of scope:

- real provider CLI adapters
- production Python deployment logic
- persistent secure actor key storage
- host overflow / B-aa98 assets
- lab, desktop, and package-desktop assets

## Acceptance Transcript

Expected user-facing transcript:

```text
lattice authority_enforce_runner --once --dry-run --json
{
  "mode": "enforce",
  "dryRun": true,
  "once": true,
  "plannedSteps": ["register_runner", "runner_heartbeat", "claim_job"],
  "spawned": false,
  "providerEvents": []
}

npm run test:authority-enforce-runner
✓ authority enforce runner smoke passed: dry-run planned register/heartbeat/claim without provider execution

npm run test:authority-runner-events
✓ authority runner events smoke passed: stdout/completed/failed events are signed and transcript-bound
```
