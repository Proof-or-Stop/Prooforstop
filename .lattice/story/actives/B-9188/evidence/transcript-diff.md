# B-9188 real-machine transcript + diff notes

Run at TEST phase, head 6055584 lineage (worktree .worktrees/B-9188), 2026-07-13.

## Expected (PLAN outcome)

1. `npm run test:process-fact-contract` passes with the new `artifact:milestone-closeout.json` registry entry and required-list line present.
2. Removing the registry fact entry makes the same command fail with the artifact-missing assertion (non-vacuous).
3. Existing read-side behavior unharmed: `lattice milestone_closeout` still works.
4. The compiled runtime registry actually exposes the new fact (not just source text).

## Actual

### 1. Contract test (user surface)

```
$ npm run test:process-fact-contract
Process fact contract verified
```

### 2. Bite test (recorded during DEV at commit b7d953361d, method preserved)

```
$ python3 <remove artifact:milestone-closeout.json fact entry> && npm run test:process-fact-contract
Process fact contract failed:
- packages/main/src/core/process-fact-registry.ts: artifact missing from PROCESS_FACT_REGISTRY: artifact=artifact:milestone-closeout.json
$ git restore packages/main/src/core/process-fact-registry.ts && npm run test:process-fact-contract
Process fact contract verified
```

Round-2 test-coverage reviewer independently corroborated the assertion string exists at
scripts/verify-process-fact-contract.mjs (requiredArtifactFacts loop) without re-running the destructive step.

### 3. Read command healthy

```
$ lattice milestone_closeout '{"storyId":"B-9188"}'
Milestone Closeout - B-9188
Mode: read-only historical snapshot
Snapshot: missing
```

"Snapshot: missing" is correct for a story that has not reached DONE — the snapshot is only
written by the story_advance DONE-time capture.

### 4. Compiled runtime registry exposes the fact

```
$ node -e "…PROCESS_FACT_REGISTRY.find(x => x.name === 'artifact:milestone-closeout.json')…"
registry entry found: true
{ kind: artifact, level: L4, path: milestone-closeout.json, signed: false, producer: handlers/milestone-status }
required-names includes closeout: true
```

## Diff notes (expected vs actual)

No divergence. All four expected observations reproduced exactly. One process finding during
REVIEW (B-9188:F-001, medium): the synthetic map key read as a real command; resolved by an
8-line comment documenting the deliberate deviation (commit 63ff9181ac), verified by the round-2
quality re-review (B-9188:RP-003).
