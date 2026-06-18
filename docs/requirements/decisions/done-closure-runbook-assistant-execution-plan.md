# DONE Closure Runbook Assistant Execution Plan

Date: 2026-06-12

## Purpose

This document defines a two-layer execution plan after the B-b750
`review_run_start` signed workspace work.

Layer 1 is operational closure: make sure B-b750 reaches and remains at real
Lattice DONE, not merely REVIEW or TEST pass.

Layer 2 is a narrow Lattice CLI improvement: add a DONE closure
runbook/assistant so future agents do not confuse TEST PASS with DONE.

This plan is intentionally conservative:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Follow consistency of logic.

## Current Observation

The original confusion was real: after implementation, review, and validation,
the story could be in TEST with validation passing while DONE was still blocked
by lifecycle closure gates:

- branch not synced with main;
- missing `delivery-check.json`;
- missing `summary.json`.

That state is not a CLI failure. It is the intended lifecycle distinction:

```text
TEST PASS != DONE
```

As of the latest local main observation, B-b750 has already been marked DONE
and merged locally:

 ```text
7ceca1d8 merge: B-b750 Implement review_run_start signed workspace resolution
5f9523e7 [legacy DONE metadata commit] mark B-b750 DONE + clear worktree
c4e8fed6 test: confirm B-b750 validation after main sync
```

Layer 1 therefore has two modes:

- if B-b750 is still open in another checkout, finish it through the closure
  gates below;
- if B-b750 is already DONE in the current checkout, verify that the DONE
  closure facts remain present and do not re-open the story.

## Host-Neutral Authority Boundary

This plan supports both Lattice CLI Non-authority mode and the Lattice
Authority Server path, but it must keep them separate.

Local CLI closure evidence can prove:

- local story lifecycle gates passed;
- local reviewers signed local REVIEW or delivery evidence;
- local validation passed on the current material hash;
- local DONE was reached in this repository.

Local CLI closure evidence cannot prove:

- Authority Server receipt acceptance;
- `receiptVerified=true`;
- `authorityDone=true`;
- `productionDone=true`;
- `fullAuthorityDone=true`.

Authority completion may be claimed only when receipt-backed Authority Server
proof is actually verified through the explicit Authority path.

## Layer 1. Finish Or Verify B-b750 DONE

### 1. Locate The Current State

Run from the repository root that owns the story metadata:

```bash
lattice session_brief
git log --oneline -5
git status --short
```

If a B-b750 worktree still exists and the story is not DONE, switch to it:

```bash
cd /Users/jek/Documents/Work/Orchestrate/.worktrees/B-b750
node packages/main/dist/cli.js session_brief
```

Use the worktree-built CLI while B-b750 is not merged, because the global
`lattice` binary can point at local main and may not include the in-flight
implementation.

### 2. If B-b750 Is In TEST, Resolve DONE Closure Gates

If `session_brief` reports TEST with DONE blockers, resolve only those blockers.

#### Branch synced with main

```bash
git merge main
npm --prefix packages/main run build
node packages/main/dist/cli.js validate --story=B-b750 --json
```

If the merge conflicts, resolve the conflict and rerun validation. Do not make
unrelated refactors during conflict resolution.

#### Delivery check

Run the delivery reviewer path. The delivery reviewer must check:

- the implementation matches the story promises;
- the diff, validation evidence, and delivery evidence agree;
- local Non-authority evidence does not claim Authority Server completion;
- real user-observable behavior is represented by transcript or equivalent
  validation evidence.

The delivery reviewer writes `delivery-check.json` through
`delivery_check_set`. The main agent must not forge that reviewer signature.

#### Summary

Record user-value closure through `summary_set`:

```bash
node packages/main/dist/cli.js summary_set '{
  "storyId":"B-b750",
  "changes":"Implemented signed workspace resolution for review_run_start and review evidence binding.",
  "usage":"Run story_resolve and review_run_start from the story worktree or configured gitRoot-backed project root.",
  "expectedOutcome":"Split-root projects resolve the real signed git workspace and reject stale or tampered review evidence.",
  "actualTranscript":"Validation passed, reviewer gates passed, field-regression smoke passed, and process-fact contract passed.",
  "outcomeDiff":"Actual outcome matches expected: review_run_start distinguishes metadataRoot from signedWorkspaceRoot and keeps Authority claims separate.",
  "acceptanceVerdict":"accepted",
  "limitations":"No Authority Server completion is claimed; this is local Non-authority REVIEW/TEST/DONE evidence only.",
  "pitfalls":"Use the worktree-built CLI until the story is merged because global lattice may point at local main dist."
}'
```

Commit any Lattice metadata produced by validation, delivery check, or summary.

### 3. Advance To DONE

Before DONE:

```bash
node packages/main/dist/cli.js session_brief
node packages/main/dist/cli.js validate --story=B-b750 --json
git status --short
```

Then:

```bash
node packages/main/dist/cli.js story_advance --storyId=B-b750 --phase=DONE
```

If DONE succeeds, confirm main:

```bash
cd /Users/jek/Documents/Work/Orchestrate
lattice session_brief
git log --oneline -5
git status --short
```

### 4. If B-b750 Is Already DONE

Do not recreate the worktree or re-run DONE. Verify only:

```bash
lattice session_brief
git log --oneline --decorate -5
git status --short
```

Acceptance for the already-DONE state:

- local main contains the B-b750 merge commit;
- Lattice dashboard counts B-b750 as DONE;
- no B-b750 worktree is required;
- the working tree is clean or any dirty files are unrelated and explicitly
  understood.

## Layer 2. Add A DONE Closure Runbook/Assistant Capability

### Problem

The existing Lattice CLI correctly blocks DONE when closure artifacts are
missing, but agents can still misread a TEST PASS as task completion. This is a
correctness issue in operator guidance and agent workflow interpretation, not a
reason to weaken DONE gates.

### Target Capability

Add a host-neutral DONE closure assistant that projects exactly what remains
between the current phase and DONE.

Candidate command name:

```text
done_closure
```

Alternative if the project prefers extending existing surfaces:

```text
lattice next --done-closure
lattice session_brief --done-closure
```

The implementation should prefer extending existing `session_brief` / `next`
machinery if that avoids duplicate lifecycle logic. A new command is justified
only if the existing output cannot provide a stable machine-readable runbook.

### Output Contract

The command should be read-only by default and return:

```ts
interface DoneClosureRunbook {
  storyId: string;
  phase: string;
  canAttemptDone: boolean;
  blockers: Array<{
    id: string;
    status: "pass" | "fail" | "warn";
    source: string;
    reason: string;
    nextCommand?: string;
    authorityImpact: "none" | "localOnly" | "requiresAuthorityReceipt";
  }>;
  localNonAuthorityAudit: {
    status: "notRequired" | "required" | "passed" | "blocked";
    requiredHosts?: string[];
    requiredRounds?: number;
    evidenceRefs?: string[];
  };
  authorityServerPath: {
    required: boolean;
    receiptVerified: boolean;
    receiptRefs: string[];
    mayClaimAuthorityDone: boolean;
  };
}
```

The output must make this distinction explicit:

```text
local DONE readiness is not Authority DONE readiness
```

### Required Behavior

- Read the same DONE oracle/pre-check data already consumed by
  `session_brief` and `story_advance DONE`.
- Report branch sync, delivery-check, summary, validation evidence, bug state,
  evidence freshness, declared artifacts, and related-doc advisories.
- Suggest commands in the correct order.
- Fail closed when story metadata is inconsistent.
- Never write `delivery-check.json`.
- Never write `summary.json`.
- Never run `story_advance DONE`.
- Never set or imply Authority Server receipt status without verified receipts.
- Never convert host prose into receipt-backed proof.

### Non-Authority Mode

In local Non-authority mode, the runbook may say:

```text
local lifecycle DONE can be attempted after local gates pass
```

It must also say:

```text
Authority completion: not claimed; receiptVerified=false unless a verified
Authority receipt is present.
```

### Authority Server Mode

When Authority mode is configured, the runbook must separate:

- local lifecycle gates;
- Authority evidence submission;
- Authority Server gate decision receipt verification;
- server-backed multi-host final waves when required.

The assistant may point to the Authority command path, but it must not claim
Authority completion unless the verified receipt-backed path already proves it.

### Minimal Implementation Steps

1. Reuse the existing DONE pre-check/oracle logic rather than duplicating gate
   predicates.
2. Add a stable renderer for text and JSON output.
3. Register the command and process fact level as a read-only lifecycle
   observability surface.
4. Add tests proving TEST PASS with missing delivery-check/summary is reported
   as not DONE.
5. Add tests proving local Non-authority pass does not set Authority fields.
6. Add tests proving Authority mode guidance requires receipt-backed proof.
7. Update prompts or docs only after the mechanical command behavior exists.

### Minimum Verification

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:flow-stability-smoke
node packages/main/dist/tasks/done-preflight-smoke.js
npm --prefix packages/main run test:field-regression-cli-smoke
node scripts/verify-process-fact-contract.mjs
```

If Authority receipt fields or Authority command surfaces are touched:

```bash
npm --prefix packages/main run test:authority-completion
npm --prefix packages/main run test:multi-host-authority-smoke
npm --prefix packages/main run test:baseline-local-certification-smoke
```

## Audit Requirement

Because this is lifecycle/gate/Authority-adjacent work, it is high-risk.

Before implementation DONE:

- run 3 rounds of two-host audit;
- hosts: Claude CLI + Codex CLI;
- each round checks only real correctness issues;
- each round enforces:
  - do not optimize for optimization;
  - do not optimize arbitrarily;
  - only fix real correctness issues;
  - follow consistency of logic;
- results must separate:
  - `localNonAuthorityAudit`;
  - `authorityServerPath`;
- DONE may only claim Authority completion when receipt-backed Authority Server
  proof is actually verified.

For low-risk annotation-compliance / typo-only / wording-only changes to this
document, one two-host audit round is enough. For code changes to lifecycle
gates, review evidence, Authority fields, or process-fact registry, use the
full three-round requirement from `story-lifecycle.md`.

## Non-Goals

- Do not weaken the DONE gate.
- Do not auto-generate delivery reviewer signatures.
- Do not auto-accept summaries.
- Do not auto-merge main except through the existing explicit DONE flow.
- Do not introduce network dependency into local Non-authority closure.
- Do not redesign the Authority Server.
- Do not treat Claude CLI, Codex CLI, or any host brand as an Authority Server.
- Do not add new optimization work unrelated to the TEST PASS vs DONE
  correctness issue.

## Acceptance Criteria

Layer 1 is accepted when either:

- B-b750 is already verified as DONE on local main; or
- B-b750 is advanced through branch sync, delivery check, summary, validation,
  and DONE without bypassing gates.

Layer 2 is accepted only when:

- a TEST story with passing validation but missing delivery-check/summary is
  reported as not DONE;
- the runbook gives the next actionable commands in gate order;
- the runbook does not write lifecycle artifacts or reviewer signatures;
- local Non-authority output cannot claim Authority completion;
- Authority completion remains receipt-backed;
- process fact registry and tests cover the new command or extended surface.

## Final Status Labels

Use these labels in future reports:

```text
localNonAuthorityAudit: PASS | BLOCKED | NOT_RUN
authorityServerPath: RECEIPT_VERIFIED | NOT_CLAIMED | BLOCKED
doneClosure: COMPLETE | BLOCKED | NOT_STARTED
```

Do not report `authorityServerPath: RECEIPT_VERIFIED` from local reviewer
passes or local validation alone.
