# B-5cea Transcript Diff

## Expected

- Legacy repositories that have `bin/koala-codex.js` but not `bin/lattice-codex.js` should see remediation commands using `node bin/koala-codex.js verify_codex`.
- Repositories with `bin/lattice-codex.js` should see remediation commands using `node bin/lattice-codex.js verify_codex`.
- Generic local fallbacks should be ordered after Codex wrappers: `bin/lattice.js`, then legacy `bin/koala.js`.
- Global `lattice` / `koala` in a story worktree should be described as heartbeat-only and not current-worktree gate/status evidence.
- Validation should use Node/Lattice commands and keep `validate --json` parseable; no Swift or Mac Native App validation should appear.

## Actual

- `npm run test:codex-assets` passed and covered lattice wrapper, legacy `koala-codex`, `lattice.js`, `koala.js`, and global-thin resolver paths.
- `npm run test:entrypoints` passed 25/25 entrypoint checks, including Lattice global-thin defaults and full-mode local wrapper behavior.
- `node bin/koala-codex.js verify_codex` passed. Its stale global warning reported the global core outside the worktree as heartbeat-only and recommended `node bin/koala-codex.js session_brief`.
- `node packages/main/dist/cli.js validate --json` remained parseable and returned `status: pass`.
- No verification command used Swift or Mac Native App validation.

## Diff

No user-visible behavior gap remains for this story.
