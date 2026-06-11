# Lattice.md

<!-- koala:start -->
## Lattice

`.Lattice/Lattice.md` is the canonical, host-neutral Lattice project guide. This directory holds project-local Lattice context and configuration.

- At the start of a new session, or when resuming interrupted work, run `lattice session_brief`.
- Before acting, run `lattice aux_doc_list` to inspect relevant docs.
- Use the global `lattice` CLI for Story / checklist / fixture / bug operations. Do not edit story/fixture JSON directly; `koala` is a legacy alias.
- Parallel Lattice work is local-only: use local git worktrees/local branches, finish by merging to local `main` and cleaning the worktree. Remote publish is default-denied; a human must run `lattice release_approve_push --confirm` for a short-lived one-shot approval before any `git push origin main`.
- Codex adapter verification and diagnostics use the global CLI: `lattice codex verify` and `lattice codex doctor`.
- Run `lattice check` to check Lattice managed asset/template drift; after review, use `lattice check --apply` to sync safe items.
- Legacy projects may expose `KOALA.md`, `LATTICE.md`, `bin/lattice.js`, `bin/lattice-codex.js`, and `.Codex/` assets as compatibility assets. New global-thin init no longer generates those files.

<!-- koala:end -->
