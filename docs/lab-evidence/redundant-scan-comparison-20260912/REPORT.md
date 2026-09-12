# Six historical overhead hotspots on 0.3.340

This final comparison uses local main **0.3.340**, commit
`a11f2d89a4c1762b5e0452e6e9e5e696ee9884c9`. Quorum cleanup is explicitly excluded because another Lab
owns it. No quorum implementation or test is changed here.

The earlier 0.3.339 experiment is retained under
[historical-0339](historical-0339/README.md). Those logs predate the audit-driven
comparison-driver correction and are not current-driver acceptance evidence.
The parent-directory logs were regenerated after that correction and main sync.

## Same driver, actual RED and GREEN

- RED commit: `a387adfba80000ee69f249a0f21d07fbb3d837e1`.
- GREEN implementation commit: `7575d6257240a6ceccc38fb6bb24ba46cd80c391`.
- Runtime: Node v26.8.1.
- Command: `node scripts/verify-redundant-scan-comparison.mjs`.

RED temporarily restores only the pre-optimization implementation. Its complete
`shared-validation-execution.ts` bytes equal those at the stated main commit.
GREEN restores the two invocation-local canonical strings. The driver, dynamic
counter and AST guard are byte-identical at the RED and GREEN commits; their
SHA-256 values are in [comparison.json](comparison.json).

The managed command builds its own implementation and runs all four comparison
programs, then records the AST guard as the fifth result. A failing guard cannot
prevent the target performance assertion from running. RED contains
`INITIAL_SNAPSHOT_SERIALIZED_REPEATEDLY` and fails both the dynamic counter and
binding guard. GREEN contains `VALIDATION_SNAPSHOT_BINDING_GREEN` and all five
result rows exit 0, followed by `REDUNDANT_SCAN_COMPARISON_GREEN`.

## Operation counts

| Historical hotspot | Before, main 0.3.340 | After, Lab candidate | Result |
| --- | --- | --- | --- |
| Merge-base calls per fresh input probe | 1; next probe also 1 | 1; next probe also 1 | Already within budget |
| Tree reads in probe/capture/strict/relaxed | [1, 1, 1, 1] | [1, 1, 1, 1] | Already within budget |
| Initial canonicalization, each of facts and input snapshot | Execution 5; reuse 3 | Execution 1; reuse 1 | Reproduced and repaired |
| Ordinary-command resource stage entries | 1 | 1 | Already within budget |
| Cost probes in the second independent process | 2 | 2 | Already within budget |
| Path normalization replacements, warm / unseen input | 8 / 8 | 8 / 8 | Already within budget |

There are two baseline objects. Combined canonicalization counts are 10 -> 2
for execution and 6 -> 2 for reuse. The reductions of 80% and 66.7% describe
these operations only, not total validation latency.

## Recorded call durations

| Scenario | Before | After | Difference in these observations |
| --- | ---: | ---: | ---: |
| First execution, complete shared-validation call | 5,511.900 ms | 3,303.225 ms | 2,208.675 ms less |
| Consume a matching receipt, complete call | 2,857.382 ms | 2,213.793 ms | 643.589 ms less |

These are single observations on a shared machine. They are not isolated
serialization timings, repeated interleaved samples or whole-Story benchmarks.
Host load and cache state can change the measurements, so their elapsed
improvements cannot be attributed solely to this repair. The older 0.3.339
single observations remain in the historical packet and are not mixed into this
table or used to select a more favorable timing sample.

## Live checks and regression results

The first invocation retains 6 live fact probes and 1 real child start. Receipt
reuse retains 4 live fact probes and 0 child starts. Only already captured
baseline strings are retained within the invocation. Each later check still
acquires and canonicalizes current facts/input bytes, checks workspace state,
and verifies loaded implementation identity. Existing persistent cost hints
remain separately governed by `validation-reuse-economics`.

- Changed input bytes require a new execution.
- A successful child modifying its declared input tree cannot publish reusable
  evidence; live fact drift refuses before child launch.
- The tree fixture retains edit, rename, deletion, failed-read and recovery
  controls. It uses its existing Git replacement environment control to bypass
  persistent memoization and count physical reads within each observation.
- The stage fixture retains exact-input late rechecks, the separate full-output
  caller and nested claim-expansion refusal.
- The cost fixture retains corrupt-store fallback and fresh execution of changed
  failing input. Its 20 ms witness is not a whole-Story workload.
- Path parity checks cover 570 string-matcher cases against former two-pass
  normalization semantics.
- The current runtime fact contract passes; it runs the AST binding guard using
  the supported TypeScript parser, without native module hooks.
- The current input-tree regression passes directory additions, restored-mtime
  byte drift, self-written inputs and cycle fallback.
- The AST guard passes under Node v20.20.2, including
  five rejected mutations. Its log records process.version, executable and argv.
  This is a bounded compatibility check for the new guard, not a claim that the
  entire repository suite ran on Node 20.

## Audit corrections

The first Claude audit accepted the production optimization but rejected the
Lab-only module-hook counter's unconditional use in the canonical runtime gate.
Dynamic counting stays in the Lab command; an AST binding check protects the
actual owner and live comparisons in the canonical gate without raising the
runtime floor or silently skipping a check.

The second audit requested four corrections: allow the RED counter to run before
the binding result is aggregated; regenerate both logs with the corrected
identical driver; identify Node 20 in its own log; and scope the registry wording
to invocation-local canonical strings rather than all existing cost caches.
All four are addressed in the code and regenerated packet above. Earlier failed
audits remain in the official local Lab records and are not relabeled PASS.

## Evidence and publication boundary

[comparison.json](comparison.json) records counts, raw single-call timings,
RED/GREEN commit bindings, identical driver/test hashes, source hashes and the
SHA-256 of every current log:
[RED](red.log), [GREEN](green.log), [runtime contract](runtime-contract.log),
[compatible registration](runtime-contract-compatible.log),
[input tree](input-tree.log), and [Node 20 binding](node20-binding.log).

The runtime contract also runs its pre-existing quorum refusal diagnostic
helper. That unchanged helper is not quorum cleanup work.

This packet is generated before integration. Later official Lab finish records
carry the final version, independent audit, main integration and post-merge
replay status. A documentation-only commit does not change the measured
implementation or driver; the managed command is replayed on the final candidate
and on main by finish. These are local maintenance facts, not formal Story DONE.
