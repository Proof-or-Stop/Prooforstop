# Plan: Parallel-decomposition gate verdict (B-986c, program Story 2)

Chosen: tier1-in-gate-advise-rest. A pure `evaluateDecompositionGate` in a NEW file
`core/parallel-decomposition-gate.ts` that hard-blocks only on provable scope contradictions
(tier-1 literal overlap, broad-glob-when-configured, peer-contract-missing) and advises on
everything heuristic; `fake_dependency_chain` is advise-only without a cited symbol (spec 4.5).

## CHK-001 — evaluateDecompositionGate in core/parallel-decomposition-gate.ts

Imports: `computeWriteSet`, `globsOverlap`, `classifyBroadness` from `parallel-decomposition-overlap.js`;
the types (`ParallelGateConfig`, `ParallelDecompositionBlock`, `DecompositionGateResult`) from
`parallel-decomposition.js`; `StoryInfo`/`ScopeContractData` from `types.js`; `TERMINAL_PHASES`
from `parallel-policy.js` (newly exported).

Single-source fix (INIT-001): in `parallel-policy.ts`, hoist the local `new Set(['DONE','DISCARDED'])`
to a module-level `export const TERMINAL_PHASES: ReadonlySet<string>` and have
`resolveParallelSafety` + `summarizeParallelPolicy` use it (no behaviour change).

Algorithm over (story S, peers, contracts, cfg):
1. `assertsParallel(x)` = `x.parallelSafe === 'yes'`. If S does not assert parallel, still
   compute advisories but emit NO parallel-specific block.
2. `activePeers` = peers where `storyId !== S.storyId` AND `!TERMINAL_PHASES.has(phase)`.
3. `writeSet(x)` = `computeWriteSet(contracts.get(x.storyId))`, or `[]` if the contract is absent.
4. **overlap_declared_parallel (BLOCK):** for each active peer P with `assertsParallel(P)`, if the
   LITERAL exact-path set-intersection (normalized) of `writeSet(S)` and `writeSet(P)` is non-empty,
   block — cite the first colliding path + `P.storyId`. Tier-1 only (zero false positives).
5. **tier-2 advisory:** `globsOverlap(writeSet(S), writeSet(P)).pairs` NOT already in the literal
   intersection -> advisory "possible shared-prefix overlap with P: pair". Never a block.
6. **broad_glob_unprovable_parallel:** if `assertsParallel(S)` AND `writeSet(S)` has a BROAD entry
   (`classifyBroadness === 'broad'`) -> block when `cfg.broadGlobBlocks`, else advisory
   "broad glob asserted parallel-safe: entry (narrow the contract)".
7. **peer_contract_unreadable_parallel (BLOCK):** an active peer with `assertsParallel(P)` whose
   contract is absent from `contracts` -> block (disjointness cannot be proven).
8. **fake_dependency_chain:** NOT firable in-model — `depends` is `string[]` with no cited symbol
   (spec 4.5: add no field). Advise-only: if `S.depends` cites a storyId NOT among `peers` (a
   possibly-stale/fabricated edge), emit an advisory; NEVER a hard block.
9. **Precedence (return the first/most-severe block):** overlap_declared_parallel >
   peer_contract_unreadable_parallel > broad_glob_unprovable_parallel. Always return ALL
   advisories. NEVER read `cfg.mode` (Story 5 enforces mode).

## CHK-002 — Hermetic smoke packages/main/src/tasks/parallel-decomposition-gate-smoke.ts

In-memory `StoryInfo` + `ScopeContractData` fixtures (no I/O). Assert:
- clean disjoint parallel set -> `block=null`, no overlap advisory.
- tier-1 literal overlap (both parallel, same file in allowedCreate) -> `block=overlap_declared_parallel`, cites path+peer.
- tier-2 shared-prefix only (e.g. `dir/*` vs `dir/other-literal`, no literal collision) -> `block=null` + a shared-prefix advisory.
- broad glob asserted parallel + `broadGlobBlocks=true` -> `block=broad_glob_unprovable_parallel`; `broadGlobBlocks=false` -> `block=null` + advisory.
- active parallel peer with a MISSING contract -> `block=peer_contract_unreadable_parallel`.
- a `depends` edge -> NEVER `block=fake_dependency_chain` (advise-only).
- a DONE/DISCARDED peer is ignored (not active); a non-parallel S yields no parallel block even on overlap.
- precedence: a story that is simultaneously overlapping AND broad returns `overlap_declared_parallel` (higher).
- `TERMINAL_PHASES` is exported from `parallel-policy.js` and is what the gate uses.
Register in `lattice.config.json` validate.commands.
