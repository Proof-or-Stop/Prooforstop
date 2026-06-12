## CHK-001 Implement shared signed workspace resolver and story_resolve surface

Goal: introduce one shared resolver for story execution workspace facts. It must separate metadataRoot from signedWorkspaceRoot and must expose whether the workspace is resolved.

Implementation boundary:
- Create packages/main/src/core/story-signed-workspace-resolution.ts as the single resolver for REVIEW command workspace facts.
- Extend config only as needed for explicit gitRoot support; do not add arbitrary workspace discovery.
- Update handlers/context.ts to consume the resolver instead of treating ctx.root as the executable signed workspace in direct REVIEW flows.
- Update handlers/story-resolve.ts to report metadataRoot, signedWorkspaceRoot, authoritativeCwd, resolved, resolutionSource, worktreePath, and unresolvedReason.

Correctness rules:
- metadataRoot remains where story metadata is stored.
- signedWorkspaceRoot is the git-backed root used for HEAD/materialHash capture.
- Non-git metadataRoot without story worktree or explicit gitRoot must fail closed.
- Do not auto-pick nested git repositories just because they exist under metadataRoot.

Verification:
- story_resolve returns resolved=true for normal git-backed roots.
- story_resolve returns resolved=false with null executable cwd for non-git wrapper roots without binding.
- Split-root nested repository presence alone does not become a binding.

## CHK-002 Bind review_run_start and REVIEW evidence consumers to resolved signed workspace

Goal: make review_run_start and downstream REVIEW evidence checks consume the same signed workspace facts.

Implementation boundary:
- Update handlers/review-run.ts to snapshot signedWorkspaceRoot, not metadataRoot, while continuing metadata writes through metadataRoot.
- Add workspaceBinding to ReviewRun if needed, sign it, and verify it in pass/finding consumers.
- Update core review-run verification without changing Authority semantics.
- Update process-fact registry and contract script only if workspaceBinding becomes gate-consumed structured evidence.

Correctness rules:
- review_run_start must create no review run when workspace resolution fails or when git HEAD/materialHash cannot be captured.
- Failure messages must identify metadataRoot, signedWorkspaceRoot/resolutionSource when available, and unresolvedReason.
- Local signed reviewer run evidence remains Non-authority evidence.
- Do not claim Authority completion, productionDone, receiptVerified, authorityDone, or fullAuthorityDone.

Verification:
- Resolved git workspace starts a reviewer run with matching headHash/materialHash/workspaceBinding.
- Stale material or tampered workspaceBinding blocks review_pass_set/finding_add.
- Existing currentReviewRound behavior remains intact.

## CHK-003 Add regression coverage for split-root and Authority-boundary cases

Goal: lock the real bug and the host-neutral boundary with targeted regression coverage.

Implementation boundary:
- Add/update field regression smoke coverage for normal git roots, wrapper-root failure, explicit gitRoot success, missing HEAD/materialHash diagnostics, placeholder hash rejection, stale/tampered workspace binding, and Authority boundary wording.
- Prefer CLI smoke coverage for end-to-end behavior and small logic tests only where a specific tamper case cannot be represented through CLI.

Correctness rules:
- Tests should prove the observed ClawCreek class of bug is fixed, not broaden Lattice into a general artifact framework.
- Placeholder hashes remain invalid.
- Local-only reviewer evidence is never treated as receipt-backed Authority Server proof.

Verification:
- Run focused tests covering the changed handlers/core.
- Run process fact contract verification if registry levels change.
- Run the field regression CLI smoke path relevant to review_run_start workspace resolution.

## CHK-004 Implement explicit gitRoot signed workspace binding path

Goal: provide the concrete operator repair path for projects whose metadata root is not the git repository.

Implementation boundary:
- Support an explicit gitRoot in lattice.config.json, resolved relative to metadataRoot unless absolute path support already exists locally.
- Validate gitRoot exists and is a git repository before using it as signedWorkspaceRoot.
- story_resolve must show gitRoot-derived resolutionSource and diagnostics.
- review_run_start must use this explicit signedWorkspaceRoot for HEAD/materialHash capture.

Correctness rules:
- gitRoot is opt-in and explicit; no directory scanning fallback.
- Invalid gitRoot fails closed with clear unresolvedReason.
- The signed workspace binding must remain host-neutral: CLI Non-authority local proof and Authority Server receipt path are separate.

Verification:
- Non-git metadataRoot + valid gitRoot succeeds.
- Non-git metadataRoot + invalid gitRoot fails before creating review metadata.
- Multiple nested git repos under metadataRoot do not matter unless one is explicitly configured.

## Two-host execution and audit model

Host lane A: Claude CLI host lane reviews/implements the explicit binding and operator-facing resolver semantics: config gitRoot, resolver diagnostics, story_resolve surface, and fail-closed behavior.

Host lane B: Codex CLI host lane reviews/implements reviewer-run signing semantics: review_run_start snapshot root, workspaceBinding persistence/signature, REVIEW evidence freshness checks, and process-fact contract consistency.

Main auditor responsibilities:
- Keep write integration coherent and resolve overlaps.
- Reject changes that optimize for optimization, optimize arbitrarily, or alter unrelated lifecycle behavior.
- Accept only real correctness fixes.
- Check consistency of logic across CLI Non-authority evidence and Authority Server receipt-backed completion claims.
- Before DONE, run the required host audit rounds appropriate for this high-risk gate/review/process-fact story.
