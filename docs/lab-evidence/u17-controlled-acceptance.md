# U17 controlled acceptance evidence

Two bounded A/B experiments passed. These results apply to the measured fixture and one real quorum case; they are not full-suite performance or P95 evidence.

## Microbenchmark

One temporary Git repository, unchanged HEAD `1232f64f1065d90a901eb9eeacb750d437748909`; 20 material-hash and Git-root queries per fresh process, ON/OFF/OFF/ON. Complete returned arrays were identical. A subsequent committed content change produced a different material hash (fresh-process positive control; in-process invalidation belongs to the existing correctness regressions).

| Mode | Wall ms | ls-tree | show-toplevel | All instrumented Git calls |
|---|---:|---:|---:|---:|
| ON | 473.879 | 1 | 1 | 42 |
| OFF | 883.131 | 20 | 20 | 80 |
| OFF | 880.463 | 20 | 20 | 80 |
| ON | 474.180 | 1 | 1 | 42 |

Timing includes Node startup. Raw evidence: [micro raw log](u17-controlled-raw/u17-micro-ab.log).

## Actual quorum case

Case: `worktree-local CLI commits the exact quorum batch through the production entrypoint` in `quorum-submit-smoke.js`. Reviewer evidence was initialized once; its complete temporary repository was snapshotted and restored to the same path before each round. Every round asserted baseline HEAD `e67fe3e405f4387982f43f8901ebb1bff45a9e88`.

| Mode | CLI case ms | ls-tree | show-toplevel | All instrumented Git calls | CLI PID |
|---|---:|---:|---:|---:|---:|
| ON | 1928.873 | 12 | 1 | 141 | 53446 |
| OFF | 2128.579 | 15 | 19 | 162 | 54233 |
| OFF | 2150.385 | 15 | 19 | 162 | 55049 |
| ON | 1894.467 | 12 | 1 | 141 | 55872 |

All original assertions remained: CLI exit zero; metadataCommitSha present; HEAD advanced; clean Git status; exactly six host verdict events and six verdict files. The bounded 60-second invocation passed. Per-CLI PID metric files prove inherited instrumentation. Mean measured case duration decreased about 10.6%; 21 instrumented Git subprocesses were avoided per invocation.

Dynamic timestamps, signatures and resulting commit SHAs were not compared byte-for-byte. No claim is made that all raw receipt bytes match. No additional quorum negative cases were removed from the source suite; they were outside this selected case and not run in this A/B. Existing correctness regressions provide the separate invalidation/negative-control evidence.

Raw evidence: [quorum raw log](u17-controlled-raw/u17-quorum-ab.log) and per-process metric JSON files in `u17-controlled-raw/`.

## Instrumentation and portable probes

OFF mode changes only the two memo hit branches using exact loader anchors. Git object/ref resolution, replacement-ref checks, hashing and filesystem identity checks remain unchanged. Both modes instrument execFileSync/execSync identically. Metrics count instrumented Node Git calls, not arbitrary Git subprocesses launched by shell hooks.

Portable probes are stored under `scripts/lab/`:

- `u17-memo-ab-preload.mjs`
- `u17-micro-ab.mjs`
- `u17-quorum-ab-loader.mjs`

Micro driver accepts repository root and output directory as positional arguments; defaults use import.meta.url and mkdtemp. Quorum loader locates its sibling preload through import.meta.url; `U17_AB_OUTPUT_DIR` optionally selects output, otherwise mkdtemp is used. It modifies only an in-memory test module and temporary fixtures. The original probes produced the measurements above. Independent relocation tests ran both portable drivers successfully. The persisted micro driver was then run twice with the same existing output parent: each run created a unique result directory and all eight PID metric files matched their own report. The persisted quorum driver also passed. Specified output paths are parent directories; each invocation creates a unique run directory to prevent stale metric reuse.

Reproduction commands:

```sh
node scripts/lab/u17-micro-ab.mjs
node --import ./scripts/lab/u17-quorum-ab-loader.mjs packages/main/dist/tasks/quorum-submit-smoke.js '--grep=worktree-local CLI commits the exact quorum batch through the production entrypoint'
```

## Remaining original acceptance target

The original plan names `emits exactly rounds x 2 verdicts after current reviewer
passes`, whose incremental assertions require preceding shared-fixture history.
The selected production-entrypoint case above does not replace that target.
Acceptance still requires running its predecessors in order, preserving every
assertion, then comparing the original target against an identical restored
fixture with fresh memo state in each mode. An isolated grep is insufficient.
The original target performance acceptance remains open.
