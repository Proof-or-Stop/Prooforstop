# B-e74e Transcript Diff

## Expected

- DONE should still succeed when the main merge target is clean and on `main`.
- If branch `main` is checked out in a separate registered worktree, DONE should use that registered worktree as the merge target instead of merging into a non-main checkout.
- `done_recover` should also use the registered worktree that owns branch `main`, even when invoked from a repository root currently on another branch.
- If the resolved main merge worktree is on the wrong branch or has tracked-file changes, DONE should fail before writing phase `DONE`; the story should remain `TEST`, and the story worktree and branch should survive.
- Existing worktree authority behavior and process fact gates should remain valid.

## Actual

Commands run on final implementation HEAD:

```text
npm --prefix packages/main run build
node packages/main/dist/tasks/done-preflight-smoke.js
node packages/main/dist/tasks/worktree-authority-smoke.js
node scripts/verify-process-fact-contract.mjs
lattice validate --story=B-e74e --json
```

Observed transcript highlights:

```text
> @koala-agent/core@0.3.5 build
> tsc

  ✓ DONE main worktree preflight smoke: PASS — happy path not regressed
  ✓ DONE main worktree preflight smoke: PASS — separate registered main worktree
  ✓ done_recover smoke: PASS — separate registered main worktree
  ✓ phase remains TEST after failed preflight (main on wrong branch)
  ✓ phase remains TEST after failed preflight (main worktree dirty)
✓ done-preflight-smoke passed

✓ worktree authority smoke passed
Process fact contract verified
Verification intent coverage: 9/9 covered (0 required missing)
```

## Diff

- Expected and actual match.
- No blocking review findings were recorded.
- Reviewer advisories were non-blocking: minor naming/comment drift, conservative `done_recover` cleanliness behavior, and no npm script entry for the focused smoke.
- Scope warning for `packages/main/src/tasks/done-preflight-smoke.ts` was acknowledged because the focused smoke is intentional B-e74e regression coverage.
