# Plan: review_run_start material-source clean-tree preflight (B-7691)

Chosen approach (decision A, refined): extract the shared git-status READ + classifier-options into a new module `core/dirty-worktree-gate.ts`; review_run_start reuses the SAME `DIRTY_GATE_POLICY` blocking table via a gate-agnostic blocking check (no `DirtyGateName`, so `dirty-gate-policy.ts` stays read-only/untouched); done-oracle's audited verdict path stays byte-identical. Fail-fast UX; fail-open on unreadable git status.

## CHK-001
Export/extract readGitStatusLines + add the clean-tree preflight to review_run_start.

Files:
- `packages/main/src/core/dirty-worktree-gate.ts` (NEW)
- `packages/main/src/core/done-oracle.ts` (import swap only — verdict byte-identical)
- `packages/main/src/handlers/review-run.ts` (the preflight)

Steps:
1. NEW `core/dirty-worktree-gate.ts`: move `readGitStatusLines` (currently private at done-oracle.ts:75) and `classifierOptionsForCheck` (done-oracle.ts:91) here VERBATIM (pure move) and export them. Add a small gate-agnostic helper:
   `isBlockingDirty(classification): { blocked: boolean; blockingPaths: string[]; blockingCategories: string[] }`
   derived from the EXPORTED `DIRTY_GATE_POLICY` (dirty-gate-policy.ts) — a category contributes when `DIRTY_GATE_POLICY[cat].blocking === true` (material_source, fixture, unexpected_dirty). The module imports only leaf modules: `dirty-worktree` (classifyGitStatusRows, dirtyWorktreeClassifierOptionsForStory) and `dirty-gate-policy` (DIRTY_GATE_POLICY) — NO back-edge to done-oracle or review-run.
2. `done-oracle.ts`: delete the two moved local defs and import `readGitStatusLines` + `classifierOptionsForCheck` from `./dirty-worktree-gate.js`. Its `evaluateDirtyGitStatus` (with the `'done-gate'` audit via evaluateDirtyGate) STAYS in done-oracle and keeps using the imported readGitStatusLines/classifierOptionsForCheck. The DONE verdict path (buildDoneChecklist ~376/390) is behavior byte-identical.
3. `handlers/review-run.ts` `review_run_start` (after the REVIEW phase check at ~line 61-65, BEFORE `captureReviewRunSnapshot` at ~line 69): 
   - `const status = readGitStatusLines(signedWorkspaceRoot);`
   - if `!status.ok` -> FAIL-OPEN: do NOT block (it is a convenience gate; mirror how the DONE gate tolerates an unreadable status); proceed to the snapshot.
   - else `const classification = classifyGitStatusRows(status.lines, classifierOptionsForCheck(config, storyId, store, root));` then `const b = isBlockingDirty(classification);`
   - if `b.blocked` -> throw a clear refusal naming the offending files: e.g. `review_run_start: git working tree has uncommitted ${b.blockingCategories.join('/')} changes (${b.blockingPaths.slice(0,5).join(', ')}). Commit or revert all code/config changes, then rerun review_run_start.`
   - else proceed unchanged.

Invariants: DONE verdict byte-identical; `DIRTY_GATE_POLICY` table + blocking logic untouched (review-run only READS it); no new classification logic; no DirtyGateName/dirty-gate-policy.ts edit; the materialHash computation and checkEvidenceFreshnessForGit write-time guard are NOT touched.

Excludes: DONE gate verdict change; materialHash computation; the evidence-write-time freshness guard; DONE-merge; escalation rebind; storyFilesHash.

## CHK-002
Smoke + verifier wiring for the review_run_start clean-tree preflight.

Files:
- `packages/main/src/tasks/review-run-clean-tree-preflight-smoke.ts` (NEW; auto-discovered by run-all-smokes)
- `package.json` (npm script `test:review-run-clean-tree-preflight`)

The smoke runs in an OS temp git repo + a Lattice story fixture in REVIEW phase, then drives `review_run_start` through the handler (or the extracted preflight unit) and asserts:
- (a) an uncommitted MATERIAL-SOURCE change -> review_run_start REFUSES (throws) and no review run is recorded;
- (b) an uncommitted FIXTURE change -> REFUSES (fixtures are blocking, matching the DONE gate);
- (c) a clean tree -> review_run_start PROCEEDS and records the run;
- (d) only `.lattice` metadata dirty (a non-blocking category) -> PROCEEDS;
- (e) the refusal message names the offending material-source files;
- (f) PARITY: for an identical git status, `isBlockingDirty(classifyGitStatusRows(...))` yields the SAME blocked verdict the DONE gate's `evaluateDirtyGitStatus` would (shared `DIRTY_GATE_POLICY`);
- (g) REGRESSION: the DONE gate verdict is unchanged after the extraction (sample statuses still classify/block identically);
- (h) fail-open: an unreadable git status does NOT block review_run_start.
Add the npm script; run-all-smokes auto-discovers `dist/tasks/*-smoke.js`.

Excludes: no change to the DONE gate behavior; no materialHash/freshness-guard change.
