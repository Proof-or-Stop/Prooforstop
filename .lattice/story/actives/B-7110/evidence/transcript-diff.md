# User Value Acceptance Transcript

Story: B-7110
Date: 2026-06-09

## Expected

The user asked to write the agreed Parallel Wave / Parallel Development
integration into `Lattice-Parallel-Development-Capability.md`.

The completed document should make these points visible:

- Parallel Wave remains read-only planning.
- Parallel Development consumes a frozen Wave snapshot and coordinates execution.
- Proof remains in story, review, validation, receipt, and claim gates.
- Projection-only outputs such as `parallel_report` are not binding artifacts.
- `parallel_wave_create` uses `schemaVersion` / `generatedAt`, while
  `parallel_wave_inspect` and `parallel_plan` use `waveSchemaVersion`.

## Actual

Command:

```bash
sed -n '124,205p' Lattice-Parallel-Development-Capability.md
```

Observed:

```text
Parallel Wave plans.
Parallel Development coordinates execution.
Story, review, validation, receipt, and claim gates prove.
```

The same section states that only `parallel_wave_create`,
`parallel_wave_inspect`, and `parallel_plan` may seed the frozen snapshot, while
`parallel_report`, `parallel_status`, and `parallel_merge_queue` are
projection-only and cannot be the binding artifact without the original
full-envelope Wave artifact.

Command:

```bash
lattice parallel_wave_create --format=json
```

Observed field summary:

```json
{
  "schemaVersion": "koala.parallel_wave.v1",
  "generatedAt": true,
  "waveSchemaVersion": false,
  "fullEnvelope": {
    "storyRefs": true,
    "hostCandidates": true,
    "evidenceRefs": true,
    "mergeOrder": true,
    "authority": true
  },
  "authority": {
    "productionDone": false,
    "authorityChanged": false,
    "receiptRefs": []
  }
}
```

## Diff Notes

The actual document matches the user-facing outcome. It explains how the two
capabilities combine without promoting Parallel Wave into an executor or proof
source, and it records the schema-marker distinction found by reviewers.

