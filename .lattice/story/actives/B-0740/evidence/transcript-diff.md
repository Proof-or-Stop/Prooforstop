# B-0740 real-machine verification (transcript + diff)

Story: Thread resolved gitRoot into `doctor --repair` and lint change-scoping (combination-review stacking gaps).
Verified on real machine (darwin) against the freshly-built `packages/main/dist` on 2026-06-16.

## CHK-001 — doctor --repair threads gitCwd (HIGH stacking gap)

**Expected (PLAN outcome):** on a wrapper-root project (metadataRoot ≠ gitRoot, gitRoot a subdir that *is* a git repo), `doctor --repair` resolves the gitRoot and installs the metadata-protection allowlist (`repairWrote: true`, no `fatal: not a git repository`); before the fix it ran git from the non-git metadataRoot and silently no-op'd.

**Run:** `node packages/main/dist/tasks/story-metadata-protection-smoke.js`
**Actual:** `✓ story-metadata-protection smoke passed (12 checks)` — exit 0.

The smoke builds a **real temp git repo wrapper-root fixture** (`buildWrapperRootFixture`), calls the doctor handler with `root=wrapper` (non-git metadataRoot), and asserts:
- `repairWrote: true`, `repairError: null`, no `fatal:` on stderr, managed allowlist present in `gitRoot/.gitignore`;
- second `--repair` is a byte-identical no-op (`repairWrote: false`);
- **adversarial revert proof:** reverting the cwd back to `root` makes the wrapper-root check FAIL with `repairWrote false !== true`, proving the test is not a tautology.

**Diff (expected vs actual):** match. The fix at `doctor.ts:166/168` passes the resolved `gitProbeCwd` into `repairStoryMetadataAllowlist(root, gitCwd)` (def at `doctor.ts:942`, `gitCwd: string = root` fallback).

## CHK-002 — lint change-scope threads gitCwd (MEDIUM stacking gap)

**Expected (PLAN outcome):** on a wrapper-root project, `resolveChangedFiles` runs `git diff` from the resolved gitRoot and rebases gitRoot-relative paths to projectRoot-relative so change-scope works; plain repos (gitCwd == projectRoot) are byte-identical to passing no gitCwd; a throwing reader still returns `undefined` (full recursive tsc, never skip-all).

**Run:** `node packages/main/dist/tasks/validate-lint-change-scope-smoke.js`
**Actual:** `✓ validate-lint change-scope smoke passed` — exit 0.

Covers via the `ChangedFilesReader` DI seam: wrapper-root rebase (`gitRootReader` asserts the threaded `gitCwd` equals the expected gitRoot and the output is rebased to `backend/src/...`), plain-repo identity, throwing-reader → `undefined`, and an adversarial revert proof. Call sites `verifier.ts:630` and `review-preflight.ts:334` thread the resolved `gitCwd`.

## Aggregate

- `lattice validate --story=B-0740`: ALL PASS; verification intent coverage 6/6 (0 required missing).
- REVIEW→TEST CLI gate preflight (channel / concept / lint / docs-drift): all pass.
- REVIEW (fresh round after the F-001 duplicate-comment cleanup): concept / quality / test-coverage all review-pass, 0 findings.

No `CLAUDE.md` / doc-section promises were made by this diff (confirmed by concept + quality reviewers), so there are no docs promises to deliver — only the two real-machine-tested behaviors above.
