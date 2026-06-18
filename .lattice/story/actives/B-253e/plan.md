# B-253e Execution Plan — LLM usage ledger writer foundation (Slice 1)

Implement the writer foundation from
`docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md` in a new
`packages/main/src/core/usage-ledger/` module, behind an opt-in flag (default OFF).
No provider wiring, no estimate path, no budget enforcement, no Authority — all
deferred to later slices.

## Approach
A self-contained module with ONE exported append path (the choke-point):
- `record.ts` — record types + schema validator (spec shape: four cache-aware
  token fields, no totalTokens, usage.source enum, correlation fields, attribution,
  privacy flags, authority{mode:local}, integrity{previousRecordHash,recordHash};
  rejects stored totalTokens; per-dimension absence = null).
- `ids.ts` — mint ledgerCallId/attemptId/sequence/supersedesRecordIds locally
  before any dispatch (never from provider.requestIdHash).
- `writer.ts` — the single append path: validate -> reject raw-content/secrets ->
  hash-chain previousRecordHash from the last line -> append one JSON line; no-op
  when the opt-in flag is OFF; file I/O private to this module.
- `summary.ts` — informational reader: derive total = input+output+cacheCreation+
  cacheRead, pick latest non-superseded record per ledgerCallId+attemptId, keep
  estimates out of provider-reported totals, report unavailable/null as unknown
  (never 0). Feeds NO gate.
- `runtime-artifact-registry.ts` — register `.lattice/usage/llm-usage.jsonl`
  (id=llm-usage-ledger, matchers, ignorePatterns `.lattice/usage/`,
  materialHash=exclude, volatile=true, repairableTrackedArtifact=true).

## Checklist order
CHK-001 (record+validator) → CHK-003 (ids) → CHK-002 (writer) → CHK-004
(raw-content rejection, folded into writer/validator) → CHK-005 (registry) →
CHK-006 (opt-in flag + summary) → CHK-007 (smoke wired into package.json).

## Verification
A committed smoke (`tasks/usage-ledger-smoke.ts`, npm `test:usage-ledger`) asserts:
valid record accepted; rejects stored-totalTokens, raw-content, malformed; append
+ hash-chain continuity across ≥3 records; correlation stability + supersedes;
flag OFF => no file written; single-write-path (no other module writes the file);
runtime-artifact classification (gitignored/exclude/volatile/repairable); summary
derived-total correctness, no double-count of superseded, unknown != 0.
`npm --prefix packages/main run build` clean; `node bin/lattice.js validate --story=B-253e`.

## Out of scope
Provider adapters / live dispatch; count_tokens estimate path; budget policy &
fail-closed blocking; signed-receipt/server promotion; default-on rollout; any
change outside packages/main/src and its tests.
