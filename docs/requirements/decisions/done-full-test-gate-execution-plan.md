# DONE Full-Test Gate Execution Plan

## Problem Statement

The verified gap is that the local DONE gate currently consumes evidence produced by `proof-or-stop validate`, and `proof-or-stop validate` runs the configured validation subset when `validate.commands` exists. A root full `npm test` failure can therefore sit outside the configured validation subset and still be invisible to local DONE, allowing a story to merge locally if every configured `validate.commands` entry passes.

Important caveat: this proves a gate coverage gap, not that current main `npm test` is red. The claim is about what the current gate is capable of proving. It does not assert a live root-suite failure on `main`.

## Current Evidence Anchors

- `proof-or-stop.config.json` defines 8 entries under `validate.commands` at `validate.commands[0..7]`.
- Root `package.json` defines `scripts.test` as the resource-aware full-suite runner. Canonical membership is independently derived from `test:serial-reference-prefix` plus `test:serial-reference`; the current authority contains 47 members and bidirectional inventory validation rejects missing, duplicate, stale-policy, or later unclassified members.
- `packages/main/src/handlers/verifier.ts` reads configured `validate.command` / `validate.commands` first. When configured commands exist, fallback discovery is skipped, so the fallback `npm test` path is not used for this repository.
- `packages/main/src/handlers/phase-gates.ts` runs `proof-or-stop validate --story=<storyId> --json` when entering TEST and writes the result to `test-evidence.json`.
- `packages/main/src/core/done-oracle.ts` builds the DONE row from `test-evidence.json`, including result and freshness, and does not independently require root full-suite evidence.
- `.githooks/pre-push` does not run root `npm test`. Its build plus recursive `tsc --noEmit` path is scoped to the self-host package name `@proof-or-stop/core`; it is a type/build push guard, not the root full-suite gate.

Together these anchors explain why ordinary validation and DONE-required assurance remain separate surfaces. The implemented self-host DONE-required policy now builds the runtime and executes the complete 47-member canonical root suite through the resource-aware parallel runner; its receipt is independently freshness-bound and consumed by DONE. Pre-push remains a narrower surface and must not be described as equivalent full-suite assurance.

## Scope For This Story

The original B-3321 story was documentation-only. Subsequent implementation stories delivered the DONE-required policy and B-9812 replaced the obsolete serial root chain with the complete resource-aware parallel runner. This document now records that implemented state; it is not a claim that B-3321 itself changed runtime code.

## Chosen Solution

Add a dedicated DONE/release-required validation profile, or an equivalent `doneRequiredCommands` configuration surface, with fresh hash-bound evidence consumed by DONE. Do not simply append `npm test` to ordinary `validate.commands`.

Implementation boundary after B-ac25: the local DONE-required surface is `doneRequiredCommands` / `validationProfiles.done` plus `done_required_validate --storyId=<id>`, which writes `.proof-or-stop/story/actives/<storyId>/done-required-evidence.json`. The DONE oracle consumes this in a separate `done-required-validation` row. Missing policy remains advisory/non-blocking for external projects and must not be described as full-suite assurance.

Execution-capacity boundary: `proof-or-stop done_required_validate`, every `proof-or-stop validate` mode, and derived host-verdict binding share one capacity lease under the resolved workspace git-common-dir, not a metadata wrapper. Expected Git identity failure—including an unresolved configured no-story `gitRoot`—stops before callback entry rather than splitting the lock. Contenders wait asynchronously with `waiting for workspace validation capacity` holder/heartbeat progress and then continue automatically; story-scoped runs acquire capacity before the per-story evidence lock. Both capacity and story-lock reentrancy require the current acquisition token, preventing a detached context from an earlier owner from borrowing a later holder's identical path. Complete identity is prepared before atomic queue publication. The capacity classifier never reclaims on age, unknown ownership, or malformed metadata alone. Mechanically stale ownership is isolated by atomically renaming its never-reused UUID ticket to a unique quarantine and deleting only that quarantine, so stale-A cleanup cannot delete live successor-B. Owner release and queued-waiter abort/deadline cleanup retry exact-ticket isolation. Persistent failure attempts a best-effort released marker on that unique ticket; marker success allows mechanical recovery after filesystem repair, while marker failure remains fail-closed until repair. A successful callback reports release failure. An original callback, abort, or deadline error remains primary and the secondary cleanup failure is not separately surfaced. Direct `proof-or-stop validate` enters the structured watchdog only to propagate abort/deadline into the capacity wait and clean its waiter ticket; it keeps the pre-existing `validate` result classification and exit contract. `structuredDoneResult` and the DONE-result classifier remain exclusive to `done_prepare` / `done_required_validate`. Derived host-verdict binding has no public cancellation arguments and continues to rely on its CLI host timeout as the outer boundary. A bare `npm test` / direct full-suite command remains outside this lease and must not be launched concurrently with either official command. This coordination adds no timeout, inventory, receipt, freshness, or gate-policy exception.

The checked-in regression/evidence contract contains a genuine exact-12 child-process stale/ABA cohort, separate from the exact-12 same-process Promise cohort, and proves `maxConcurrency=1`, zero overlap, zero child errors, and zero queue-artifact leaks. It is not a runtime capacity promise to users. Its exact managed terminal pins are focused `validate-execution-lock workspace capacity contract passed: 15 assertion groups` and full `validate-execution-lock smoke passed: 26 assertion groups`.

Reasons:

- Normal `proof-or-stop validate` is used during DEV/TEST iteration and should remain configurable for fast feedback.
- Root full `npm test` is self-host expensive and should not be forced onto every Proof-or-Stop user by default.
- DONE/release assurance needs a stronger evidence contract than "the normal validation subset happened to pass".
- A named DONE-required profile makes the claim explicit: self-host DONE is blocked unless the full required suite has fresh PASS evidence for the current material.
- Release/push alignment can then decide whether to reuse the same artifact, require it before remote publish approval, or keep remote push as a narrower build+tsc safety net with clear wording.

Recommended configuration shape:

```json
{
  "validationProfiles": {
    "default": {
      "commands": []
    },
    "done": {
      "required": true,
      "commands": [
        { "command": "npm", "args": ["--prefix", "packages/main", "run", "build"], "timeoutMs": 600000, "providesBuildProof": "packages-main-build" },
        { "command": "npm", "args": ["test"], "timeoutMs": 1200000, "requiresBuildProof": "packages-main-build" }
      ]
    }
  }
}
```

Equivalent acceptable shape:

```json
{
  "doneRequiredCommands": [
    { "command": "npm", "args": ["--prefix", "packages/main", "run", "build"], "timeoutMs": 600000, "providesBuildProof": "packages-main-build" },
    { "command": "npm", "args": ["test"], "timeoutMs": 1200000, "requiresBuildProof": "packages-main-build" }
  ]
}
```

The exact schema can differ, but the behavior must preserve the distinction between routine validation and DONE/release-required validation. The `packages-main-build` proof is a self-host policy requirement that must be explicitly enabled on the command that needs it. External projects that opt into `doneRequiredCommands: [{ "command": "npm", "args": ["test"] }]` do not inherit this rule. Because this repository's root tests execute built `packages/main/dist` tasks and `dist` is untracked, the self-host DONE-required proof must include a fresh `npm --prefix packages/main run build` receipt before the root `npm test`, or a root `pretest` / equivalent receipt proving the build output matches the same `headHash` and `materialHash`.

## External Project Behavior

The full-suite gate must be opt-in and configurable for external projects.

Default behavior for projects without a DONE-required policy:

- Existing `proof-or-stop validate` behavior remains unchanged.
- DONE may show an advisory row such as "No DONE-required validation profile configured".
- The advisory row must not block by default.
- Documentation must explain how projects opt into a blocking full-suite policy.

Self-host behavior for Orchestrate/Proof-or-Stop:

- Configure a fresh package build plus the root full `npm test` chain, or a semantically equivalent full-suite command whose receipt proves current `packages/main/dist` output, as DONE-required.
- Missing, failing, or stale DONE-required evidence blocks local DONE.
- A degraded or emergency path may continue only under an explicitly lower assurance label.

This avoids imposing Orchestrate-specific cost on every Proof-or-Stop user while fixing the self-host overclaim.

## Evidence Data Model

The implementation persists a separate evidence artifact from ordinary `test-evidence.json`:

- `.proof-or-stop/story/actives/<storyId>/done-required-evidence.json`

Each required command receipt should include:

```json
{
  "schema": "lattice.done-required-evidence.v1",
  "storyId": "B-xxxx",
  "policy": "self-host-done-required",
  "profile": "done",
  "status": "PASS",
  "startedAt": "2026-06-20T00:00:00.000Z",
  "finishedAt": "2026-06-20T00:00:00.000Z",
  "durationMs": 0,
  "headHash": "<git HEAD SHA>",
  "materialHash": "<material hash used by DONE freshness>",
  "storyFilesHash": "<story files hash used by DONE freshness>",
  "commands": [
    {
      "id": "packages-main-build",
      "label": "packages/main build",
      "command": "npm",
      "args": ["--prefix", "packages/main", "run", "build"],
      "cwd": ".",
      "status": "PASS",
      "exitCode": 0,
      "durationMs": 0,
      "outputDigest": "sha256:<digest>",
      "outputTail": "<bounded final output tail>",
      "startedAt": "2026-06-20T00:00:00.000Z",
      "finishedAt": "2026-06-20T00:00:00.000Z"
    },
    {
      "id": "root-npm-test",
      "label": "root npm test",
      "command": "npm",
      "args": ["test"],
      "cwd": ".",
      "status": "PASS",
      "exitCode": 0,
      "durationMs": 0,
      "outputDigest": "sha256:<digest>",
      "outputTail": "<bounded final output tail>",
      "startedAt": "2026-06-20T00:00:00.000Z",
      "finishedAt": "2026-06-20T00:00:00.000Z"
    }
  ],
  "freshness": {
    "fresh": true,
    "staleReason": null
  }
}
```

Data requirements:

- Command receipts record command, args, cwd, status, exit code, duration, and bounded output tail.
- DONE evaluation requires receipts to cover effective policy commands exactly in order and match command, args, cwd, and shell identity.
- Output digest stores enough identity to compare logs without storing unbounded output.
- Overall status is PASS only when every required command PASSes.
- Evidence binds to `headHash`, `materialHash`, and `storyFilesHash`.
- For Orchestrate/Proof-or-Stop self-host, evidence must prove `packages/main/dist` freshness for the same material before root `npm test`, either by an explicit `npm --prefix packages/main run build` command receipt or by an equivalent root `pretest` / build receipt.
- Freshness checks produce an explicit stale reason, for example `head-changed`, `material-hash-mismatch`, `story-files-hash-mismatch`, `policy-hash-mismatch`, `command-set-changed`, or `artifact-missing`.
- The evidence records the effective policy/profile so a later config change cannot reuse an older receipt silently.

## Process Fact Contract

AGENTS/story-lifecycle process fact discipline requires gate-consumed facts to be protected by both prompt guidance and mechanical verification. The future implementation must register the new DONE-required gate evidence/artifact in:

- `packages/main/src/core/process-fact-registry.ts`
- `packages/main/src/core/process-fact-levels.ts`
- `scripts/verify-process-fact-contract.mjs`

Those updates are required because the new artifact affects DONE gate behavior, gate evidence freshness, and auditability. The process-fact contract must name the gate consumer, required semantics, artifact shape, and verification coverage for missing, failing, stale, and policy-drift cases.

## Gate Semantics

Self-host required policy:

- Missing DONE-required evidence blocks DONE.
- Failing DONE-required evidence blocks DONE.
- Stale DONE-required evidence blocks DONE.
- Material/story-files, command-set, or policy drift blocks DONE. For pre-run execution reuse, a different evidence HEAD is accepted only when it is an ancestor of current HEAD and every intervening path is trusted story metadata; exact HEAD also passes.
- Evidence for a command with `requiresBuildProof: "packages-main-build"` without a same-material build receipt, or equivalent proof of current `packages/main/dist`, blocks DONE for the self-host required policy.
- A skipped command in the required set is a failure unless the policy explicitly defines it as optional.
- The DONE checklist gets a dedicated row separate from ordinary `test-evidence`, for example `done-required-validation`.

Projects without a required policy:

- DONE does not block solely because no full-suite profile exists.
- The DONE checklist should render optional/advisory status so users know no full-suite guarantee was claimed.
- The product language must not imply root full-suite assurance when no required policy exists.

Emergency or degraded path:

- A degraded path cannot claim full assurance.
- If an emergency override is introduced, it must require explicit reason, actor, timestamp, and affected story, and it must render as degraded in DONE summary and release notes.
- Degraded evidence must not satisfy future checks that specifically require full-suite PASS evidence.

## Runner And Artifact State

1. `doneRequiredCommands` executes independently from ordinary `proof-or-stop validate`.
2. The self-host policy builds `packages/main` and then invokes root `npm test`.
3. Root `npm test` derives all 47 current canonical members from the independent serial reference, schedules compatible resource claims concurrently, preserves canonical report order, and stops on the first FAIL/TIMEOUT without retry masking.
4. The runner emits bounded member logs plus wall/CPU/resource/identity telemetry and an atomic out-of-tree JSON result.
   Runner-cleanable owned-path claims record pre-spawn existence/type/marker and
   must be absent before spawn. Cancellation removes only targets proven absent
   before launch that still carry the exact per-launch token inside approved
   runtime/lock roots; empty or missing/tampered-marker targets, symlinked/shared/
   out-of-bound targets, and all foreign residue are retained and fail closed.
5. DONE-required evidence binds command identity, output digest/tail, `headHash`, `materialHash`, and `storyFilesHash`; the DONE oracle consumes it separately from routine validation.
6. Release approval and pre-push remain separate assurance surfaces unless their own policy explicitly consumes this receipt.

## Milestones

### M1. Schema And Config

- Define `validationProfiles.done` or `doneRequiredCommands`.
- Define required, optional, timeout, cwd, env, shell, and label fields.
- Validate malformed entries with precise errors.
- Include policy hash / command-set hash in generated evidence.
- Model command ordering or dependency semantics so root `npm test` cannot satisfy self-host DONE without a same-material build receipt for `packages/main/dist`.

Exit criteria:

- Invalid config fails closed for projects that opt into required DONE validation.
- Projects without the field retain current behavior.
- Self-host config expresses `npm --prefix packages/main run build` before root `npm test`, or an equivalent root `pretest` / build receipt.

### M2. Runner And Artifact

- Implement a command runner for the DONE-required profile.
- Persist command receipts with bounded output.
- Mark overall status PASS only when all required commands PASS.
- Ensure execution failures produce a FAIL artifact when possible.
- Ensure commands that explicitly declare `requiresBuildProof: "packages-main-build"` are tied to a preceding same-material package build receipt, or to an equivalent root `pretest` / build receipt.

Exit criteria:

- A passing full-suite run writes fresh PASS evidence.
- A failing command writes FAIL evidence with output digest and tail.
- A self-host command that declares `requiresBuildProof: "packages-main-build"` cannot write full-assurance PASS evidence without current `packages/main/dist` proof.

### M3. DONE Oracle Row

- Add a `done-required-validation` row to DONE checklist assembly.
- For self-host required policy, fail on missing, failing, or stale evidence.
- For projects without policy, render optional/advisory status.
- Keep ordinary `test-evidence` row intact for `proof-or-stop validate`.
- Consume the registered process fact contract for the DONE-required artifact rather than relying on prose-only semantics.

Exit criteria:

- DONE is blocked when required full-suite evidence is absent, failed, or stale.
- DONE still shows ordinary validation separately.
- `packages/main/src/core/process-fact-registry.ts`, `packages/main/src/core/process-fact-levels.ts`, and `scripts/verify-process-fact-contract.mjs` cover the new DONE-required gate evidence.

### M4. Self-Host Config

- Configure Orchestrate/Proof-or-Stop self-host policy to require `npm --prefix packages/main run build` plus root `npm test`, with `requiresBuildProof: "packages-main-build"` on the root test command, or an equivalent full-suite command with a same-material build receipt.
- Pick a timeout high enough for the current root chain.
- Document the command cost and when to run it.

Exit criteria:

- Self-host DONE cannot pass with only the 8 configured `validate.commands` entries.
- Self-host DONE cannot pass with stale or missing `packages/main/dist` proof before any command that explicitly requires `packages-main-build` proof.

### M5. Docs

- Update lifecycle and validation docs to distinguish routine validation from DONE-required validation.
- Document external project opt-in behavior.
- Document degraded/emergency claim boundaries.

Exit criteria:

- A user can tell which command proves routine TEST readiness and which command proves full-suite DONE readiness.

### M6. Smoke Tests

- Add a smoke test where configured `validate.commands` pass but DONE-required `npm test` fails; DONE must block.
- Add a smoke test where DONE-required evidence is stale after a material change; DONE must block.
- Add a smoke test for external projects without required policy; DONE must be advisory, not blocked.
- Add a smoke test for command-set/policy drift; old evidence must become stale.

Exit criteria:

- The exact gap described in this document is covered by regression tests.

### M7. Migration

- Existing active stories get clear instructions when they attempt DONE without required evidence.
- Stories already DONE before this change are not retroactively reopened.
- In-flight stories after the change must run the DONE-required profile before DONE if the repository policy requires it.
- Migration output should name the command to run and the stale/missing reason.

Exit criteria:

- No silent policy transition: users see why DONE now requires the additional artifact.

### M8. Release And Push Alignment Decision

- Decide whether `release_approve_push --confirm` requires fresh DONE-required evidence.
- Decide whether `.githooks/pre-push` should merely check for the artifact, rerun the profile, fix/scope its self-host build+tsc boundary, or remain narrower.
- If pre-push stays narrower, document that the remote push hook is not a root full-suite gate; it provides build+tsc assurance for the `@proof-or-stop/core` self-host package boundary.
- B-ac25 does not implement release approval, pre-push, Authority production receipts, or emergency override behavior.

Exit criteria:

- Local DONE, release approval, and pre-push claims are consistent and do not overstate assurance.

## In-Flight Story Migration

When the implementation is present:

- Stories in INIT, INIT_CHECK, PLAN, DEV, or REVIEW do not need full-suite evidence until they approach TEST/DONE.
- Stories in TEST must run the DONE-required profile before advancing to DONE when the self-host policy is required.
- Stories already in DONE remain historical records and should not be mutated solely because the policy changed.
- If an in-flight story has valid ordinary `test-evidence.json` but no DONE-required artifact, the DONE checklist should fail only the new full-suite row and give a direct command hint.
- If an in-flight story has an artifact from an old command set, the stale reason should say `policy-hash-mismatch` or `command-set-changed`.

Rollback/de-escalation policy:

- If the new full-suite gate causes unacceptable false blocks, de-escalate by changing the self-host policy from required to advisory in config, not by deleting freshness checks.
- Any de-escalation must be visible in DONE output as lower assurance.
- Do not silently reinterpret stale or failed full-suite evidence as pass.
- Do not let emergency override evidence satisfy future full-assurance checks.

## Implementation Validation Commands

Implementation validation should run at least:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/done-required-validation-smoke.js
node scripts/verify-process-fact-contract.mjs
npm test
proof-or-stop validate --story=<storyId> --json
proof-or-stop story_advance '{"storyId":"<storyId>","phase":"DONE"}'
```

Expected artifacts:

- Ordinary validation still writes `test-evidence.json` from `proof-or-stop validate`.
- DONE-required validation writes the separate `done-required-evidence.json` artifact.
- DONE-required validation records `npm --prefix packages/main run build` before root `npm test`, or records a root `pretest` / equivalent receipt proving same-material `packages/main/dist`.
- The DONE checklist renders both ordinary validation and full-suite rows.
- A material change after full-suite PASS makes the full-suite row stale.
- A policy/command-set change after full-suite PASS makes the full-suite row stale.
- In the self-host repo, DONE without fresh build-plus-root-`npm test` evidence blocks.

Negative validation cases:

- Configure a fake failing command in the DONE-required profile and confirm DONE blocks even when normal `validate.commands` pass.
- Remove the DONE-required artifact and confirm DONE blocks under self-host required policy.
- Remove or stale the build receipt while leaving root `npm test` evidence present and confirm DONE blocks under self-host required policy.
- Run the same scenario in a fixture project without required policy and confirm the row is advisory.

## Required Future 3 Round / 2 Host Review

Because this plan affects lifecycle gate assurance and release claims, the future implementation must receive 3 distinct review rounds with 2 independent hosts per round over the final material hash.

Canonical host names:

- Codex CLI
- Claude Code CLI
- Antigravity CLI (`agy`)

Review requirements:

- Each round must bind to the final `headHash`, `materialHash`, and policy/command-set hash.
- Each round must include two independent hosts from the canonical host set.
- Host verdicts must be PASS, FAIL, or BLOCKED with concrete source/evidence references.
- A repaired blocker invalidates prior material-hash-bound PASS verdicts; rerun affected rounds over the new final material hash.
- A degraded single-host path cannot be labeled as 3 round / 2 host review.
- Deprecated third-host terminology must not be used for this workflow.

## Non-Goals

- Do not implement the runtime gate in B-3321.
- Do not modify root `package.json`, `proof-or-stop.config.json`, `.githooks/pre-push`, or runtime TypeScript in B-3321.
- Do not append root `npm test` to normal `validate.commands` as the final solution.
- Do not force root full-suite execution on external projects that have not opted in.
- Do not make the pre-push hook depend on Proof-or-Stop CLI as a hidden requirement.
- Do not claim root full-suite assurance from ordinary `test-evidence.json`.
- Do not store unbounded command output in story evidence.
- Do not reopen historical DONE stories solely for this new policy.

## STOP Conditions

Stop implementation and return to design review if any of these occur:

- The proposed schema cannot distinguish routine validation from DONE-required validation.
- The DONE gate cannot bind full-suite evidence to current `headHash`, `materialHash`, and `storyFilesHash`.
- The implementation would force expensive self-host root-suite behavior on all external users by default.
- The only proposed fix is to append `npm test` to normal `validate.commands`.
- The emergency path would let degraded evidence claim full assurance.
- Release/push wording would imply root full-suite coverage without consuming or rerunning the full-suite artifact.
- Review evidence cannot satisfy 3 distinct rounds with 2 independent hosts per round over the final material hash.


## B-c163 convergence contract (implemented)

- A later closeout idle/max timeout preserves any already-observed validation disposition, evidence basis, and refusal reasons; only the later terminal result/layer changes to `timed_out` and `idle|max`. The command-level `done_prepare` budget is the exact sum of routine validation plus each enabled closeout phase once (five non-validation phases, plus DONE-required only when enabled). CLI named deadline errors propagate through routine verifier execution so a command deadline that lands between watchdog polling ticks retains `timeoutLayer=max`.

- Closeout segments check the parent watchdog before and after each segment and await cooperative abort cleanup. Synchronous JavaScript is inherently non-preemptible, so it stops at the first deadline/checkpoint boundary. Pure in-process closeout segments spawn no descendants, making process-tree ESRCH evidence not applicable there; descendant cleanup is required and tested only for validation/phase paths that actually spawn children.

DONE-required execution and reuse use one bounded contract:

- The DONE-required phase budget is the safe sum of effective sequential command timeouts plus bounded grace. A phase-specific override wins the global phase override, which wins the derived budget. The direct `done_required_validate` CLI max covers that derived phase; the `done_prepare` CLI max covers routine validation plus every enabled closeout phase. An explicit `PROOF_OR_STOP_MAX_TIMEOUT_MS` remains authoritative. Each effective command timeout is capped at Node's maximum legal timer delay before arming the real timer, so a huge configured value cannot overflow into an immediate timeout. Structured `failed` / `timed_out` / `blocked` results remain parseable on stdout and exit nonzero; routine `done_prepare` idle/max aborts use the same terminal timeout shape and release child processes, timers, and locks for an immediate rerun.
- `done_prepare` defaults `reuseFreshDoneRequired=true`, independently of post-closeout `reuseFreshValidation`. Reuse requires the canonical DONE-required evaluator to pass and evidence HEAD to equal current HEAD, or be its ancestor with every path touched by every intervening commit classified as trusted story metadata (including modify-then-revert history). HEAD must remain unchanged across evaluation. Any code, config, non-metadata, non-ancestor, unreadable evidence/lineage, or concurrent HEAD movement refuses reuse.
- `validate:false` means `disposition=skipped_explicitly` and `result=not_run`; it neither executes nor reuses nor manufactures evidence, while reporting `existingEvidenceBasis=fresh|stale|missing`. Executed and reused paths report `disposition`, `result`, `refusalReasons`, and any `timeoutLayer` in human and JSON output.
- Progress and heartbeat output uses stderr/the logging side channel, never JSON stdout. Reporter failures are diagnostic-only. Heartbeats refresh idle liveness only; command, phase, idle, and absolute max deadlines, child-tree termination, lock release, and timer cleanup remain independent.
