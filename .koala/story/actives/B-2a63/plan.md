# B-2a63 Plan

## CHK-001

Goal: make the real-data baseline outcome user-observable. The command output and JSON result must show non-empty corpus/gold/query/result counts, real source metadata (`sourcePath`, `sourceHash`, `recordId`), scoreable lifecycle layer counts, boundary-only/advisory counts, and the non-authoritative note.

Implementation outline:
- Add a real-data core module that reads current project lifecycle sources from the repository root.
- Classify activity/story/summary/checklist facts into scoreable layers.
- Classify dev-memory/advisory records as boundary-only and excluded from scoring.
- Return stats and sample source metadata in both text and JSON output.

Risk controls:
- Do not change the existing virtual `memory_benchmark_run` / `memory_benchmark_compare` behavior.
- Do not treat dev-memory or host transcript content as lifecycle truth.
- Do not claim production memory performance.

## CHK-002

Goal: expose a CLI that can produce real baseline artifacts. With `--outputDir`, it writes `corpus.jsonl`, `gold.jsonl`, `queries.jsonl`, and `result.json`; without `--outputDir`, it remains inspectable through stdout text/json.

Implementation outline:
- Add `memory_benchmark_real_data` to the memory benchmark handlers and CLI schema.
- Support `format=text|json`, `json`, `outputDir`, and optional source path overrides for tests.
- Register command policy/config/process fact metadata as non-gate benchmark output.
- Update documentation with the real-data command and limitation.

Risk controls:
- If `outputDir` writes files, they are user artifacts only, not Koala gate evidence.
- Text and JSON output must both include the non-authoritative note.
- Unsupported or empty real-data sources must return clear FAIL status rather than fake PASS.

## CHK-003

Goal: mechanically verify the real-data baseline and boundary rules.

Implementation outline:
- Add smoke coverage using temporary real JSONL/story/dev-memory data so tests do not depend on this repository having a specific number of stories.
- Run the command against the actual repository for user transcript evidence.
- Assert scoreable data is non-empty, gold/query records match corpus records, dev-memory stays boundary-only, and empty activity/story sources fail.

Risk controls:
- Keep the scoring proof deterministic and simple: exact matching over generated gold/query records, not a new vector index.
- Boundary-only records may appear in corpus export for audit, but must be excluded from gold/query scoring.
- Preserve host-neutral behavior and avoid machine-specific assumptions beyond source file existence.
