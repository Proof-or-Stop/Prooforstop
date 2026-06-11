# Transcript Diff — Real Lifecycle Memory Baseline

## Expected

User runs:

```bash
node bin/koala.js memory_benchmark_real_data --outputDir=.lattice/tmp/memory-real-baseline-user-final --format=text
```

Expected visible result:

- `Real Memory Benchmark Data: PASS`
- non-empty `corpusRecords`, `goldRecords`, `queryRecords`, and `resultRecords`
- `exactRecordMatchRate=1.000`
- `scoreableLayers=raw_event_memory,lifecycle_state_memory,checklist_evidence_memory,summary_memory`
- `boundaryOnlyLayers=advisory_memory,host_transcript_memory ... excludedFromScoring=true`
- source rows include `sourcePath`, `sourceHash`, record counts, and existence status
- output files are written under the requested non-lifecycle artifact directory
- note says the benchmark is not lifecycle gate authority, review pass, validation evidence, delivery check, receipt, vector DB, or production memory architecture

## Actual

Command completed successfully and printed:

```text
Real Memory Benchmark Data: PASS
note: Real-data baseline export is non-authoritative: it is not Koala lifecycle gate authority, review pass, validation evidence, delivery check, receipt, vector DB, or production memory architecture.
corpusRecords=495 scoreableCorpusRecords=495 boundaryOnlyRecords=0
goldRecords=495 queryRecords=495 resultRecords=495 exactRecordMatchRate=1.000
scoreableLayers=raw_event_memory,lifecycle_state_memory,checklist_evidence_memory,summary_memory
boundaryOnlyLayers=advisory_memory,host_transcript_memory boundaryOnlyRecords=0 excludedFromScoring=true
scoreable by source: activity=87 story=239 checklist=77 summary=5 evidence=87
devMemoryExcludedFromScoring=true devMemoryBoundaryRecords=0
```

The command wrote:

```text
.lattice/tmp/memory-real-baseline-user-final/corpus.jsonl   495 rows
.lattice/tmp/memory-real-baseline-user-final/gold.jsonl     495 rows
.lattice/tmp/memory-real-baseline-user-final/queries.jsonl  495 rows
.lattice/tmp/memory-real-baseline-user-final/result.json
```

Machine-readable result summary:

```json
{
  "verdict": "PASS",
  "pass": true,
  "corpusRecords": 495,
  "goldRecords": 495,
  "queryRecords": 495,
  "resultRecords": 495,
  "exactRecordMatchRate": 1,
  "boundaryGoldRecords": 0,
  "boundaryQueryRecords": 0,
  "sources": 55
}
```

## Diff

Accepted. The expected user-visible behavior is met. Record counts are higher than earlier DEV transcripts because the command intentionally reads live lifecycle artifacts, including the review and validation metadata produced later in the story. This is expected for a real-data baseline and not a mismatch.

