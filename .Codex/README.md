# Codex + Lattice

Preferred usage:

```bash
lattice codex session_brief
lattice codex aux_doc_list --format=json
```

Why:

- `lattice codex` is the primary global Lattice namespace for Codex-tagged operations.
- It dispatches normal Lattice commands after marking activity with `source=codex`.
- It enables activity heartbeat logging for read-only recovery commands such as `session_brief`.

Local wrapper fallback:

```bash
node bin/lattice-codex.js session_brief
```

Fallback notes:

- The local wrapper loads the repository bootstrap and marks activity with `source=codex`.
- Use it only when the global `lattice` command is unavailable, or when you need explicit current-wrapper heartbeat evidence.
- If the global command is not linked to this checkout, verification reports the global heartbeat as advisory rather than hard current-worktree evidence.
- `.Codex/agents` is generated from the complete `.claude/agents` prompt set; Claude hooks/settings/skills remain exclusive to `.claude`.
- `.Codex/lattice.json` is the Codex adapter manifest read by Lattice itself. It describes the recommended entrypoint, session environment variables, and runtime assets that are intentionally not generated.

Recommendations:

- Run `lattice codex session_brief` as the first command in a new session.
- Keep day-to-day story/checklist/fixture/bug operations on the same entrypoint whenever possible.
- When developing the Lattice/Koala repository itself and the full wrapper is temporarily unavailable, use `node packages/main/dist/cli.js <command>` for current-worktree status/gate/validate decisions.
- After changing Codex adapter assets, run `lattice codex verify`. It verifies the manifest, agent mirror, wrapper heartbeat, global heartbeat, and runtime exclusions, then writes process-event evidence consumable by gates.
- Run `lattice check` to inspect Lattice managed asset/template drift; after review, use `lattice check --apply` or `lattice check --upgrade` to sync safe items.
- Initialization scripts can run `lattice init --verify-codex` for same-source asset verification.
- When diagnosing the Codex adapter, run `lattice codex doctor` to inspect shared checks, health, and worktree state together.
- If `aux_*` is unavailable, the current global lattice is core-only. Prefer a local bootstrap entrypoint; if none exists, fall back to shell search as required by AGENTS.md.

Boundaries:

- Do not create `.Codex/hooks`; the Codex runtime does not execute Claude Code hooks.
- Do not create `.Codex/settings.json`; the Codex runtime does not read Claude Code settings.
- To observe Codex activity, use the wrapper recorded in `.Codex/lattice.json` or a fallback invocation with `KOALA_ACTIVITY_RECORD_READONLY=1`.
