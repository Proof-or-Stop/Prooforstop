## Trigger Event
2026-06-24 user requested development of docs/requirements/decisions/repro-first-story-intake-experiment.md until fully implemented. This story starts the first shippable runtime slice, focused on candidate-only evidence intake before gate enforcement.

## Key Insights
The recent evidence architecture docs define a shared EvidenceRuntime with immutable artifacts, registries, append-only ledger streams, and ReproIntakeService. Repro-first can proceed candidate-only without waiting for full proof admissibility enforcement.

## Solution Tradeoffs
Implementing every gate integration at once would be too risky. This slice should create the reusable artifact/storage foundation and Repro workflow commands, while keeping DONE/Authority consumption as a later integration story.

## Conversational Texture
The user wants this developed rather than kept as documentation. The implementation should be practical, incremental, and verifiable with smoke tests, while preserving the boundary that raw red probes are candidate evidence only.
