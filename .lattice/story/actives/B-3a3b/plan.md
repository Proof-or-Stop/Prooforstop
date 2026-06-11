# Plan: Codex agent assets mirror Claude agents

## CHK-001
Generate Codex agent prompts from every Claude agent prompt.

Steps:
- Replace the fixed Codex prompt whitelist with directory discovery for `.claude/agents/*.md`.
- Update `koala init` so `.Codex/agents` is written from every discovered Claude agent prompt through the existing Codex wording transform.
- Keep `.claude/hooks`, `.claude/settings.json`, and `.claude/skills` out of `.Codex` because Codex does not execute those runtime assets.
- Sync the current repository `.Codex/agents` to the new generated shape, including `koala-implementer` and `koala-review-*` prompts.

Validation:
- `npm run build`
- `npm run test:entrypoints`

## CHK-002
Verify Codex asset drift against the full agent set.

Steps:
- Update `scripts/verify-codex-assets.mjs` to enumerate every `.claude/agents/*.md` file and compare it with the transformed `.Codex/agents` version.
- Add stale-file detection so Codex-only prompts without a Claude source fail verification.
- Tighten entrypoint verification so a fresh `koala init` proves representative full-mirror prompts exist and old Codex-only prompts are absent.
- Update implementation-reviewer verification so it checks the new full-discovery path instead of the removed whitelist.

Validation:
- `npm run test:codex-assets`
- `npm run test:entrypoints`
- `npm run test:implementation-reviewer`

## CHK-003
Clarify documentation for Claude-only versus mirrored Codex assets.

Steps:
- Update README to say Codex mirrors agent prompts from `.claude/agents` but does not mirror Claude runtime hooks, settings, or skills.
- Update AGENTS.md subagent definition guidance with the same boundary.
- Update `.Codex/README.md` template text so newly initialized projects explain the distinction.

Validation:
- `npm run test:codex-assets`
- Manual check that the docs do not imply `.Codex/hooks` or `.Codex/settings.json` are supported runtime conventions.
