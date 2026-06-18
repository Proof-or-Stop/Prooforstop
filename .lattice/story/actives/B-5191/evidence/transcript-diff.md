# B-5191 real-machine verification (comments-only doc correction)

**User value**: a maintainer reading review-preflight.ts's express-channel docstrings
now reads the TRUTH — express force-skips channel/concept/lint/docs-drift/english-artifacts
but the codex-adapter gate is still conditionally evaluated and can block — instead of the
misleading "all gates forced-pass / four gates".

## Expected (PLAN outcome)
- 3 comments corrected (~:19-20, ~:122, ~:224); codex-adapter exception stated; gate count = 6.
- Diff is comments-only; build unchanged (tsc exit 0); no runtime behavior change.

## Actual (run from the worktree)
Command: `git diff main...HEAD --stat`
```
 packages/main/src/handlers/review-preflight.ts | 12 ++++++++----   (comments only)
```
Command: comment-only assertion (every changed source line is a comment)
```
✓ all changed lines are comments
```
Command: `npm --prefix packages/main run build` / `npx tsc --noEmit -p packages/main`
```
tsc exit: 0
```
Cross-check of the new comment text against the express branch (runReviewCliGates ~:232-285):
- channel/concept/lint/docs-drift/english-artifacts → pushed ok:true status:'skipped'  ✓ matches "five force-skipped"
- codex-adapter → conditionally pushed, ok = (codex.status==='passing'), return gates.every(g=>g.ok)  ✓ matches "still evaluated, can block"
- PreflightGateEntry.name union lists 6 gate names  ✓ matches "six gates not four"

## Diff notes (expected vs actual)
- Expected == actual: comments corrected, accurate against code, comments-only, build green.

## 5-question self-check
1. PLAN outcome concrete? Yes — exact comment edits + accuracy cross-check captured.
2. Read user-perspective output? Yes — read the corrected comments a maintainer would read.
3. Would the user consider it done? Yes — the misleading docstring is gone.
4. Noise/duplicate logs? No — 3 comment lines in one file.
5. Plain-language summary? "The express-channel preflight comments no longer wrongly claim all gates are skipped; they now note codex-adapter still runs and can block."
