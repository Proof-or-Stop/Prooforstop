# B-3ddc real-machine acceptance transcript + expected/actual diff

Date: 2026-07-12 (host: local macOS, worktree `.worktrees/B-3ddc`)

## Scenario (user perspective)

The user runs `lattice host_run --host codex ...`, codex fails with the B-3928
version-skew 400 (`turn.failed`), and then reads the CLI usage summary / the
usage-ledger final to learn WHY usage is unavailable.

Setup: the real worktree-built CLI (`node packages/main/dist/cli.js`) with
`LATTICE_USAGE_LEDGER=1`; the only substitution is the `codex` binary on PATH —
a shim that replays the EXACT observed B-3928 `codex exec --json` failure
transcript (thread.started → turn.started → the byte-exact pinned
`turn.failed` line) and exits 1. Everything else — handler, core, real
child-process spawn, streaming scanner lanes, ledger append — is the real path.

Command:

```
PATH="<shim-dir>:$PATH" LATTICE_USAGE_LEDGER=1 \
  node packages/main/dist/cli.js host_run --host codex \
  --agentType acceptance-check --phase adhoc \
  --prompt 'B-3ddc real-machine acceptance: replay the B-3928 version-skew failure' \
  --format json
```

## Expected (from PLAN / acceptance claim AB-001)

- `spawned: true`, `exitCode: 1` (host exit propagates), `timedOut: false`
- `usage.recorded: "unavailable"`, `usage.provider: "openai"`
- `usage.reason: turn_failed(The 'gpt-5.6-sol' model requires a newer version
  of Codex. Please upgrade to the latest app or CLI and try again.)` — the
  INNERMOST message of the nested JSON-encoded 400 body, not the generic
  `no_turn_completed_usage_event`
- `usage.input/cacheRead/output: null` (never fabricated)
- A matching `source: "unavailable"` ledger row with the same reason

## Actual (verbatim CLI JSON, trimmed to the relevant fields)

```json
{
  "schemaVersion": "lattice.host_run.v1",
  "host": "codex",
  "phase": "adhoc",
  "agentType": "acceptance-check",
  "spawned": true,
  "exitCode": 1,
  "timedOut": false,
  "usage": {
    "recorded": "unavailable",
    "provider": "openai",
    "input": null,
    "cacheRead": null,
    "output": null,
    "recordId": "llmuse_9e779e65-f0dd-43e3-a4ba-596d99dded75",
    "reason": "turn_failed(The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.)"
  },
  "passthroughError": null
}
```

Ledger rows written by the run (`.lattice/usage/*.jsonl`, gitignored runtime data):

```
prompt-size-estimate | provider unknown | in: 18          (preflight, sequence 1)
unavailable | openai | turn_failed(The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.) | in: None
```

## Diff: expected vs actual

No differences. Every expected field matches, including the byte-exact digest
text, null token counts, exit-code propagation, and the ledger row reason.

## Baseline contrast (old behavior, same shim, same prompt shape)

The INSTALLED pre-change CLI (`lattice` 0.3.185 global binary) run with the
same shim records only the generic reason:

```
unavailable | openai | no_turn_completed_usage_event | in: None
```

i.e. exactly the B-3928 forensics pain this story removes: the version-skew
cause was invisible in the ledger before, and is now named by the row itself.

## Five-question self-check

1. Did I run the real deliverable, not just unit tests? — Yes: the compiled
   worktree CLI end-to-end (handler → core → real spawn → scanner → ledger),
   plus the full 71-check smoke separately.
2. From the user's perspective? — Yes: the exact command a user runs and the
   exact JSON/summary they read; the reason line answers "why is usage
   unavailable" without any Desktop-rollout forensics.
3. Expected written down BEFORE the run? — Yes: from AB-001 / plan.md CHK-002.
4. Actual output captured verbatim? — Yes, above (recordId included).
5. Any diff explained or fixed? — No diff; baseline contrast documented the
   removed failure mode.
