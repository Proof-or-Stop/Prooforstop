# Memory intake measurement Lab

This bounded Lab corrects per-query benchmark timing. It does not remove full-scan fallbacks or change pack selection, freshness, identity, or the existing warm-batch target. Local maintenance evidence is not formal Story DONE.

## Target RED and repair

The identical command is `node scripts/verify-memory-query-timing.mjs`.
RED commit `1da2aac95f` records `MEMORY_QUERY_TIMING_EXCLUDES_BUILD`: two constructions costing 11 and 17 clock units report [0,0]. The source-level unit executes the actual extracted query runner and indexed batch function with a deterministic clock and controlled collaborators. It proves the timing boundary, not real-machine latency or semantic pack parity by itself.

The repair times each actual construction. Indexed batches accept an optional observation callback; existing callers retain the same packs and source freshness checks. Shared source validation remains outside per-query values and inside batch elapsed. Expected corrected values are [11,17], with direct total 28 and indexed total 33 including 5 units of setup. Whole-runtime parity is checked separately using the real benchmark.

## Real workload measurements

`before-full.log` and `before-intake.json` were captured on main before this repair, approximately at 0.3.349 (`3d4aaca544`), but the original capture lacks a committed HEAD binding. Their deltas are descriptive only; the no-regression conclusion rests on the after-run reference/optimized digest parity and M3–M6 controls. `after-full.log` and `after-intake.json` execute this Lab's independently built source. Both run the existing million-record performance smoke with the same fixed generator, query policy and target 2000ms, under the committed diagnostic observer. This is a sequential shared-host comparison, not a statistical speed claim. The change corrects measurement and is not expected to accelerate execution.

The observer measures four existing fallback sites: 1 expanded indexed tokens whose exact bucket overflowed; 2 direct exact bucket overflow; 3 fuzzy map overflow; 4 substring expansion overflow. Its counters cover the entire smoke process, including reference/indexed/prime and semantic controls. Do not equate the whole-process 78 fallbacks with the cold report's 26 or attribute all fallback milliseconds to cold. Source scanning preserves uncapped result coverage.

## Actual CLI sampling

`live-intake.json` contains two fresh processes each for session_brief, aux_doc_list, slim story_get and REVIEW story_list on real main. Both session_brief calls build one pack and hit the durable cache; the other six calls build none. All eight observed zero query fallbacks. This is a selected 8-call sample, not historical production frequency.

Both session_brief calls still built an in-memory index before cache lookup. A separate sample (`session-timed.json`) measured 183.041ms for that build. The implementation's fallback calls buildRuntimeMemoryIndex, not the explicit persistence operation rebuildRuntimeMemoryIndex. This observation is a candidate for later cost investigation; it does not justify changing cache freshness or writing a persistent index on every CLI call in this Lab.

## Verification and environment

The new worktree initially lacked @types/ws. Its first build failed for that dependency, not for the target bug. Installing its own packages/main dependencies with npm ci restored the build; dist is independent and the global installation is unchanged. Deterministic RED/GREEN, real memory smoke output, and the local signed Lab record provide distinct evidence. No cold latency contract is invented by applying the warm limit to cold work.

## Before/after observations

| Measurement | Before | After |
|---|---:|---:|
| Deterministic query construction 11/17ms | [0,0] | [11,17] |
| Reference full batch |42047ms|43263ms|
| Indexed cold batch |13666ms|14055ms|
| Indexed warm batch |263ms|280ms|
| Index build |11276ms|11687ms|
| Reported warm p50/p95 |0/0ms|0/0ms|
| Cold tokenScanFallbacks |26|26|
| Whole-smoke fallback visits |78|78|
| Whole-smoke fallback scan time |12840.041ms|12676.241ms|

The warm percentiles remain rounded 0 in this real workload: after correction they enclose actual cache-hit construction and may legitimately round sub-millisecond samples to 0. They do not represent shared batch preparation. The deterministic fixture distinguishes correct sampling from the old post-construction timer even when real warm integer percentiles happen to match. No speedup is claimed; other local tasks and a small verification command were active during the shared-host measurements. Both actual million-record runs pass semantic parity and the unchanged 2000ms warm target, with equal reference/optimized digest `19e61cac88d5e038e5114c0059eb7b259ba7e8685c04dc7fdd41ed2c63bf1dc8`. The existing M3-M6 smoke also passed its cache mutation, cross-process hit, selection window and semantic controls.

## Audit corrections and release boundary

The first independent audit confirmed the repair and rejected its standing regression wiring. The runtime contract now executes the deterministic verifier with a bounded child timeout, and a named npm script exposes it. The verifier binds its sources to its own module location. The original eight-call capture predates the indexRebuildMs observer field; it is preserved as live-intake-v1.json. The committed sampling driver and current observer produce live-intake.json.

No runtime release has been performed. The repository Lab maintenance guide, Explicit release and cleanup, requires an explicit integration request; finish then chooses the current patch version, updates both manifests/lockfiles and CLI brand constant, builds the candidate and main, and checks the new CLI version. This isolated Lab therefore retains its base version until finish. It is never installed globally or presented as released main; there is no exemption permitting two released implementations under one version.

The second eight-call sample (live-intake-v2.json) is explicitly bound to main commit `de2b236e1ae09e21edfe77bc3eaee4cc9725849c`, which advanced during this Lab. It again observes two session_brief cache hits, zero fallbacks in all eight calls, and index construction of 129.574ms and 139.424ms. It does not establish historical cold frequency or comparable before/after CLI latency.

## Static registry and observer follow-up

The static scanner starts from proof-or-stop.config.json validate.commands and follows its bounded registered/imported closure. It is not a whole-repository glob over scripts/lab. The manual sample-memory-intake driver is not in that configured closure; it does not gain a scanner exemption. EX-MEMORY-QUERY-TIMING instead binds the new child call in the already canonical runtime verifier (configuration index 16), not a child edge inside the leaf timing test. u18-static-report.json includes the full command coverage and shows this boundary; u18-static-edges.log and static-edge-provenance.json bind the successful consuming run.

Existing registry entries were narrowly refreshed for changed caller line positions, exact source excerpts and current dependency hashes, preserving unrelated entries and invocation policy. This is an explicit reviewed edit, not an automatic scanner approval/update mode. The new entry binds only its actual caller, verifier, two read sources and TypeScript package/lock dependencies. The runtime verifier now relies on executable timing controls rather than format-dependent expression substrings.

The observer now validates its output path before loading measured code, rejects missing and ambiguous source needles, decodes binary module source correctly, and matches each fallback site's distinct branch context. Numeric site identities 1–4 retain their documented meanings independent of source order. Historical captures used the earlier observer; observer-current.log/intake record a fresh real million-record validation of the hardened observer. The live sample is regenerated with its new observer digest.

The hardened-observer live sample again has two cache hits and zero fallbacks across eight commands. Its pre-hit index builds are 173.678ms and 182.938ms; live-intake-v2.json preserves the earlier 129.574ms/139.424ms observations. These samples are not used as a speed comparison.
