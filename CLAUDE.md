<!-- lattice:start -->
## Proof-or-Stop For Claude Code

- `LATTICE.md` is the canonical, host-neutral Proof-or-Stop guide; Story lifecycle facts and shared rules derive from it.
- Claude Code entrypoints should first run `node bin/proof-or-stop.js session_brief`; daily operations should use `node bin/proof-or-stop.js` or global `proof-or-stop`.
- Parallel Proof-or-Stop work is local-only: use local git worktrees/local branches, finish by merging to local `main` and cleaning the worktree. Remote publish is default-denied; a human must run `proof-or-stop release_approve_push --confirm` for a short-lived one-shot approval before any `git push origin main`.
- Claude Code subagents live in `.claude/agents`.
- Claude Code hooks live in `.claude/hooks`, and Claude settings live in `.claude/settings.json`.
- When the repository also enables the Codex profile, Codex assets live separately under `.lattice-codex/`; do not treat this file as a shared truth source for both hosts.
- Run `node bin/proof-or-stop.js check` to check Proof-or-Stop managed asset/template drift; after review, use `node bin/proof-or-stop.js check --apply` or `node bin/proof-or-stop.js check --upgrade` to sync safe items.

<!-- lattice:end -->
