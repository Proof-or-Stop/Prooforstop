# U-17 original quorum target: completed ABBA comparison

The original `emits exactly rounds x 2 verdicts after current reviewer passes` callback passed all four measured rounds. Mean target time fell from **138.406 s to 108.677 s (21.48%)**, with **20.17% fewer Git calls**. This is a controlled single-target comparison, not a whole-suite, population P95, or entire historical-checkout result.

| Round | Memo mode | Target seconds | Git calls | ls-tree calls | Verdicts |
|---|---|---:|---:|---:|---:|
| A1 | on | 108.312 | 10,005 | 627 | 6 |
| B1 | off | 138.546 | 12,533 | 1,683 | 6 |
| B2 | off | 138.266 | 12,533 | 1,683 | 6 |
| A2 | on | 109.043 | 10,004 | 627 | 6 |

Measured commit: `7ae45b65ce354561ace8d9afcb9ed3f58b746a9f`.
Source and dist byte digests plus HEAD were identical before and after; the existing build-binding check passed both boundaries. The 21 preceding original checks ran once. The same temporary Git fixture path and HEAD were restored before each target round; config and six named memo stores were reset. Every round retained the original callback assertions, three expected run IDs, six verdict events and six verdict files. Later smoke checks were deliberately outside this measurement.

OFF delegates Story hashing and changed-file resolution to the actual source at `3f010a95b24c73d68fa6df0fc715df102f9ea4f0`. Material-tree and Git-root memo OFF bypasses exact hits in the current safe implementations. This mixed baseline preserves current surrounding runtime behavior and is not a complete historical checkout. Both modes load the historical modules before timing. The prior Story-hash microbenchmark remains separate evidence.

All seven child-process APIs and promisified execFile were observed. The actual target used Git, 36 precisely classified read-only process probes, and nine source-bound filesystem-only lock-heartbeat helpers per round; it launched no business JavaScript child. The exact current heartbeat script and source digests are recorded. Those helpers do not load historical modules. Their real close events are drained after the timed callback (9–13 ms here). Unknown helpers and missing receipts from actual JavaScript children fail measurement. This preserves lock behavior while avoiding invented child counts. Earlier incomplete measurement attempts were rejected and contribute no timings to this table.

Raw attempts are losslessly gzip-compressed; round records, before/after binding, terminal status, prefix log and harness byte hashes accompany them in `u17-original-target-raw/`. These are Lab research artifacts, not signed Story or release evidence.

## Reproduce

From the Lab checkout, with its current build fresh and competing heavy work paused:

```sh
node scripts/lab/u17-original/u17-original-abba-run.mjs "$PWD" /tmp/u17-original-target-results
```

The runner uses a unique output directory and a 20-minute process-group deadline, refuses drift, and retains failures. Original callback text is unchanged by the loader; only its target invocation gains an await for post-timing child cleanup. Original timestamps and signatures still undergo the original assertions; only cross-round byte-equality comparisons exclude those dynamic fields.

For a fast check of the committed historical artifacts without rerunning the experiment:

```sh
node scripts/verify-u17-original-evidence.mjs
```

That check rederives Git/child totals from the raw attempts and verifies artifact/harness digests. It does not claim to measure the current checkout again.
