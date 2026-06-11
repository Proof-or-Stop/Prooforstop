# Plan: Codex adapter config and wrapper hardening

## CHK-001
Generate a Koala-managed Codex adapter manifest.

Steps:
- Add a `CODEX_ADAPTER_TEMPLATE` in init assets with explicit Koala ownership and Codex source tagging fields.
- Make `koala init` write `.Codex/koala.json` next to `.Codex/README.md`.
- Keep `.Codex/hooks` and `.Codex/settings.json` absent, and represent that absence in the manifest as excluded runtime assets.

Validation:
- `npm run test:codex-assets`
- `npm run test:entrypoints`
- fresh `koala init` transcript includes `.Codex/koala.json`.

## CHK-002
Harden the Codex wrapper and entrypoint verification.

Steps:
- Preserve `bin/koala-codex.js` as the stable wrapper that sets `KOALA_ACTIVITY_SOURCE=codex`.
- Add verification that the wrapper still produces `source=codex` activity and derives session id from Codex/OpenAI/terminal env variables.
- Add entrypoint checks that a fresh init includes the adapter manifest and does not include fake runtime files.

Validation:
- `node bin/koala-codex.js session_brief`
- `npm run test:entrypoints`

## CHK-003
Document that Codex gets an adapter, not hooks/settings.

Steps:
- Update `.Codex/README.md` template to point to `.Codex/koala.json` and explain recommended entrypoints.
- Update root README and AGENTS guidance to distinguish prompt mirroring from adapter/runtime behavior.
- Explicitly say `.Codex/hooks` and `.Codex/settings.json` are intentionally absent because Codex does not consume Claude Code hooks/settings.

Validation:
- `npm run test:codex-assets`
- grep docs for misleading `.Codex/hooks` or `.Codex/settings.json` support claims.
