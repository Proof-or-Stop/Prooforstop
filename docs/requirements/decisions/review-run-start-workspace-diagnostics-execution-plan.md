# Review Run Start Workspace Diagnostics Execution Plan

Date: 2026-06-12

## Purpose

This document defines the execution plan for improving `review_run_start`
workspace diagnostics after the direct `story_create --phase=REVIEW` repair.
The goal is to remove operator ambiguity without weakening signed reviewer-run
evidence.

The original defect is fixed: direct REVIEW story creation now initializes
`currentReviewRound`, and legacy REVIEW stories missing that field are repaired
when reviewer commands are invoked. The remaining user-visible confusion is a
different failure mode: `review_run_start` must capture a real git `HEAD` and
`materialHash`, so it correctly fails when invoked from a directory that cannot
provide a material snapshot.

This plan is intentionally narrow:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Preserve consistency of logic.

## Problem Statement

Current failure text collapses several distinct causes into one message:

```text
review_run_start: unable to capture current git HEAD/materialHash, please run inside the story worktree
```

That message is correct about the evidence gate, but incomplete as diagnosis.
It can make users think the direct REVIEW repair failed again, even when
`currentReviewRound` is present and healthy.

The command should still fail closed when it cannot capture `HEAD` and
`materialHash`. The improvement is to classify the failure and tell the operator
which context is missing.

## Non-Negotiable Boundaries

- Do not allow `review_run_start` without a real git `HEAD`.
- Do not allow `review_run_start` without a real `materialHash`.
- Do not accept user-supplied replacement hashes for reviewer-run signing.
- Do not generate unsigned reviewer runs.
- Do not convert local host output into Authority receipts.
- Do not claim `productionDone`, `receiptVerified`, or `authorityChanged`.
- Do not require the full DEV flow for valid review-only work when a git-backed
  material snapshot exists.

## Two-Host Agent Authoring Split

This plan uses two host perspectives. Both are execution or audit surfaces, not
production authority.

| Host perspective | Agent responsibility | Write ownership |
| --- | --- | --- |
| Codex CLI | Audit the CLI evidence gate and propose code/test changes for `review_run_start` diagnostics. | Technical implementation section only. |
| Claude Code | Audit the operator path and host-neutral wording for direct REVIEW, non-git, no-commit, and wrong-cwd cases. | Operator workflow section only. |

The main agent owns final reconciliation and prevents overclaiming. Host
outputs are advisory until reviewed and merged by the main Lattice workflow.

## Current Behavior Audit

Observed behavior after the latest fixes:

- Direct `story_create --phase=REVIEW` writes `currentReviewRound`.
- Legacy REVIEW stories missing `currentReviewRound` are repaired by reviewer
  command entrypoints.
- `review_loop_start` rejects empty triggers and placeholder rollback hashes.
- `review_run_start` still requires a real `HEAD` and `materialHash`.

The remaining issue is message precision, not state-machine repair.

Current implementation points:

- `packages/main/src/handlers/review-run.ts`
  calls `assertCwdInWorktree`, `ensureCurrentReviewRound`, then
  `captureReviewRunSnapshot`.
- `packages/main/src/core/review-run.ts`
  throws one generic error when either `currentGitHead(projectRoot)` or
  `currentMaterialHash(projectRoot)` is missing.
- `packages/main/src/handlers/context.ts`
  can detect story worktree mismatch but currently reports through its own
  generic cwd gate.

Two-host audit refined the risk:

- `assertCwdInWorktree` checks the real `process.cwd()`, but
  `review_run_start` later captures `HEAD/materialHash` from `ctx.root`.
  If `--root` or `LATTICE_PROJECT_ROOT` points at main while the operator is
  inside the story worktree, the command can validate one workspace and sign
  another. This is a correctness risk, not a wording issue.
- Direct REVIEW stories without `story.worktree` must remain supported when the
  current project is a git-backed workspace with a valid `HEAD`.
- Legacy `currentReviewRound` repair should not write metadata before the
  command knows it can capture a real git/material snapshot.

## Implementation Plan

### M1. Add Snapshot Failure Classification

Owner: Codex CLI perspective.

Add a small diagnostic helper near `captureReviewRunSnapshot` that classifies
why a snapshot cannot be captured. It should inspect the exact workspace root
that will be signed.

Suggested categories:

| Code | Meaning | Operator message |
| --- | --- | --- |
| `not_git_repo` | Current project root is not a git repository. | Run inside a git-backed project/worktree or initialize git and create an initial commit. |
| `missing_head` | Git exists but `HEAD` cannot be resolved. | Create at least one commit before starting a signed reviewer run. |
| `missing_material_hash` | `HEAD` exists but material hash cannot be computed. | Check git tree/materialHash exclusions and rerun from the project/worktree root. |
| `wrong_worktree` | Story has a worktree and current cwd is outside it. | `cd <story.worktree.path>` and rerun. |

The helper must not change the success path. It only changes the error text.

### M2. Resolve The Signed Workspace Explicitly

Owner: Codex CLI perspective.

Introduce a small read-only workspace resolver for story-scoped commands. It
can live near `assertCwdInWorktree` and should reuse the same logic instead of
creating a second interpretation of worktree state.

Expected result shape:

```ts
{
  cwd: string;
  snapshotRoot: string;
  expectedWorktreeRoot?: string;
  mode: 'story-worktree' | 'direct-review-project';
}
```

Rules:

- If a story has a recorded worktree, `cwd` must be inside it and
  `snapshotRoot` must be that worktree root.
- If a story has no recorded worktree, keep the current compatibility behavior:
  direct REVIEW may use the git-backed project root as `snapshotRoot`.
- If `ctx.root`, `--root`, or `LATTICE_PROJECT_ROOT` disagrees with the verified
  worktree root, fail closed before signing. The error should say that signing
  against a different workspace would produce invalid reviewer evidence.

This milestone prevents a signed reviewer run from binding to the wrong
workspace.

### M3. Make `review_run_start` Error Context-Aware

Owner: Codex CLI perspective.

Update `review_run_start` so the failure can mention that review-round metadata
is healthy when that is true:

```text
review_run_start: story B-xxxx is in REVIEW and currentReviewRound is initialized,
but this command cannot capture a git HEAD/materialHash from the current
workspace. Reason: <classified reason>. Next action: <specific command/path>.
```

Order of checks:

1. Read the story and confirm it is in REVIEW, or fail.
2. Resolve the signed workspace and classify git/material snapshot readiness.
3. Only after snapshot readiness succeeds, call `ensureCurrentReviewRound` to
   repair missing legacy metadata.

This avoids writing legacy repair metadata on a command that still cannot
produce signed reviewer evidence.

### M4. Keep Worktree Guidance Host-Neutral

Owner: Claude Code perspective.

Wording must not imply that Codex or Claude Code owns authority. Recommended
language:

```text
review_run_start requires a git-backed Lattice workspace because reviewer runs
are signed against HEAD/materialHash. Host runners may execute the command, but
they do not manufacture material snapshots or Authority receipts.
```

If the story has an explicit worktree, include a concrete `cd` hint. If it does
not, avoid saying that a worktree is mandatory; a direct REVIEW story in a git
repository can legitimately start a signed reviewer run from the git-backed
project context.

### M5. Regression Tests

Owner: Codex CLI perspective.

Extend `packages/main/src/tasks/field-regression-cli-smoke.ts`.

Required cases:

1. Direct REVIEW story in a git repo starts `review_run_start` successfully.
2. Direct REVIEW story in a non-git directory fails with a message that
   distinguishes material snapshot capture from `currentReviewRound`.
3. Git repo with no commit fails with a `missing_head` style message.
4. Story with a linked worktree invoked from the wrong cwd returns a concrete
   worktree path hint.
5. Cwd inside a story worktree while `--root` or `LATTICE_PROJECT_ROOT` points
   elsewhere fails closed, or signs against the verified worktree root if the
   implementation intentionally normalizes `snapshotRoot` that way.
6. Legacy REVIEW story missing `currentReviewRound` in a git repo with commit
   repairs the round and starts the reviewer run.
7. Legacy REVIEW story missing `currentReviewRound` in a non-git or no-commit
   project fails without writing a repair event or reviewer run.
8. Existing `review_loop_start` placeholder-hash and empty-trigger checks remain
   passing.

Optional focused unit coverage:

- Add a pure helper test for snapshot diagnostic classification if the helper is
  factored into `core/review-run.ts`.

### M6. Verification

Required commands:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:field-regression-cli-smoke
npm --prefix packages/main run test:review-loop-smoke
```

If the implementation touches shared cwd/worktree logic, also run:

```bash
npm --prefix packages/main run test:worktree-authority-smoke
```

## Acceptance Criteria

The work is complete when:

- `review_run_start` no longer makes git/material failures look like
  `currentReviewRound` failures.
- Direct REVIEW stories still initialize or repair `currentReviewRound`.
- Signed reviewer runs still require real `HEAD` and `materialHash`.
- Non-git and no-commit cases fail closed with actionable messages.
- Wrong-cwd worktree cases tell the operator where to run the command.
- No host output is treated as Authority evidence.

## Rollout Notes

This is a global CLI behavior change. Any project whose `lattice` resolves to
the Orchestrate global CLI entrypoint will pick it up on the next command
execution after build.

Already-running host sessions will not hot reload. Operators should restart or
rerun the relevant host command if they need the new diagnostics.
