# Plan: B-36ba Align review-escalation freshness-root to gitCwd

## CHK-001: Make evaluateReviewEscalation freshness-root gitCwd-aware

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/review-escalation.ts

**Verify**:
- `npm --prefix packages/main run build` compiles (new `gitCwd?: string` on `EvaluateReviewEscalationArgs`).
- `node packages/main/dist/tasks/review-escalation-smoke.js` prints its pass line (no regression).

**DoneWhen**:
- `EvaluateReviewEscalationArgs` has `gitCwd?: string`.
- `evaluateReviewEscalation` computes `const gitCwd = args.gitCwd ?? args.projectRoot` and calls `currentMaterialHash(gitCwd,'HEAD',args.projectRoot)` and `currentStoryFilesHash(gitCwd,'HEAD',args.projectRoot)` (lines ~439-440), exactly mirroring review-assurance-floor.ts:439 and producers.
- No other behavior change; plain repos (gitCwd==projectRoot) byte-identical.

## CHK-002: Plumb resolved gitCwd into the DONE-gate escalation calls

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/done-oracle.ts
- Modify: packages/main/src/core/machine.ts

**Verify**:
- `npm --prefix packages/main run build` compiles.
- `node packages/main/dist/tasks/done-oracle-wrapper-root-smoke.js` passes.

**DoneWhen**:
- done-oracle.ts ~751: the `evaluateReviewEscalation({...})` call passes the same `gitCwd` already in scope (used by the adjacent floor call at ~787).
- machine.ts ~639 and ~1140: each `evaluateReviewEscalation({...})` passes the SAME gitCwd expression the adjacent `evaluateReviewAssuranceFloor` call uses (`context.gitCwd ?? resolveGitCwd({...})` / `gitCwd ?? resolveGitCwd({...})`).
- Byte-identical in plain repos (resolveGitCwd returns projectRoot there).

## CHK-003: Plumb gitCwd into the diagnostic escalation handlers

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/review-escalation.ts

**Verify**:
- `npm --prefix packages/main run build` compiles (resolveGitCwd imported).
- `node packages/main/dist/tasks/review-escalation-smoke.js` passes (it exercises the handlers).

**DoneWhen**:
- review_escalation_status / review_escalation_policy_set / review_escalation_fallback_set pass `gitCwd: resolveGitCwd({store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root})` to evaluateReviewEscalation.
- `resolveGitCwd` is imported from core/story-signed-workspace-resolution.js.
- quorum-submit.ts:329 left unchanged (already passes explicit materialHash/storyFilesHash, internal recompute bypassed) — confirmed in code comment or plan note.
- Byte-identical in plain repos.

## CHK-004: Add offline floor<->escalation freshness-root equivalence smoke + plain-repo regression

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/tasks/review-escalation-freshness-root-smoke.ts
- Modify: package.json
- Modify: packages/main/package.json

**Verify**:
- `npm --prefix packages/main run build` then `node packages/main/dist/tasks/review-escalation-freshness-root-smoke.js` prints `review-escalation freshness-root smoke passed`.
- `npm test` (root chain) runs the new `test:review-escalation-freshness-root` script and stays green.

**DoneWhen**:
- The smoke builds a PLAIN repo and a WRAPPER-ROOT layout (non-git metadataRoot + inner gitRoot) and asserts, for the SAME (gitCwd, projectRoot): `floor.materialHash === escalation.materialHash` AND `escalation.materialHash === currentMaterialHash(gitCwd,'HEAD',projectRoot)` AND `escalation.storyFilesHash === currentStoryFilesHash(gitCwd,'HEAD',projectRoot)`.
- A RED-documenting assertion: in wrapper-root, escalation WITHOUT gitCwd yields `materialHash === null` and `!== floor.materialHash` (proving why gitCwd plumbing is required).
- A plain-repo no-change regression: with gitCwd omitted/equal to projectRoot the escalation hashes are unchanged.
- Wired: root package.json `test:review-escalation-freshness-root` script + inserted into the root `test` chain; auto-discovered by run-all-smokes for `test:all`.
