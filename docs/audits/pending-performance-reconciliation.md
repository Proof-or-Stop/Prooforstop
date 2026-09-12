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
The real `qsm-020` full-envelope replay/tamper case passes with a clean protected
mutation guard and no remaining fixture/process/ticket/quarantine residue.
A source-level GREEN alone does not claim release completion.

An additional `qsm-022` run passed its body but was correctly rejected by the
outer protected-mutation guard while audit documentation and Claude hook
activity changed the workspace. A second overlapping run preserved all tracked
bytes but still observed the Claude activity append. Neither aggregate FAIL is
reported as PASS. The final confirmation ran after audit completion without
concurrent writers: run `qsm-13e706b2-c1b7-4c1d-957f-16a37beadfd1` returned
aggregate PASS, `protectedMutationGuard.clean=true`, zero observed mutations,
matching protected-state digests and zero remaining residue. The case took
100,765 ms; this timing is not a before/after speed comparison. No runner rule
or hook was disabled.

## Independent Claude CLI review

The first tool-enabled review timed out after 240 seconds and produced no final
verdict. It is not acceptance evidence. A second bounded, tools-disabled review
received the complete repair diff, target test and these notes; it completed
successfully with session `360211b7-e352-4cb7-be95-46af024aaddb` and verdict
**no blockers**. That reviewer inspected the supplied code; it did not execute
commands. The actual tests above were run separately by the implementation task.

The review confirmed preservation of both normalization passes, live mutation
and regex behavior, captured exception checks and ordered canonical subsets.
It identified these evidence limitations: AST extraction is a helper test, not
host assurance; operation counts are not elapsed Story time; mutation checks
need their own process; and any bounded subprocess can fail on a stalled host.
The regression is executed in its own child process, acquires no validation
capacity slot, and retains its bounded 30-second failure timeout. No safety
timeout or gate was weakened to turn that advisory into a passing claim.

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
