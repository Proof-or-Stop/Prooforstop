<!-- lattice:start -->
## Proof-or-Stop

- `.lattice/Lattice.md` is the host-neutral Proof-or-Stop guide; this file keeps only Codex / AGENTS additions.
- At the start of a new session, or when resuming interrupted work, run `proof-or-stop session_brief`.
- Before acting, run `proof-or-stop aux_doc_list` to inspect relevant docs.
- Use the global `proof-or-stop` CLI for Story / checklist / fixture / bug operations. Do not edit story/fixture JSON directly.
- Parallel Proof-or-Stop work is local-only: use local git worktrees/local branches, finish by merging to local `main` and cleaning the worktree. Remote publish is default-denied; a human must run `proof-or-stop release_approve_push --confirm` for a short-lived one-shot approval before any `git push origin main`.
- Codex adapter verification uses the global CLI: `proof-or-stop codex verify`. For diagnostics, run `proof-or-stop codex doctor`.
- Run `proof-or-stop check` to check Proof-or-Stop managed asset/template drift; after review, use `proof-or-stop check --apply` to sync safe items.

<!-- lattice:end -->
