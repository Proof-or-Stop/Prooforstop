# B-fbb6 — User-value acceptance (real-machine transcript + diff)

Story: Migrate the `gemini` provider to the Antigravity CLI (`agy`); usage recorded as unavailable. Hard rename + retire legacy gemini host.

## How this was run (real machine)

1. `node bin/lattice.js host runtime list` — confirm the dispatchable host is `antigravity` (binary `agy`), and `gemini` is gone.
2. A ledger with one antigravity provider call was written to `/tmp/agy-ledger.jsonl` (source=unavailable, provider.name=antigravity, model="Gemini 3.5 Flash (Medium)", unavailableReason set, no token counts) and fed to the reporter:
   `node packages/main/dist/tasks/usage-ledger-report.js /tmp/agy-ledger.jsonl`

## Expected (from PLAN understanding_set.outcome)

- The dispatchable host is `antigravity` (runs `agy`); `gemini` no longer appears.
- An antigravity call is recorded honestly: `provider=antigravity`, `source=unavailable`, model captured, and NO fabricated token counts (agy exposes no per-call usage).
- `grep -rinE '\bgemini\b' packages/main/src` shows no provider-semantic residue.

## Actual (verbatim)

```
# host runtime list:
  fake: ready — ...
  codex: scaffolded — ...
  claude-code: scaffolded — ...
  antigravity: scaffolded — antigravity is supervised-only ... run agy manually and return a local receipt ...
  (no gemini entry)

# usage-ledger report on an antigravity call:
Overall by source:
  unavailable          count=1 known=0 unknown=1 primary[in=0 out=0] tokens[in=0 out=0 cacheCreate=0 cacheRead=0]
  unknown records (all sources): 1
Groups (1):
  - story=B-demo phase=dispatch role=lattice-dispatch:antigravity model=Gemini 3.5 Flash (Medium) provider=antigravity records=1 unknown=1
      unavailable          known=0 unknown=1 primary[in=0 out=0] tokens[in=0 out=0 cacheCreate=0 cacheRead=0]
```

## Diff (expected vs actual)

No meaningful diff. Every expected property holds:
- `antigravity` is the dispatchable host (binary `agy`); `gemini` absent. ✓
- The antigravity call is recorded with `provider=antigravity`, `source=unavailable`, model captured; zero fabricated tokens (all primary/tokens columns 0, counted as unknown). ✓
- `grep -rinE '\bgemini\b' packages/main/src` — 0 provider-semantic matches (only retirement-proof test assertions). ✓

## User-value self-check

1. Who is the user? An operator dispatching to / metering the LLM host they actually use (Antigravity / agy).
2. What did they want? The system to dispatch and name the real tool (Antigravity, not the deprecated Gemini CLI), and the ledger to stay honest.
3. Do they see it now? Yes — `host runtime list` shows `antigravity` (runs `agy`); the ledger records antigravity calls with the model, `source=unavailable`, and no invented tokens.
4. Audit guarantee preserved? Yes — agy exposes no per-call usage, so the record is `unavailable` (never inferred); no raw transcript surfaced; the four-field/primary aggregates and anthropic/codex paths are untouched.
5. Is "done" recognizable? Yes — the operator dispatches `--host=antigravity`, sees `agy` run, and the ledger shows the antigravity call honestly recorded.

## Notes
- Token capture for antigravity is intentionally out of scope (deferred): agy's CLI surface (stdout + log) does not expose per-call token usage, and its trajectory store holds only undocumented protobuf config + raw transcript — extracting usage would require inference / reading raw, both forbidden by the usage-ledger invariants.
- antigravity stays refused for unattended `dispatch_auto` (no policy-posture change); it gains the supervised real-leaf `agy` path that the legacy gemini host had.
