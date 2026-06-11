# B-9b76 User-Value Transcript Diff

## Expected

The user should be able to verify that prompt assets can be globalized behind a
package registry without changing legacy default behavior:

- `npm --prefix packages/main run build` passes.
- `npm --prefix packages/main run test:prompt-registry-smoke` reports registry
  metadata/render compatibility for all prompt templates.
- `npm --prefix packages/main run test:codex-registry-mode-smoke` reports both
  legacy mirror and thin registry verification coverage, including registry
  manifest drift/tamper failures.
- `npm --prefix packages/main run test:thin-init-assets-smoke` reports thin init
  behavior, full default materialization, and no-delete behavior for existing
  `.Codex/agents` files.
- `node bin/koala-codex.js verify_codex` reports Codex adapter checks passed.

## Actual

Commands run in the story worktree:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:prompt-registry-smoke
npm --prefix packages/main run test:codex-registry-mode-smoke
npm --prefix packages/main run test:thin-init-assets-smoke
npm --prefix packages/utils run build
KOALA_SESSION_ID=sess-984e0c8ad2c9b71f node bin/koala-codex.js verify_codex
KOALA_SESSION_ID=sess-984e0c8ad2c9b71f node packages/main/dist/cli.js validate '{"story":"B-9b76","json":true}'
```

Observed output included:

```text
✓ prompt registry smoke passed: 16 agents rendered for claude and codex
✓ codex registry mode smoke passed
✓ thin init assets smoke passed
✓ Codex adapter checks passed (6/7 pass)
Verification intent coverage: 15/15 covered (0 required missing)
✓ ALL PASS
```

`verify_codex` reported one non-blocking warning: the global `koala` command
resolves to the main checkout rather than this story worktree, so it is treated
as heartbeat-only and not current-worktree gate evidence. The local wrapper
heartbeat passed.

## Diff

No user-visible functional gap was observed. The only difference from an ideal
all-green transcript is the expected global-fallback warning, which does not
weaken the local wrapper or current-worktree validation path.
