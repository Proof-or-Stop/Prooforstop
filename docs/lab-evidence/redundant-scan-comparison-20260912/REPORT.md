# Six historical overhead hotspots on 0.3.339

This managed Lab starts from local main `9a526607f6345eca3017f9ab9dc8891c2592ad4d`
(0.3.339). Quorum cleanup is explicitly excluded at the user's request because
another Lab owns it. No quorum implementation or test is changed here.

The committed RED is `d45cef74e8`; implementation GREEN is `8c6b8b64d8`.
Both use Node v26.8.1 and the same command:

```sh
node scripts/verify-redundant-scan-comparison.mjs
```

The command prepares this Lab's own main/utils build, then exercises equivalent
disposable fixtures through the actual implementation. RED is an assertion on
repeated work, not a failed dependency installation or an incorrect product
result. An earlier driver syntax error was refused by the Lab recorder and is
not counted as target RED.

| Historical hotspot | Before, 0.3.339 | After, Lab candidate | Result |
| --- | --- | --- | --- |
| Merge-base queries per fresh input probe | 1; next probe also 1 | 1; next probe also 1 | Already within budget; no repair |
| Physical tree reads in probe/capture/strict/relaxed entrypoints | [1, 1, 1, 1] | [1, 1, 1, 1] | Already within budget; no repair |
| Initial snapshot serialization, each of facts and input snapshot | First execution 5; receipt reuse 3 | First execution 1; receipt reuse 1 | Reproduced and repaired |
| Resource stage entries for an ordinary command | 1 | 1 | Already within budget; no repair |
| Cost probes in the second independent process | 2 | 2 | Already within budget; no repair |
| Path normalization replace calls, warm / unseen input | 8 / 8 | 8 / 8 | Already within budget; no repair |

The repaired row contains two separate baseline objects. Their combined
top-level canonicalization count is therefore 10 -> 2 for execution and 6 -> 2
for receipt reuse. These reductions are 80% and 66.7% of those particular
operations, not total validation or Story latency.

The first invocation still makes 6 live fact probes and starts 1 real command;
the reused invocation still makes 4 live fact probes and starts 0 commands.
Only the canonical strings for already captured baseline objects are retained
within one invocation. Every later check still acquires and canonicalizes live
facts/input bytes and compares workspace and loaded implementation identity.

## Verification and retained boundaries

- The exact RED command passes under managed `green`.
- Changed input bytes force a new execution. A successful child modifying its
  declared input tree cannot publish a reusable result. Fresh fact drift refuses
  before spawning any command.
- The existing tree test preserves edit, rename, delete, read-failure and recovery
  controls. It deliberately bypasses the persistent memo using its existing Git
  replacement environment control to count physical reads within an observation.
- The existing stage test retains the late recheck for exact-input declarations,
  the separate full-output caller, and refusal of nested claim expansion.
- The independent-process cost test retains corrupt-store fallback and execution
  of changed failing input without consuming old PASS. Its fixture uses the
  existing 20 ms command; it is not a whole-Story workload.
- Path comparison checks 570 string-matcher cases against the former two-pass
  normalization semantics.
- The original `node scripts/verify-runtime-fact-contract.mjs` run passes with
  the dynamic snapshot regression on the recorded Node v26 runtime. See the
  audit correction below for its final compatibility-safe registration.
- `node packages/main/tests/validation-shared-input-tree.mjs` passes, including
  directory additions, same-mtime byte drift, self-written inputs and cycles.

The normal runtime contract also runs its existing quorum refusal diagnostic
helper; that existing check is unmodified and is not quorum cleanup work.

## Evidence and limits

[Comparison data](comparison.json) records counts, single-observation wall times,
and SHA-256 fingerprints for [RED](red.log), [GREEN](green.log),
[runtime contract](runtime-contract.log), and [input tree](input-tree.log).
The Lab command also retains its own local records under Git common storage.

The wall times are single observations on a shared machine, not an interleaved
benchmark. No elapsed-time speedup percentage or whole-Story improvement is
claimed. Five baseline checks were already passing; their old historical RED
values are not substituted for the measured 0.3.339 values.

This packet records local maintenance RED/GREEN evidence before integration.
It is not formal Story DONE. Later release records carry integration status;
the original raw logs and their recorded commit bindings remain unchanged.

## Independent audit correction

The first Claude audit accepted the production optimization and the measurement
evidence but rejected unconditional registration of the hook-based counter in
the general runtime contract. `node:module.registerHooks` is a Lab capability,
not a declared general CLI requirement. The repair keeps that dynamic test in
the managed Lab command and replaces its canonical gate invocation with a
TypeScript AST binding check. That check verifies invocation-local baseline
consts and the exact live comparison in the actual execution owner. Five
in-memory mutations must be rejected. It uses no native module hooks and does
not silently skip validation on older runtimes. This changes test registration,
not the measured production implementation or the original before/after data.

The corrected runtime contract passes; see [compatible registration run](runtime-contract-compatible.log). The new AST guard also passes under Node 20, including its five mutation controls; see [Node 20 run](node20-binding.log). This is a bounded compatibility check for the new guard, not a claim that the entire repository suite was run on Node 20.
