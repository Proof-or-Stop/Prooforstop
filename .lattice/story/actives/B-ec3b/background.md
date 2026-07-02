## Trigger Event
2026-07-02 side conversation approved development of playbook memory entry-layer optimization after the full 1,000,000-record baseline passed in 20,705 ms, which is acceptable for release validation but too slow for normal session_brief, handoff, story intake, DONE closure, and final-response entrypoints.

## Key Insights
The runtime memory layer already proves active playbooks and dev-memory can be consumed safely, but current full-scan behavior is a correctness path rather than a hot path. The first slice must preserve non-authoritative gateEvidence=false semantics while introducing a derived index and parity tests.

## Solution Tradeoffs
Start with the first three milestones only: profiling evidence, index schema, atomic rebuild, and indexed two-stage retrieval. This keeps the debug surface narrow while proving that optimized lookup can preserve current runtime-pack semantics before later slices expand the surface.

## Conversational Texture
The user wants Proofbound development to become increasingly lesson-aware without turning memory into fake proof. The response should be concrete, evidence-first, and careful to distinguish smarter workflow behavior from claims about model intelligence.
