# DONE Full-Test Gate Execution Plan

## Problem Statement

The verified gap is that the local DONE gate currently consumes evidence produced by `lattice validate`, and `lattice validate` runs the configured validation subset when `validate.commands` exists. A root full `npm test` failure can therefore sit outside the configured validation subset and still be invisible to local DONE, allowing a story to merge locally if every configured `validate.commands` entry passes.

Important caveat: this proves a gate coverage gap, not that current main `npm test` is red. The claim is about what the current gate is capable of proving. It does not assert a live root-suite failure on `main`.

## Current Evidence Anchors

- `lattice.config.json` defines 8 entries under `validate.commands` at `validate.commands[0..7]`.
- Root `package.json` defines `scripts.test` as a 22-step `npm test` chain.
- `packages/main/src/handlers/verifier.ts` reads configured `validate.command` / `validate.commands` first. When configured commands exist, fallback discovery is skipped, so the fallback `npm test` path is not used for this repository.
- `packages/main/src/handlers/phase-gates.ts` runs `lattice validate --story=<storyId> --json` when entering TEST and writes the result to `test-evidence.json`.
- `packages/main/src/core/done-oracle.ts` builds the DONE row from `test-evidence.json`, including result and freshness, and does not independently require root full-suite evidence.
- `.githooks/pre-push` does not run root `npm test`. Its build plus recursive `tsc --noEmit` path is scoped to the self-host package name `@lattice/core`; it is a type/build push guard, not the root full-suite gate.

Together these anchors mean local DONE, release/push, pre-push, and root full-suite health are currently separate assurance surfaces. The local DONE row can be green because configured validation passed, while a script present only in root `npm test` has never been executed by that gate. The current pre-push hook also must not be described as build+tsc assurance for this repo until its self-host boundary is corrected or deliberately narrowed.

## Scope For This Story

This story only writes this execution plan document:

- `docs/requirements/decisions/done-full-test-gate-execution-plan.md`

No runtime implementation is in scope for B-3321. Do not change runtime code, config, package scripts, hooks, generated artifacts, story JSON, fixtures, or other documentation in this story. Any implementation must be handled by a future code-changing story that uses this plan as its requirements source.

## Chosen Solution

Add a dedicated DONE/release-required validation profile, or an equivalent `doneRequiredCommands` configuration surface, with fresh hash-bound evidence consumed by DONE. Do not simply append `npm test` to ordinary `validate.commands`.

Implementation boundary after B-ac25: the local DONE-required surface is `doneRequiredCommands` / `validationProfiles.done` plus `done_required_validate --storyId=<id>`, which writes `.lattice/story/actives/<storyId>/done-required-evidence.json`. The DONE oracle consumes this in a separate `done-required-validation` row. Missing policy remains advisory/non-blocking for external projects and must not be described as full-suite assurance.

Reasons:

- Normal `lattice validate` is used during DEV/TEST iteration and should remain configurable for fast feedback.
- Root full `npm test` is self-host expensive and should not be forced onto every Proofbound user by default.
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

- Existing `lattice validate` behavior remains unchanged.
- DONE may show an advisory row such as "No DONE-required validation profile configured".
- The advisory row must not block by default.
- Documentation must explain how projects opt into a blocking full-suite policy.

Self-host behavior for Orchestrate/Lattice:

- Configure a fresh package build plus the root full `npm test` chain, or a semantically equivalent full-suite command whose receipt proves current `packages/main/dist` output, as DONE-required.
- Missing, failing, or stale DONE-required evidence blocks local DONE.
- A degraded or emergency path may continue only under an explicitly lower assurance label.

This avoids imposing Orchestrate-specific cost on every Proofbound user while fixing the self-host overclaim.

## Evidence Data Model

The implementation persists a separate evidence artifact from ordinary `test-evidence.json`:

- `.lattice/story/actives/<storyId>/done-required-evidence.json`

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
- For Orchestrate/Lattice self-host, evidence must prove `packages/main/dist` freshness for the same material before root `npm test`, either by an explicit `npm --prefix packages/main run build` command receipt or by an equivalent root `pretest` / build receipt.
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

## Runner And Artifact Plan

1. Add schema/config support for a DONE-required validation profile or `doneRequiredCommands`.
2. Add a runner entry point that executes the DONE-required command set independently from ordinary `lattice validate`.
3. Persist bounded command receipts with status, output digest/tail, duration, `headHash`, `materialHash`, and `storyFilesHash`.
4. Add freshness checks that compare both material state and effective policy/command set.
5. Add a dedicated `done-oracle` row that consumes only DONE-required evidence for the full-suite claim.
6. Register the DONE-required artifact and semantics in the process fact registry, process fact levels, and process fact contract verifier.
7. Configure the self-host repository to require `npm --prefix packages/main run build` plus root `npm test`, or an equivalent complete root-suite command with a same-material build receipt.
8. Keep normal `validate.commands` optimized for routine feedback.
9. Decide whether release approval and `.githooks/pre-push` should consume the same evidence, rerun the same profile, or remain narrower with explicit claim boundaries.

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
- Keep ordinary `test-evidence` row intact for `lattice validate`.
- Consume the registered process fact contract for the DONE-required artifact rather than relying on prose-only semantics.

Exit criteria:

- DONE is blocked when required full-suite evidence is absent, failed, or stale.
- DONE still shows ordinary validation separately.
- `packages/main/src/core/process-fact-registry.ts`, `packages/main/src/core/process-fact-levels.ts`, and `scripts/verify-process-fact-contract.mjs` cover the new DONE-required gate evidence.

### M4. Self-Host Config

- Configure Orchestrate/Lattice self-host policy to require `npm --prefix packages/main run build` plus root `npm test`, with `requiresBuildProof: "packages-main-build"` on the root test command, or an equivalent full-suite command with a same-material build receipt.
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
- If pre-push stays narrower, document that the remote push hook is not a root full-suite gate; it provides build+tsc assurance for the `@lattice/core` self-host package boundary.
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
lattice validate --story=<storyId> --json
lattice story_advance '{"storyId":"<storyId>","phase":"DONE"}'
```

Expected artifacts:

- Ordinary validation still writes `test-evidence.json` from `lattice validate`.
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
- Do not modify root `package.json`, `lattice.config.json`, `.githooks/pre-push`, or runtime TypeScript in B-3321.
- Do not append root `npm test` to normal `validate.commands` as the final solution.
- Do not force root full-suite execution on external projects that have not opted in.
- Do not make the pre-push hook depend on Proofbound CLI as a hidden requirement.
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

DONE-required execution and reuse use one bounded contract:

- The DONE-required phase budget is the safe sum of effective sequential command timeouts plus bounded grace. A phase-specific override wins the global phase override, which wins the derived budget. The direct `done_required_validate` CLI max covers that derived phase; the `done_prepare` CLI max covers routine validation plus every enabled closeout phase. An explicit `LATTICE_MAX_TIMEOUT_MS` remains authoritative.
- `done_prepare` defaults `reuseFreshDoneRequired=true`, independently of post-closeout `reuseFreshValidation`. Reuse requires the canonical DONE-required evaluator to pass and evidence HEAD to equal current HEAD, or be its ancestor with every path touched by every intervening commit classified as trusted story metadata (including modify-then-revert history). HEAD must remain unchanged across evaluation. Any code, config, non-metadata, non-ancestor, unreadable evidence/lineage, or concurrent HEAD movement refuses reuse.
- `validate:false` means `disposition=skipped_explicitly` and `result=not_run`; it neither executes nor reuses nor manufactures evidence, while reporting `existingEvidenceBasis=fresh|stale|missing`. Executed and reused paths report `disposition`, `result`, `refusalReasons`, and any `timeoutLayer` in human and JSON output.
- Progress and heartbeat output uses stderr/the logging side channel, never JSON stdout. Reporter failures are diagnostic-only. Heartbeats refresh idle liveness only; command, phase, idle, and absolute max deadlines, child-tree termination, lock release, and timer cleanup remain independent.
