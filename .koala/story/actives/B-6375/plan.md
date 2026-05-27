## CHK-001 Sync runtime ignore patterns into .gitignore

Use the official Koala managed asset sync path for the stale safe `.gitignore` drift.

Implementation steps:
1. Run `koala check --apply` from the story worktree.
2. Inspect `git status --short` and `git diff -- .gitignore`.
3. Confirm the only product file change is `.gitignore` and the added rules are `**/owner-lease.json` and `.koala/locks/`.

Verification:
1. Happy path: run `koala check` and confirm the previous STALE_SAFE `.gitignore` drift is gone.
2. Edge path: inspect `git diff --stat` / `git diff -- .gitignore` and confirm no source, docs, package, or story evidence behavior changed.
3. Adversarial path: run `koala convergence_check`; while B-6375 is active it may report active-story convergence state, and after DONE on main it must return `converged: true`.

Scope guard:
- Allowed modification: `.gitignore` only.
- No source, docs, package metadata, authority policy, runner, evidence, or story lifecycle behavior changes.
