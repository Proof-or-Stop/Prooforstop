# B-cac9 Plan: Profile-aware koala init

## CHK-001

Goal: add a typed init profile selection layer before any host assets are emitted.

Implementation steps:
- Define the supported profiles as a closed set: `codex`, `claude`, `all`, and `core`.
- Parse `--profile=<value>` and `--profile <value>` before positional target resolution so profile flags are not mistaken for the target directory.
- Use explicit `--profile` as the source of truth. Host markers and environment variables only participate when the user did not specify a profile.
- Implement marker detection from existing project files: Codex markers are `AGENTS.md` or `.Codex`; Claude markers are `CLAUDE.md` or `.claude`. Both marker families select `all`; no markers keeps `all` for backward compatibility and prints a compatibility fallback note.
- Print the selected profile and reason near the start of init so the user sees why a project is codex/claude/all/core.

Verification focus:
- Explicit profile beats conflicting markers.
- Codex-only, Claude-only, both-marker, and no-marker auto detection produce the expected profile and terminal text.

## CHK-002

Goal: make generated files follow a mechanical profile asset matrix with `KOALA.md` as the neutral workflow source.

Implementation steps:
- Add a `KOALA_MD_TEMPLATE` in `init-assets.ts` containing host-neutral Koala workflow guidance and managed koala markers.
- Change `AGENTS_MD_TEMPLATE` into a Codex adapter wrapper that points to `KOALA.md`, names `node bin/koala-codex.js`, and describes only Codex-specific assets.
- Add a Claude adapter template or sync path that points to `KOALA.md` and emits Claude-only assets only for `claude` and `all` profiles.
- Refactor `cli-init.ts` around booleans such as `includeCodexAssets` and `includeClaudeAssets` so directory creation, wrapper creation, skills, agents, hooks, settings, Codex README, Codex manifest, and Codex agent mirror all share the same matrix.
- Preserve existing `AGENTS.md`, `CLAUDE.md`, and `KOALA.md` files without koala markers. If markers exist, sync only the managed koala section and leave user content outside the markers intact.
- Keep `all` profile behavior equivalent to today, plus `KOALA.md`.

Verification focus:
- `codex` emits Codex assets and no Claude-only files.
- `claude` emits Claude assets and no Codex-only files.
- `all` emits both surfaces.
- `core` emits neutral core files only.
- Existing marked/unmarked docs behave according to the preservation policy.

## CHK-003

Goal: make profile behavior a hard-coded contract and keep Codex verification scoped to profiles that generate Codex adapter assets.

Implementation steps:
- Extend `scripts/verify-entrypoints.mjs` with profile matrix assertions for `codex`, `claude`, `all`, and `core`.
- Assert the old default `koala init <dir>` remains backward-compatible `all` and prints the compatibility/detection reason.
- Add tests for explicit profile overriding conflicting existing markers.
- Add tests for marked section sync and unmarked user doc preservation for `AGENTS.md`, `CLAUDE.md`, and `KOALA.md`.
- Keep Codex adapter verification running for `codex` and `all` profiles. For `claude` and `core`, explicit `--verify-codex` should print a clear skip message instead of failing on missing `.Codex`.

Verification focus:
- `npm run build` succeeds.
- `npm run test:entrypoints` passes and fails if the profile matrix regresses.
- `node bin/koala-codex.js verify_codex` still passes in the Koala worktree after touching Codex adapter/init assets.
