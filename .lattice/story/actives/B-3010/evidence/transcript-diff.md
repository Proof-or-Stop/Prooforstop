# B-3010 User-Value Transcript Diff

## Expected

The user should be able to run the local Lattice CLI diagnostics and see that
agent prompt assets are resolved from the local runtime registry by default,
project-local prompt assets are classified mechanically, stale prompt copies are
reported without repair or deletion, and token accounting is reported only as a
measurable approximate value.

Expected visible lines:

```text
PASS runtime-owned-agent-assets-smoke promptRegistryHash=<sha256> approximateTokens=<n> providerBillingTokens=unavailable
Codex agent asset resolution: ... authorityBoundary=localNonAuthorityAudit
```

## Actual

Commands run from `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-3010`:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/runtime-owned-agent-assets-smoke.js
node packages/main/dist/tasks/prompt-token-cost-smoke.js
node packages/main/dist/tasks/prompt-registry-smoke.js
node packages/main/dist/tasks/codex-registry-mode-smoke.js
node packages/main/dist/tasks/thin-init-assets-smoke.js
node packages/main/dist/tasks/rollout-check-smoke.js
node packages/main/dist/cli.js verify_codex --storyId=B-3010 --json
lattice validate --story=B-3010 --json
```

Observed key output:

```text
PASS runtime-owned-agent-assets-smoke promptRegistryHash=6e42c247be24625d0427f6d72dedcb8a968f3d994c4118dc93ce22f32097cb0b approximateTokens=73027 providerBillingTokens=unavailable
prompt token cost smoke: current 115559 B (~28890 tok), delta 517128 B (~129282 tok)
Codex agent asset resolution: mode=full-asset; promptRegistryHash=6e42c247be24; assets absent=0 matches-runtime=32 stale=0 override=0; authorityBoundary=localNonAuthorityAudit
validate: allPass=true; verification coverage 15/15
```

## Expected vs Actual

Actual matches the expected user-visible outcome.

The only caveat is intentional: this repository currently has tracked matching
`.claude/agents` and `.Codex/agents` mirrors, so the local repo diagnostic
classifies this worktree as `mode=full-asset` with `matches-runtime=32`. The new
smoke separately proves the no-project-assets default path as
`mode=runtime-owned` with prompt assets `absent`.

`rollout_check` for this repository can still report unrelated runtime or
managed-asset warnings/failures; the new `agent_asset_resolution` probe itself
passes and remains read-only.

## Token Accounting

Recorded task-specific measurable token data:

- Runtime-owned smoke combined rendered prompt estimate:
  `approximateTokens=73027`.
- B-bfb5 preserved prompt-template savings in this branch:
  current `115559 B (~28890 tok)`, delta `517128 B (~129282 tok)` from the
  baseline table.

Exact provider billing token usage for this Codex conversation and external
host runs is not exposed to the local Lattice CLI and is therefore recorded as:

```text
providerBillingTokens=unavailable
```

## Authority Boundary

This transcript is local Non-authority evidence only.

It does not claim:

```text
receiptVerified=true
productionDone=true
authorityDone=true
fullAuthorityDone=true
```
