# Reconcile two preserved Lab repairs

## Scope and provenance

This maintenance Lab starts from main `ed03c8cd62cd7a6dc4e992c8525f028ef3db6731`
(0.3.321). It recovers two bounded behaviors from preserved workspaces, not their
old branches or configuration wholesale:

- `Lab-story-performance-closure-v4`: runtime path normalization overhead.
- `Lab-q022-optimization-20260909`: refusal diagnostics that accidentally passed.

B-e6d9 and the actively developed CLI runtime observation Lab remain with their
existing owners. No Story phase, finding, receipt, historical Lab record, or old
uncommitted file is altered. This is not formal Story DONE.

## Root causes and fixed behavior

`findRuntimeArtifactEntry` normalized the same input again for every candidate
entry, and normalized constant matcher strings on each lookup. The repair
hoists the second input pass and caches only pure matcher-string normalization
in a value-checked WeakMap. Both input passes are preserved: removing a leading
`./` once is not idempotent. Registry order, matcher replacement/value mutation,
array insertion/removal and stateful regular expressions remain observable.
There is no cache of classification results, files, Git state or evidence.

The quorum test helper assigned `assert.throws()` to a variable. That API returns
no captured exception, so the conditional diagnostic check silently did nothing.
The helper now captures and rethrows the actual error, retains the expected
refusal and zero-write assertions, and validates a nonempty, duplicate-free,
ordered subset of canonical lanes. It returns the captured text to callers.
All ten existing full-envelope tamper iterations and their real consumers remain
in place; the old optional reduction of that matrix was not imported.

## Reproduction and comparison

The committed RED at `732ae789f1` ran:

```sh
node scripts/verify-pending-performance-reconciliation.mjs
```

| Measurement/control | Before repair | After repair, same assertions |
| --- | --- | --- |
| Replace calls, warmed matcher strings and repeated input | 280 | 8 |
| Replace calls, warmed matcher strings and unseen input | 280 | 8 |
| Path parity with frozen former semantics | 691 cases pass | 691 cases pass |
| Registry mutation/order and stateful-regex controls | Pass | Pass |
| Fabricated reviewer lane | Incorrectly accepted by helper | Rejected |
| Diagnostic controls | Stops at fabricated-lane false green | 11 controls pass |
| Target groups | 1 pass, 2 fail | 3 pass, 0 fail |

The 97.1% reduction concerns counted string replacements for the stated lookup
conditions. It does not claim reduced total Story time or first-ever matcher
initialization cost. The helper test extracts and executes the actual current
source helper with controlled collaborators; it is not an independent-host
quorum acceptance test. Runtime fact verification now invokes this regression,
so it is not an unregistered scratch probe.

Both main and utils builds pass. The existing runtime fact contract passes.
Real quorum case verification and independent audit are recorded during local
integration; a source-level GREEN alone does not claim release completion.

## Existing baseline and retained work

A bounded read of `validateReviewedSourceSources` on both unchanged main and this
candidate reports the same four existing reviewed-source binding failures:
`process-fact-levels.ts:495`, `prompt-registry.ts:520`,
`runtime-artifact-registry.ts:324`, and `command-catalog.ts:3421` (under their
existing `packages/main/src/core` or `packages/main/src/cli` directories).
The runtime registry pin was already stale before this repair. Its retained
literal and context are not changed here. No unrelated identity allowlist is
broadened or silently re-signed to make those baseline diagnostics disappear.
This comparison is not a claim that the full identity suite passes.

The earlier main integration audit already records historical performance
checkpoint integration and preserves dirty source workspaces. Current main
contains `awaiting-repair` reviewer launch guidance and the upstream
`done_prepare` scope/review check. Their old pending copies are not reimported.
Preserved baseline probes, profiling scripts, old release pin edits, other
performance micro-optimizations and B-83aa's superseded platform fixture require
their own evidence-based disposition; this bounded repair does not delete them
or claim every historical hunk has been integrated.
