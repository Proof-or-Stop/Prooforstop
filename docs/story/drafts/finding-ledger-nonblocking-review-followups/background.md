## Trigger Event
On 2026-09-05, B-fe8f independent Claude CLI session cbc9df39-80c3-475b-a3d4-1d0e1e35c257 completed three source-only review rounds at e0a79946 and metadata5657b83. Codex independently checked clustering semantics and the later ad0c1b79 projection repair. These observations are tracked separately from the verified projection defect, whose RED d69169e4 and GREEN ad0c1b79 belong in B-fe8f.

## Key Insights
The source observations above do not currently prove a B-fe8f acceptance failure. Story3 deliberately supplies schema-neutral signed persistence; assessment and routing policy belong to downstream consumers. Existing adapter call sites are wired, corrupt authoritative-ledger reads correctly fail closed (Claude R1-02 is expected behavior, not a defect), and the legacy selector remains discriminating. Performance is unmeasured and grouping recovery does not change signed Finding gate truth.

## Solution Tradeoffs
This named draft is the accountable backlog owner because gap_log refused to extend B-META provenance with invalid_binding_shape. Do not repair that unrelated provenance chain in B-fe8f. Preserve the source pointers and uncertainty; do not treat this compatibility accounting as a signed deferral or as evidence of repair. Re-evaluate each item when its semantic consumer is implemented, on relevant source/hash change, or when a reproducible user/acceptance/gate regression is found. A confirmed protected-surface or current acceptance blocker returns to B-fe8f while active; otherwise it remains for a separately scoped follow-up.

## Conversational Texture
The user explicitly required fixing major or acceptance-blocking defects now while recording unrelated medium/low concerns with evidence and a traceable later owner. They rejected expanding one Story merely to make the whole repository green. This draft records those boundaries and does not authorize starting another implementation, changing frozen B-fe8f requirements, bypassing a lifecycle gate, or claiming that static observations are runtime receipts.
