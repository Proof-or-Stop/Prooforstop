# Plan — B-086b: Parallel-decomposition hard PLAN->DEV gate + contract reconcile (Story 5, serial integration)

The final story: turn the gate into a real PLAN->DEV hard block in machine.ts and reconcile the frozen contract. Core invariant: the new sub-check is **FAIL-OPEN** (own try/catch -> allow), enforced **only under mode===block**, with **one shared predicate** feeding both the boolean decision and the message.

## CHK-001 — re-export real impls in parallel-decomposition.ts

Replace the 3 NotImplemented skeletons with re-exports:
```ts
export { computeWriteSet, globsOverlap } from './parallel-decomposition-overlap.js';
export { evaluateDecompositionGate } from './parallel-decomposition-gate.js';
```
Types (ParallelGateConfig/GlobOverlapResult/DecompositionGateResult/ParallelDecompositionBlock) stay defined here; the impl modules import them type-only (erased at runtime → no cycle). No caller imports the functions from the contract today, so it is non-breaking. Default: leave existing importers as-is (minimize churn); migrate to the contract path only if it stays clean.

## CHK-002 — canStartDevGuard fail-open hard-block sub-check (machine.ts)

A shared helper:
```ts
// returns the block reason (ParallelDecompositionBlock) to ENFORCE, or null. Only consults mode===block.
function parallelDecompositionBlock(store, projectRoot, story, policy): ParallelDecompositionBlock | null {
  const cfg = resolveAuditConfig(policy.profile, projectRoot).parallelGate;
  if (!cfg || cfg.mode !== 'block') return null;
  const peers = store.listStoryIds().filter(id => id !== story.storyId).map(id => store.readStory(id));
  const contracts = new Map<string, ScopeContractData>();
  for (const id of store.listStoryIds()) { const c = safeReadScopeContract(store, id); if (c) contracts.set(id, c); }
  return evaluateDecompositionGate(story, peers, contracts, cfg).block;
}
```
In canStartDevGuard, AFTER the existing review-clean check (still fail-closed), add an isolated FAIL-OPEN sub-check:
```ts
try {
  if (parallelDecompositionBlock(context.store, context.projectRoot, story, policy) !== null) return false;
} catch { /* FAIL-OPEN: a gate/config infra error must never block PLAN->DEV (§4.8) */ }
return true;
```
The outer review-gate try/catch stays fail-closed and unchanged.

## CHK-003 — getGuardFailureReason mirror (machine.ts)

In the targetPhase==='DEV' branch, after the existing review-reason logic, add (mirroring the SAME shared helper):
```ts
try {
  const block = parallelDecompositionBlock(store, projectRoot, story, policy);
  if (block !== null) return `Cannot enter DEV:\n  - ${formatParallelBlock(block, story, ...)}`;
} catch { /* fail-open: no fabricated message on a gate error */ }
```
`formatParallelBlock(block, story, peer/path)` maps each ParallelDecompositionBlock to an actionable message naming the colliding peer/path where available. Because both call sites use `parallelDecompositionBlock`, the boolean decision and the message cannot drift.

## CHK-004 — hermetic end-to-end smoke (packages/main/src/tasks/parallel-decomposition-gate-integration-smoke.ts)

Drive canStartDevGuard + getGuardFailureReason with synthetic state (temp-git-repo store per evidence-state-gate-smoke.ts, OR a minimal mock StoryStore that returns a signed-clean review + parallelGate config + overlapping peer contracts). Assert:
- overlap + mode=block + clean review → guard false AND reason non-null naming the block;
- clean disjoint → guard true AND reason null;
- same overlap under mode=advise and mode=off → guard true (allowed);
- missing/unclean review → guard false (existing gate, unchanged);
- FAIL-OPEN: a config that makes the sub-check throw → guard true + reason null (review otherwise clean);
- decision/message parity. Register in lattice.config.json validate.commands.

userSees: `lattice story_advance --phase=DEV` refused with `Cannot enter DEV:\n  - parallel-decomposition gate: ...` under mode=block on a real overlap; proceeds under advise/off/disjoint; never blocked by a gate infra error.
