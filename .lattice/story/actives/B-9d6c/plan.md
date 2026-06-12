# B-9d6c Plan

## Scope

Implement a narrow formal proof-root invariant for Layer 2 Engineering and Layer 3 Loop Engineering baseline suite aggregation. The invariant protects the selected final PASS root from stale, mixed, local-only, wrong-target, or authority-overclaim final-report artifacts.

This story does not implement Layer 4 Production Safety, does not verify Authority Server receipts, and does not convert Claude/Codex host verdicts into Authority evidence.

## CHK-001

Add root invariant checks for formal Layer 2/3 suite aggregation.

Implementation approach:
- Keep the existing `artifactsRoot` boundary.
- Apply the invariant only to `engineering` and `loop-engineering`, because those are the currently supported formal proof layers.
- Inspect every parsed `final-report.json` inside the selected layer root, not only accepted reports.
- Block when any parsed report in the final PASS root has a different `suiteRunId`, wrong `claimTarget`, `localOnly=true`, `capabilityProof=false`, missing `formalProof`, false DONE, or Authority overclaim.
- Preserve existing behavior where malformed, mixed-layer, stale material, and authority-overclaim artifacts are refused and block.

Rollback path:
- Revert only the invariant helper and its call site in `packages/main/src/core/lattice-baseline.ts`.

## CHK-002

Add stale and mixed artifact negative coverage.

Test approach:
- Extend `packages/main/src/tasks/lattice-baseline-smoke.ts` with targeted smoke cases.
- Keep tests fixture-local under temporary repos.
- Prove clean formal proof still passes.
- Prove mixed `suiteRunId`, wrong `claimTarget`, local-only capability posture, and higher-layer/Authority overclaim artifacts fail closed.
- Assert local CLI results keep `receiptVerified=false`, `productionDone=false`, and `fullAuthorityDone=false` where relevant.

Rollback path:
- Revert only the new smoke cases if the invariant implementation is reverted.

## CHK-003

Update the artifact isolation execution plan with implementation evidence.

Documentation approach:
- Materialize `docs/requirements/decisions/formal-unlock-artifact-isolation-execution-plan.md` in this worktree.
- State that the root invariant is implemented for Layer 2/3 formal suite aggregation.
- Preserve the Layer 4 boundary: artifact isolation is only a precondition until the production-safety evaluator and Authority-backed proof chain exist.
- Keep the final PASS root and negative-check root separated.

Rollback path:
- Revert only this decision document if implementation scope changes before merge.

## Verification

Run:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/lattice-baseline-smoke.js
lattice validate --story=B-9d6c
```

Also run two-host review before final acceptance:
- Claude CLI reviews correctness and host-neutral boundary.
- Codex CLI reviews formal proof invariants and Authority lock behavior.
