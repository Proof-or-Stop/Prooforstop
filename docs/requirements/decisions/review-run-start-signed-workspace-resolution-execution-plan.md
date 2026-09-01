# Review Run Start Signed Workspace Resolution Execution Plan

Date: 2026-06-12

## Purpose

This document defines the follow-up execution plan after the
`review_run_start` workspace diagnostics repair.

B-3787 fixed the first correctness issue: direct
`story_create --phase=REVIEW` initializes `currentReviewRound`, and
`review_run_start` now reports git/material snapshot failures as git/material
snapshot failures rather than as review-round failures.

The ClawCreek repro exposes a second correctness issue:

```text
metadataRoot != signedWorkspaceRoot
```

Observed shape:

```text
metadataRoot:        /Users/jek/Documents/ClawCreek
real git repo:       /Users/jek/Documents/ClawCreek/clawcreek
real git worktrees:  /Users/jek/Documents/ClawCreek/.worktrees/...
```

`review_run_start` correctly fails closed with `not_git_repo` when it signs the
wrapper root, but the operator still lacks a mechanical path to bind the story
metadata root to the git-backed signed workspace root.

This plan is intentionally narrow:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Follow consistency of logic.

## Problem Statement

Proof-or-Stop currently has several root-like concepts that can collapse into one
path in a simple repository but diverge in wrapper-root projects.

| Concept | Meaning | Current ClawCreek failure |
| --- | --- | --- |
| `metadataRoot` | Where Proof-or-Stop story/review metadata is read and written. | `/Users/jek/Documents/ClawCreek` |
| `signedWorkspaceRoot` | Git-backed workspace used to capture `HEAD`, `materialHash`, scope diff, and review scope binding. | Missing because the resolver falls back to `metadataRoot`. |
| `authoritativeCwd` | Directory a host/operator should run the next story-scoped command from. | `story_resolve` reports a non-git wrapper root even though `requiresWorktree=true`. |
| `worktreePath` | Explicit story worktree path, if the story has one. | `null` for direct REVIEW/backfill stories. |

The real bug is not that the command refuses to run without git. That refusal
is correct. The bug is that the story/workspace resolver has no explicit,
host-neutral contract for projects where metadata and git material live in
different directories.

## Non-Negotiable Invariants

- `review_run_start` must fail closed without a real git repository.
- `review_run_start` must fail closed without a real `HEAD`.
- `review_run_start` must fail closed without a real `materialHash`.
- `headHash`, `materialHash`, scope diff, and scope binding must all come from
  the same `signedWorkspaceRoot`.
- Story metadata must continue to be written through the intended
  `metadataRoot`; the resolver must not silently create a second story universe
  under a nested repo.
- `story_resolve` must not report a non-git wrapper root as executable
  `authoritativeCwd` for a REVIEW/TEST/DONE story that requires signed
  workspace evidence.
- Direct REVIEW remains valid when the current Proof-or-Stop project root is itself
  a git-backed project root with a usable `HEAD` and `materialHash`; it must
  not require a worktree for every REVIEW story.
- Do not auto-discover or guess nested git repositories. A wrapper root may
  contain multiple repos. Picking one implicitly can sign the wrong material.
- Local host output from Claude CLI, Codex CLI, shell, or CI is
  localNonAuthorityAudit unless it is converted into a verified
  receipt-backed Authority Server artifact through the explicit Authority path.

## Main Auditor Reconciliation

This plan reconciles two host perspectives:

| Input | Contribution | Authority status |
| --- | --- | --- |
| Claude CLI host perspective | Operator workflow, wording, and host-neutral failure behavior. | localNonAuthorityAudit only. |
| Codex CLI host perspective | Handler, resolver, snapshot, and gate consistency concerns. | localNonAuthorityAudit only. |
| Main auditor | Final merge, overclaim removal, and implementation sequencing. | localNonAuthorityAudit only. |

The two-host inputs are useful for finding correctness gaps, but neither host
is an Authority Server. Their output must not set `receiptVerified`,
`productionDone`, `authorityDone`, or `fullAuthorityDone`.

## Final Claude CLI Review Record

After this document was written, the main auditor ran Claude CLI in
non-editing plan mode against this file.

Command shape:

```bash
claude -p --permission-mode plan --tools Read,Glob,Grep \
  --add-dir /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ab43
```

Review constraints:

- host-neutral Proof-or-Stop design;
- support CLI Non-authority and Authority Server paths;
- do not optimize for optimization;
- do not optimize arbitrarily;
- only fix real correctness issues;
- follow consistency of logic.

Result:

```text
PASS
```

Claude CLI found no blocker in:

- `metadataRoot` vs `signedWorkspaceRoot` separation;
- `workspaceBinding` treatment;
- `story_resolve` / `review_run_start` consumer consistency;
- direct REVIEW compatibility;
- Authority overclaim boundaries.

This PASS is still localNonAuthorityAudit. It is not an Authority Server
receipt and does not set any production completion field.

## Target Capability

Add a shared, read-first story workspace resolver that can represent separated
metadata and material roots without guessing.

Suggested result shape:

```ts
interface StorySignedWorkspaceResolution {
  storyId: string;
  phase: string;
  metadataRoot: string;
  storyDir: string;
  signedWorkspaceRoot: string | null;
  authoritativeCwd: string | null;
  worktreePath: string | null;
  repoRoot: string | null;
  requiresWorktree: boolean;
  resolved: boolean;
  resolutionSource:
    | 'story-worktree'
    | 'linked-story-branch-worktree'
    | 'metadata-git-root'
    | 'configured-git-root'
    | 'unresolved';
  unresolvedReason?: string;
}
```

Important naming rule:

```text
authoritativeCwd is where the next host command should run.
signedWorkspaceRoot is where HEAD/materialHash are captured.
metadataRoot is where Proof-or-Stop story metadata is persisted.
```

In most simple repos these paths are the same. In wrapper-root projects they
can differ, and the difference must be explicit.

The review run should also persist a `workspaceBinding` snapshot so later
evidence consumers can verify the exact root interpretation that produced the
signed material facts:

```ts
interface ReviewRunWorkspaceBinding {
  schemaVersion: 'lattice.review_run_workspace_binding.v1';
  metadataRoot: string;
  invocationCwd: string;
  repoRoot: string | null;
  signedWorkspaceRoot: string;
  workspaceMode: string;
  headHash: string;
  materialHash: string;
  bindingHash: string;
}
```

`bindingHash` should be computed from canonical fields in a fixed order. If the
top-level `ReviewRun.headHash` or `ReviewRun.materialHash` ever disagrees with
`workspaceBinding.headHash` or `workspaceBinding.materialHash`, consumers must
fail closed.

## Implementation Phases

### Phase 1. Add Shared Resolver

Create a small shared resolver, for example:

```text
packages/main/src/core/story-signed-workspace-resolution.ts
```

It should consume:

- the current `StoryStore`;
- `ctx.root` as `metadataRoot`;
- `process.cwd()` as the host cwd;
- `story.worktree?.path`;
- linked git worktrees for `story/<storyId>`;
- an optional explicit config field such as `gitRoot`;
- future explicit attachment data if a `story_attach_worktree` command is
  added.

Resolution order:

1. If `story.worktree.path` exists and points to a valid git worktree, use it.
2. If git worktree registry has branch `story/<storyId>`, use that linked
   worktree.
3. If the story has no worktree and `metadataRoot` itself is inside a git
   worktree, use that git top-level for direct REVIEW compatibility.
4. If the project config explicitly sets `gitRoot`, use
   `metadataRoot/gitRoot` only after verifying it is a git repository.
5. If `metadataRoot` is a non-git wrapper root, do not treat an arbitrary
   nested `process.cwd()` git repo as sufficient proof. Require explicit
   `gitRoot` or story worktree attachment.
6. Otherwise return `resolved=false` with a precise `unresolvedReason`.

Stop condition:

```text
Do not guess nested repos by scanning children of metadataRoot.
```

### Phase 2. Update `story_resolve`

Extend the existing `story_resolve` JSON surface.

Keep existing fields for compatibility:

```json
{
  "schemaVersion": "lattice.story_resolve.v1",
  "storyId": "B-3938",
  "phase": "REVIEW",
  "exists": true,
  "storyDir": "...",
  "worktree": null,
  "authoritativeCwd": "...",
  "requiresWorktree": true
}
```

Add fields:

```json
{
  "metadataRoot": "/Users/jek/Documents/ClawCreek",
  "signedWorkspaceRoot": null,
  "resolved": false,
  "resolutionSource": "unresolved",
  "unresolvedReason": "requires_git_signed_workspace_but_metadata_root_is_not_git_and_no_worktree_or_gitRoot_is_configured"
}
```

When resolution fails, `authoritativeCwd` should be `null` or clearly marked as
not executable. It must not present a non-git wrapper root as the command cwd
for REVIEW work.

### Phase 3. Update `resolveStoryCommandWorkspace`

Replace the current binary behavior:

```text
story worktree -> sign worktree
no worktree -> sign ctx.root
```

with the shared resolver:

```text
resolved signedWorkspaceRoot -> sign signedWorkspaceRoot
unresolved -> fail before writing reviewer-run metadata
```

The handler may allow `metadataRoot !== signedWorkspaceRoot`, but only if the
resolver returns that relationship explicitly. Snapshot-only normalization is
not enough; story metadata writes, review-run artifact paths, and freshness
checks must all know which root they are using.

### Phase 4. Update `review_run_start`

Use the same `signedWorkspaceRoot` for all material facts:

- `captureReviewRunSnapshot`;
- `buildScopeDiffPack`;
- `computeReviewScopeBinding`.

Do not call `ensureCurrentReviewRound` until the resolver and snapshot
preflight have succeeded. This preserves the B-3787 invariant that a failed
snapshot command does not repair metadata prematurely.

Expected failure text for ClawCreek wrapper root:

```text
review_run_start: story B-3938 is in REVIEW and currentReviewRound is initialized,
but no git-backed signed workspace could be resolved.

metadataRoot: /Users/jek/Documents/ClawCreek
signedWorkspaceRoot: unresolved
Reason [requires_git_signed_workspace_but_no_binding]:
  metadataRoot is not a git repository, story has no worktree binding,
  and no explicit gitRoot is configured.

No reviewer run was created.
Next action:
  configure gitRoot, attach the story to a git worktree, or recreate/advance
  the story through a git-backed Proof-or-Stop worktree flow.
```

### Phase 5. Add Explicit Binding Path

Implement at least one explicit path.

Option A: config binding:

```json
{
  "gitRoot": "clawcreek"
}
```

Rules:

- `gitRoot` is relative to `metadataRoot`.
- It must resolve inside the project wrapper unless an explicit future policy
  allows trusted external paths.
- It must be a git repository.
- It is advisory for direct REVIEW/backfill stories, not a replacement for
  story worktree records.

Option B: story worktree attachment:

```bash
proof-or-stop story_attach_worktree \
  --storyId=B-3938 \
  --path=/Users/jek/Documents/ClawCreek/.worktrees/split-integration-memory-suite
```

Rules:

- The path must be a git worktree.
- The worktree branch must match the expected story branch, or the command must
  record a clear exception reason.
- The attachment is persisted through Proof-or-Stop CLI, not by editing story JSON.

Recommended first implementation:

```text
Add resolver + fail-closed diagnostics first.
Add config binding or attach command as the next small patch.
```

This keeps the first patch correctness-only while still giving operators a
specific repair path.

### Phase 6. Align Consumers

Avoid creating reviewer runs that later fail every consumer due to root drift.

Review the following consumers and make them use the same resolver facts or
the persisted run's signed material facts:

- `review_pass_set`;
- `finding_add`;
- `collectReviewerEvidenceState`;
- REVIEW to TEST gate freshness;
- scope-protected review evidence checks;
- planned-step worktree policy where reviewer evidence is collected.

The success condition is:

```text
review_run_start, review_pass_set, finding_add, and REVIEW gate all agree on
which signedWorkspaceRoot produced the material facts.
```

If `workspaceBinding` becomes part of `ReviewRun`, update the process fact
contract together with the code:

- `packages/main/src/core/process-fact-registry.ts`;
- `packages/main/src/core/process-fact-levels.ts`;
- `scripts/verify-process-fact-contract.mjs`.

This is not a documentation-only nicety. The binding is gate-consumed evidence,
so process-fact metadata must stay in lockstep with the runtime contract.

### Phase 7. Keep Authority Server Separate

The Authority Server path is not implemented by this local resolver. The
resolver can supply local material facts to an Authority evidence envelope in a
future receipt-backed path, but it cannot produce Authority facts by itself.

Authority completion may be claimed only when a verified server-signed
`gate_decision` receipt binds the relevant story/gate, `headHash`,
`materialHash`, evidence digests, policy, and run/session metadata.

## Regression Matrix

| Scenario | Expected result |
| --- | --- |
| Metadata root is git root, direct REVIEW, commit exists | `review_run_start` succeeds and writes a local signed reviewer run. |
| Metadata root is git root, no commit | Fails with `missing_head`; no reviewer run, no repair event. |
| Metadata root is git root, material hash unavailable | Fails with `missing_material_hash`; no reviewer run. |
| Wrapper root is non-git, cwd is wrapper root, missing worktree binding | Fails with `requires_git_signed_workspace_but_no_binding`; no reviewer run. |
| Wrapper root is non-git, cwd is nested git repo, no `gitRoot` or attachment | Fails closed; nested cwd alone is not a signed workspace binding. |
| Wrapper root is non-git, explicit `gitRoot` points to nested repo | Succeeds only after `gitRoot` is verified as the signed workspace binding. |
| Wrapper root has multiple nested repos | Fails closed unless explicit `gitRoot` or worktree binding is provided. |
| Story has linked worktree, cwd is main repo | Fails with `wrong_worktree` and concrete `cd <worktree>` hint. |
| Story has linked worktree, cwd is worktree, metadata root differs | Succeeds only if resolver explicitly returns both roots and all signing uses the worktree. |
| `--root` or `PROOF_OR_STOP_PROJECT_ROOT` points to metadata root while cwd is worktree | Succeeds only if the shared resolver explicitly supports this split; otherwise fails before signing. |
| Review run created, then material changes | `review_pass_set` / `finding_add` / REVIEW gate detect stale material. |
| Review run has tampered or mismatched `workspaceBinding` | Evidence consumers fail closed before accepting pass/finding evidence. |
| Placeholder or forged hashes are supplied by user | Rejected; reviewer-run signing captures real git/material facts only. |
| Local host transcript claims Authority PASS | Ignored for Authority; `receiptVerified=false`, `productionDone=false`, `authorityDone=false`, `fullAuthorityDone=false`. |
| Fake/local-only receipt is supplied | Authority path blocks as forged or local-only evidence. |
| Server-signed stale receipt binds old material | Authority path blocks as stale/mismatched material. |

## Verification Commands

Minimum local verification:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:field-regression-cli-smoke
npm --prefix packages/main run test:review-loop-smoke
npm --prefix packages/main run test:worktree-authority-smoke
```

If Authority surfaces or receipt consumers are touched:

```bash
npm --prefix packages/main run test:authority-boundary-smoke
npm --prefix packages/main run test:authority-gate-consumption
npm --prefix packages/main run test:baseline-local-certification-smoke
```

If Codex adapter or host prompts are touched:

```bash
node bin/proof-or-stop.js verify_codex
```

## localNonAuthorityAudit

Before implementation DONE, run the project risk-appropriate audit rule:

- High-risk / gate / Authority / lifecycle / review / process-fact stories:
  run 3 rounds of two-host audit.
- Low-risk local documentation-only changes may run one round, but this
  particular issue is high-risk because it changes signed REVIEW evidence.

For each audit round:

- Hosts: Claude CLI + Codex CLI when both are available.
- Each host checks only real correctness issues.
- Each host enforces:
  - Do not optimize for the sake of optimization.
  - Do not optimize arbitrarily.
  - Only fix real correctness issues.
  - Follow consistency of logic.
- Results must separate local findings from Authority Server proof.

Audit output may produce findings or pass statements. It must not set
Authority completion fields.

## authorityServerPath

This plan does not require changing the Authority Server for the local
`review_run_start` fix.

Authority Server optimization is needed only if a future story wants
server-side receipt consumption to validate the same split-root facts. That
future path must be receipt-backed and should add or confirm:

- receipt subject binds story id, gate, `headHash`, `materialHash`, and evidence
  digest;
- server rejects stale/mismatched material;
- server rejects local-only host transcripts;
- server rejects fake or contract-only receipts;
- receipt verification remains independent of Claude CLI or Codex CLI prose.

Until then, the Authority status of this fix remains:

```text
local CLI correctness plan: yes
Authority completion proof: no
receiptVerified: false
productionDone: false
authorityDone: false
fullAuthorityDone: false
```

## Non-Goals

- Do not migrate ClawCreek metadata.
- Do not redesign the whole lifecycle.
- Do not introduce network dependency into local review-run signing.
- Do not make local reviewer runs into Authority receipts.
- Do not make Claude CLI or Codex CLI authoritative by host brand.
- Do not scan nested repositories and pick one implicitly.

## Acceptance Criteria

The future implementation story is complete only when:

- `story_resolve` distinguishes `metadataRoot`, `signedWorkspaceRoot`,
  `authoritativeCwd`, `resolved`, and `unresolvedReason`.
- `review_run_start` signs only a proven git-backed `signedWorkspaceRoot`.
- Direct REVIEW remains supported in a normal git-backed project root.
- Wrapper-root projects fail closed until explicit `gitRoot` or worktree
  attachment exists; nested cwd alone is not enough.
- `review_run_start`, pass/finding submission, and REVIEW gate freshness agree
  on the material root.
- `workspaceBinding`, if added, is signed and gate-consumed with process-fact
  registry coverage.
- Regression tests cover success, fail-closed, stale, ambiguous nested, and
  Authority overclaim cases.
- The final implementation summary separates `localNonAuthorityAudit` from
  `authorityServerPath`.

## Final Claim Template

Use this wording after local implementation and review pass:

```text
Proof-or-Stop CLI now has explicit signed workspace resolution for reviewer runs.
The CLI distinguishes metadataRoot from signedWorkspaceRoot, fails closed when
no git-backed signed workspace is proven, and preserves direct REVIEW behavior
for ordinary git-backed project roots.

This is local Non-authority REVIEW evidence behavior. It does not claim
Authority Server completion or production DONE.
```
