# Plan — B-fa7c: Parallel-decomposition wave/REVIEW advisory wiring (Story 4)

Two advisory (non-blocking) surfaces of the parallel-decomposition gate (spec §4.3 items 3-4). The hard PLAN→DEV block is Story 5 and is out of scope. Both surfaces are implemented as **pure exported helpers** so the smoke is hermetic, with thin call-site wiring doing the store reads.

## CHK-001 — scope_glob_overlap degradation in resolveWaveSafety

**core/lattice-parallel-wave.ts**

1. Add a pure exported helper:
   ```ts
   export interface ScopeGlobOverlap { peerStoryId: string; pairExample: string; }
   export function computeScopeGlobOverlaps(
     self: { storyId: string; parallelSafe?: StoryInfo['parallelSafe']; writeSet: string[] },
     peers: Array<{ storyId: string; phase: StoryPhase; parallelSafe?: StoryInfo['parallelSafe']; writeSet: string[] }>,
   ): ScopeGlobOverlap[]
   ```
   - Returns `[]` unless `self.parallelSafe === 'yes'`.
   - For each peer: skip self, skip `TERMINAL_PHASES.has(peer.phase)`, skip `peer.parallelSafe !== 'yes'`; run `globsOverlap(self.writeSet, peer.writeSet)`; on `overlap` push `{ peerStoryId, pairExample: \`${pairs[0][0]} ↔ ${pairs[0][1]}\` }`.
2. `resolveWaveSafety` gains a new param `scopeGlobOverlaps: ScopeGlobOverlap[]` and, for each entry, pushes a degradation via `schedulingDegradation()`: kind/capability `scope_glob_overlap`, severity `warn`, authorityImpact `none`, visible true, reason names the peer + pairExample, fallback suggests coordinating scope contracts.
3. `storyRef()` builds the write-sets: `computeWriteSet(store.readScopeContract(id))` for self and each peer in `allStories` whose contract is non-null; calls `computeScopeGlobOverlaps`; passes the result into `resolveWaveSafety`. Null contracts are skipped (null-tolerant).

userSees (wave projection): a `scope_glob_overlap` warn degradation line naming the overlapping active parallel peer + an example colliding pair.

## CHK-002 — evaluateDecompositionGate advisory injection in story_review

**handlers/story-review.ts**

1. Add a pure exported helper (co-located or in a small module):
   ```ts
   export function decompositionAdvisoryIssues(
     story: StoryInfo, peers: StoryInfo[], contracts: Map<string, ScopeContractData>, cfg: ParallelGateConfig,
   ): Array<{ type: 'decomposition_advisory'; severity: 'advisory'; message: string }>
   ```
   = `evaluateDecompositionGate(story, peers, contracts, cfg).advisories.map(message => ({ type:'decomposition_advisory', severity:'advisory', message }))`. The gate `block` field is intentionally ignored.
2. In the handler: resolve `cfg` via `resolveAuditConfig(profile, ctx.root).parallelGate` (profile from the existing workflow-policy resolution), load peers via `store.listStoryIds().filter(!==self).map(readStory)`, contracts via `store.readScopeContract` (null-tolerant — only put non-null into the Map), call `decompositionAdvisoryIssues`, and `issues.push(...)`. Placed after the scope-check block.
3. `blockerCount = issues.filter(i=>i.severity==='blocker').length` is unaffected (advisories are severity `advisory`).

userSees (story_review): `decomposition_advisory` issue(s) at advisory severity; blockerCount unchanged; signed review.json unaffected.

## Test — packages/main/src/tasks/parallel-wave-advisory-smoke.ts (hermetic)

Covers both helpers directly with synthetic inputs (no StoryStore, no git): CHK-001 happy/edge/adversarial (overlap surfaced; self-not-parallel/terminal-peer/non-parallel-peer/disjoint → none; null peer contract skipped at the call site → modeled by omitting that peer; per-peer fan-out), CHK-002 happy/edge/adversarial (advisories→advisory issues; blockerCount unchanged; empty advisories→[]; block field ignored; peer-unreadable no throw; every issue severity advisory). Registered in lattice.config.json validate.commands.
