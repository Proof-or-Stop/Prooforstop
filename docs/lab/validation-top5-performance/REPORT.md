# Validation performance: preserved RED/GREEN evidence

This release combines the validation-top5-performance Lab with the independently verified validation-planning-scan repair (source a754176b77, imported as 852938e89d). All rows below are historical paired experiments, not measurements of the future release commit. Original log bytes and their SHA-256 digests are preserved in manifest.json.

| Optimization | Before | After | Observed reduction | Evidence |
|---|---:|---:|---:|---|
| Admissibility registry smoke | 306.907 s | 295.596 s | 3.69% | [RED](logs/top5-4-red.log), [GREEN](logs/top5-4-green-cache.log) |
| Verification run/guard smoke | 354.728 s | 311.240 s | 12.26% | [RED](logs/top5-1-red-353.log), [GREEN](logs/top5-1-green.log) |
| Identity lineage delivery | 699.948 s | 692.099 s | 1.12% | [RED](logs/top5-3-red.log), [GREEN](logs/top5-3-green.log) |
| Heartbeat smoke | 135.069 s | 127.935 s | 5.28% | [RED](logs/top5-5-red.log), [GREEN](logs/top5-5-green.log) |
| Initial planning wall time, 71 rows | 6.458 s | 0.106 s | 98.35% | [RED](logs/planning-red.log), [GREEN](logs/planning-green.log) |
| Initial planning full scans | 71 | 1 | 98.59% | [before](logs/planning-before.json), [after](logs/planning-after.json) |
| Initial planning logical reads | 3858.73 MB | 54.35 MB | 98.59% | Same planning profiles |
| Native planning fanout shard | 421.541 s | 346.339 s | 17.84% | Same planning logs |

## Behavior and protection

Admissibility mutation tests use two isolated workers and a fresh disposable compilation cache. The 19 child outcomes and 11 binding mutation targets are preserved. The parallel-only candidate regressed to 336.532 s and was rejected; its [log](logs/top5-4-green.log) is retained. Mutation-anchor and copied-package-metadata compatibility repairs are present in both accepted measurements and are not counted as speedups.

One synchronous execution identity observation reads each resolved executable once. Initial synchronous batch planning separately shares one implementation scan. Independent plans, actual launches, completion and publication retain fresh observations. Exceptions and await continuations cannot retain planning scope. Canonical executable digests memoize only a pure computation over identical source text, bounded to 32 entries and 4 Mi characters. Current bytes, imported origins and expected bindings are still checked. Heartbeat and delivery compile caches are per-run disposable fixtures, never cached validation results.

The combined candidate 852938e89d passed scope-boundary regression and the complete runtime contract. Its native fanout passed with 71 assertions, 2 executions, one initial planning scan, 93.141 ms planning, and 308.174 s full wall time. This is a separate combined-candidate observation, not another paired speedup. See [native log](logs/planning-combined-planning-green.log), [boundaries](logs/planning-combined-boundaries.log), [runtime contract](logs/planning-combined-runtime-contract.log), and [heartbeat GREEN](logs/planning-combined-lab-green.log).

## Limits and excluded result

Measurements include full native command wall time, fixture setup and cleanup, and any native bootstrap work; explicit preparation and Lab administration are excluded. Logical bytes count repeated reads, not physical disk traffic. Host contention was uncontrolled. Each pair is one observation; small reductions, particularly 1.12%, are not a stable performance guarantee. The dominant renewal case did not improve. The different pairs use staged baselines 0.3.352, 0.3.353 and 0.3.356; their savings must not be summed as a full-suite result. The full validation inventory was not rerun in this experiment.

Quorum-submit optimization is NOT claimed. All 73 cases passed in its latest experiment, but the native protected-directory guard recorded 4022 events and returned FAIL after 1017.206 s. Worktree and independent-clone attempts failed the same aggregate protection. No effective RED/GREEN performance pair exists for it; its [failed-run log](logs/top5-2-red-cache-root356.log) remains evidence of a blocker. Protection was not disabled.

Historical Lab measurements are local maintenance evidence, not formal Story DONE or independent release audit. Finish-time audit and candidate/post-merge results are recorded separately by the Lab CLI and release notes.

## Integration source-evidence verification

Integration preserves GitHub main commit 6c163f9693 and local main 00b1ec05ae. The new review-intent-cycle regression and full process-fact contract passed after the merge. Current static source bindings were reviewed against the changed wrapper, fixture compilation-cache helpers, mutation worker transport, and identity regressions. The review keeps each original callsite, including historical duplicate exception IDs, and adds the exact planning-observation child with source dependencies. No scanner rule or refusal was relaxed.

The main static baseline passed. After integration and reviewed rebinding, all 270 manifest entries have current covering evidence; 330 invocation-specific exception uses pass with zero unresolved, nested, or unexpanded commands. Tampered evidence and omitted dependencies remain rejected, and the version-bump source-evidence regression passed. See the release-static-final, release-static-boundaries, release-review-intent-final, and release-process-contract-final logs under logs/. These checks precede the final versioned Finish candidate and are not a claim that Finish or publication has already completed.

A subsequent combined GREEN attempt on 23af3e0278 passed all native heartbeat groups but failed the unchanged performance threshold: 151.881 s versus the maximum 133.718 s. The runtime/planning children were not reached because the performance assertion stopped the command. See [rejected candidate](logs/release-combined-green-rejected.log). This attempt is not release GREEN; later verification must bind the final synchronized candidate.

## Retained integration and rejected release candidate

The synchronized candidate 6ab34f538c measured 132.247 s heartbeat, 291.696 s native fanout, one planning scan and 107.885 ms planning. Its [complete log](logs/release-358-combined-green.log), [static scan](logs/release-358-static.log) and [admission-order regression](logs/release-358-admission-order.log) are retained with SHA-256 digests. The static scan has 331 exception uses after the main 0.3.358 merge.

Finish prepared candidate c9b66d93e9 at 0.3.359, and its fixed candidate command passed (131.912 s heartbeat; 294.609 s fanout; one planning scan, 102.281 ms). However, the [vendor response](logs/audit-attempt-1-response.json) reported four release-material issues and omitted required changed-file read references. The CLI rejected that response; no accepted audit or main integration resulted. [Complete first Finish output](logs/release-finish-attempt1.log) preserves the actual failure. The generated release commit was reverted using official Lab reopen; 0.3.359 here identifies a withdrawn candidate, not a completed release of this Lab.

The repair clarifies imported source-host release provenance, corrects the rejected-log link, retains the previously missing 0.3.358 measurement above, and restores the unrelated trailing blank line in review-test-index-transition.ts. Original failed audit evidence remains unchanged. These corrections do not claim a subsequent audit PASS; a fresh Finish remains required.

The first response also omitted these changed files from its required readRefs, which is why the CLI rejected its coverage contract: [top5-1-green.log](logs/top5-1-green.log), [top5-1-red-353.log](logs/top5-1-red-353.log), [top5-2-red-cache-root356.log](logs/top5-2-red-cache-root356.log), [top5-3-green.log](logs/top5-3-green.log), [top5-3-red.log](logs/top5-3-red.log), [top5-3-runtime-contract-green.log](logs/top5-3-runtime-contract-green.log), [top5-4-green.log](logs/top5-4-green.log), [top5-4-red.log](logs/top5-4-red.log), [top5-5-red.log](logs/top5-5-red.log). They remain retained inputs; this coverage failure has not been relabeled as an accepted review.
