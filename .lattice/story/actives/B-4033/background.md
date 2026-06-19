## Trigger Event
On 2026-06-19, Story 0 (B-59c7) merged the parallel-decomposition contract (types + NotImplemented skeletons) to main. This Story 1 fills the static overlap engine. Dogfooding the contract-first spec found that putting computeWriteSet/globsOverlap and evaluateDecompositionGate in one file would make Stories 1 and 2 collide; the operator chose to split impls into separate files to keep them parallel.

## Key Insights
The spec Section 4.2 defines a deliberately conservative two-tier static check: tier-1 literal-path intersection (zero false positives) and tier-2 shared-directory-prefix heuristic (may over-flag, never under-flags), plus a broadness classifier (NARROW vs BROAD over the grammar literal | dir/* | dir/**). There is NO minimatch in the project; pathMatchesPattern in core/scope-contract.ts is hand-rolled and cannot do pattern-vs-pattern. globsOverlap returns { overlap, pairs, broadSide } per the frozen GlobOverlapResult contract. computeWriteSet derives created+modified paths from a ScopeContractData.

## Solution Tradeoffs
Implement in a NEW file core/parallel-decomposition-overlap.ts (import types from parallel-decomposition.js) rather than editing the frozen contract, so this story is file-disjoint from Story 2/3/4 and genuinely parallel. Export the real computeWriteSet + globsOverlap + a grammar validator; the contract skeletons remain reference-only until Story 5 reconciles re-exports. Keep it pure (no I/O).

## Conversational Texture
The operator is running the whole 6-story program with genuine Claude+Codex dual-host (full-3x2) review per story. The value here is a correct, conservative overlap engine the gate verdict (Story 2) can call; acceptance is unit tests covering literal overlap, prefix heuristic, broadness, and grammar rejection, all green under tsc.
