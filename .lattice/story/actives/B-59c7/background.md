## Trigger Event
On 2026-06-19, story B-7559 audited and merged docs/parallel-decomposition-spec.md to main. Section 8 of that spec prescribes building the enforcement gate as a 6-story contract-first program; this Story 0 is the serial contract that must be frozen first before the parallel impl stories can start.

## Key Insights
The spec already names every symbol: a new module packages/main/src/core/parallel-decomposition.ts must export pure-function signatures computeWriteSet/globsOverlap/evaluateDecompositionGate (as NotImplemented skeletons), plus the ParallelGateConfig type, the VALID_PARALLEL_MODES constant, and the ParallelDecompositionBlock reason enum. The AuditConfig interface in audit-config.ts gains a parallelGate field (type only; resolution logic is Story 3). Real anchors: audit-config.ts uses ReadonlySet<AuditMode> and a per-field resolveAuditConfig; this story must NOT add resolution logic, only the interface field.

## Solution Tradeoffs
Write only signatures + skeletons that compile and throw NotImplemented, never real logic, so the contract freezes a stable surface every downstream story imports read-only. Keep the AuditConfig change to a type-only field addition so the resolution edit in Story 3 touches disjoint lines. Bound scope to the new file plus the audit-config.ts interface block only.

## Conversational Texture
The operator chose to run the whole 6-story program to completion with genuine Claude+Codex dual-host (3x2) review per round. The value of this story is a frozen, type-checking contract that unblocks four parallel impl stories; acceptance is that tsc compiles and every symbol Stories 1-5 import is exported with a NotImplemented body.
