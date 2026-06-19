# B-59c7 — User-value acceptance (transcript + diff)

**Deliverable:** the frozen contract for the parallel-decomposition gate — a new module
`packages/main/src/core/parallel-decomposition.ts` (types + constants + three NotImplemented
function skeletons) plus an optional `parallelGate` field on the `AuditConfig` interface.
"Running it" = the module compiles under tsc and every skeleton throws `NotImplemented`.

## Rhythm: expected (PLAN) → actual (run) → diff

### Expected
tsc compiles; the module exports `ParallelGateConfig`, `ParallelGateMode`, `VALID_PARALLEL_MODES`,
`ParallelDecompositionBlock`, `GlobOverlapResult`, `DecompositionGateResult`, and
`computeWriteSet`/`globsOverlap`/`evaluateDecompositionGate` as NotImplemented skeletons;
`AuditConfig` gains an optional `parallelGate` field; no real logic; existing AuditConfig
literals still compile.

### Actual
- `npm --prefix packages/main run build` (tsc) → **PASS** (also independently re-run by the Codex host).
- `node -e "require('./packages/main/dist/core/parallel-decomposition.js')"` → all six symbols exported.
- Calling each skeleton → `Error: NotImplemented: computeWriteSet` / `globsOverlap` / `evaluateDecompositionGate`.
- `resolveAuditConfig` body and `HARD_DEFAULTS` unchanged (parallelGate optional → resolution deferred to Story 3).
- `lattice validate` → PASS (tsc + authority-client-smoke + authority-completion-smoke).

### Diff (expected vs actual)
One review-driven change: the initial draft also exported `PARALLEL_MODE_FALLBACK`, which is not
in the spec §8 Story-0 export list and has no consumer yet → removed (deferred to Story 3). After
that, expected == actual; an importer of the contract sees exactly the §8 Story-0 surface.

## Assurance
Review escalation: **full-3x2 (3 rounds × 2 hosts)** — genuine cross-provider dual host:
host 1 = Claude (`lattice-review-concept/quality/test-coverage` lanes), host 2 = Codex
(`codex exec review`, run twice, even ran tsc itself). Both passed on the final material;
4 findings were filed and all resolved. This is a real two-independent-host strong proof
(not degraded-single-host).
