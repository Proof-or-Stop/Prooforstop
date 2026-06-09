# B-d4dd User-Value Transcript Diff

## Expected

The memory benchmark harness should let a user validate the proposed lifecycle-memory baseline without treating the result as Koala lifecycle authority. A user should be able to run a fixed 10k / 100k / 1M comparison, see recall metrics and MemoryScore per tier, and see contract failures for unsupported tiers or per-metric minima violations.

## Actual

Command:

```bash
node bin/koala.js memory_benchmark_compare --candidateCounts=10000,100000,1000000 --queryCount=120 --seed=7 --format=text
```

Observed:

```text
Memory Benchmark Compare (10,000, 100,000, 1,000,000)
comparison verdict: PASS
baselineCandidateCount: 10,000
baselineQualityScore: 90.00

T1 / 10,000 -> verdict=PASS, memoryScore=100.00, threshold=92.00, exactRecall@1=1.000, recall@10=1.000, MRR@10=1.000, precision@10=1.000, qualityScore=90.00, scaleStabilityScore=1.000, hardFails=0
T2 / 100,000 -> verdict=PASS, memoryScore=100.00, threshold=90.00, exactRecall@1=1.000, recall@10=1.000, MRR@10=1.000, precision@10=1.000, qualityScore=90.00, scaleStabilityScore=1.000, hardFails=0
T3 / 1,000,000 -> verdict=PASS, memoryScore=100.00, threshold=86.00, exactRecall@1=1.000, recall@10=1.000, MRR@10=1.000, precision@10=1.000, qualityScore=90.00, scaleStabilityScore=1.000, hardFails=0

note: Benchmark PASS is not Koala lifecycle gate authority, review pass, validation evidence, or delivery check.
```

Command:

```bash
node bin/koala.js memory_benchmark_compare --candidateCounts=50000 --format=json
```

Observed:

```text
unsupported candidateCounts=50000; supported fixed-tier candidate counts are 10000, 100000, 1000000
```

Command:

```bash
node --input-type=module -e 'import { runMemoryBenchmark } from "./packages/main/dist/core/memory-benchmark.js"; /* per-metric minima probes */'
```

Observed:

```json
[
  {"overrides":{"exactRecallAt1":0.9},"verdict":"FAIL","thresholdPassed":false,"memoryScore":99.30556,"threshold":92},
  {"overrides":{"recallAt10":0.89},"verdict":"FAIL","thresholdPassed":false,"memoryScore":99.23611,"threshold":92},
  {"overrides":{"mrrAt10":0.74},"verdict":"FAIL","thresholdPassed":false,"memoryScore":98.19444,"threshold":92},
  {"overrides":{"precisionAt10":0.69},"verdict":"FAIL","thresholdPassed":false,"memoryScore":97.84722,"threshold":92}
]
```

## Diff

The actual behavior matches the expected product outcome. The user can now run a real CLI benchmark harness for the baseline document, compare 10k / 100k / 1M candidate counts, inspect recall and evidence-related scoring, and verify that unsupported/custom candidate counts plus per-metric contract violations fail instead of being hidden by a high aggregate score. The transcript also preserves the authority boundary: benchmark PASS is explicitly not REVIEW / TEST / DONE gate evidence.
