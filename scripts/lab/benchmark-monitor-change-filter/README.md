# Lab: suppress unchanged monitor dispatch intents

This user-authorized experiment reproduces periodic model wake decisions, then
compares them with a deterministic semantic-state filter. It is a local prototype;
it does not modify the Codex scheduler, benchmark Stories, approval policy or review
requirements. RED/GREEN records are Lab provenance, not Story or product completion.

The focused regression requires 100 identical observations after initialization to
produce zero extra dispatch intents. Phase, revision, approval binding, execution
identity/progress/completion/failure changes must still wake. A return to an earlier
state must wake again. Invalid input remains visible, and recovery must wake.

The filter compares every supplied JSON fact. Callers must supply a complete,
validated semantic projection, excluding only irrelevant poll timestamps. Array
order is significant; collectors must normalize unordered inventories. The filter
cannot determine whether an omitted fact would have mattered. It is an in-memory
experiment, with no provider IO or durable delivery/ack implementation. A production
collector must detect failures, stalled executions and changed relevant inputs;
it must never treat a failed read or incomplete snapshot as unchanged. Execution
collection and launch ownership remain outside this filter.

## Reproduce

Use Node 24+ and Python 3.9+. No packages or provider APIs are required.

```sh
node scripts/lab/benchmark-monitor-change-filter/verify.mjs
python3 scripts/lab/benchmark-monitor-change-filter/extract-history.py AUDIT.json /tmp/monitor-history.json
node scripts/lab/benchmark-monitor-change-filter/compare.mjs /tmp/monitor-history.json /tmp/monitor-comparison.json
```

The extractor selects the audit's second heartbeat subset by default (`--subset`
overrides it). It reads only tool-returned observations timestamped within their
completed turn, excluding stale index reads and turns without recoverable fresh
observations. Per-response usage is deduplicated by response ID and reconciled
against the pre-existing audit. Exports retain facts, usage and source provenance,
without conversation or tool transcript prose. Cached input is part of input;
reasoning output is part of output. Neither is added a second time.

Historical replay covers only the recorded scope/phase/revision projection. It does
not prove that no execution or external input changed. Both arms consume exactly
the same selected observations. Acceptance is at least 95% fewer dispatch intents
for this unchanged trace, with one cold initialization wake retained. Warm replay
assumes an already-known initial state. Nine synthetic change cases test filter
logic separately; they cannot establish historical observation completeness.

Seven alternating A/B timing rounds process the same trace 1,000 times per sample,
after discarded warm-up rounds. Report measured local decision overhead even if
the filter is slower. These times exclude CLI polling, extraction and model calls.
There are zero live provider calls in either arm, so actual live token savings are
unknown. Historical usage attached to suppressed turns is a counterfactual
opportunity only. Do not call that number actual savings or translate it into fees.

Lab integration and changing a running automation are separate actions. This
experiment leaves the live benchmark task and scheduler untouched.
