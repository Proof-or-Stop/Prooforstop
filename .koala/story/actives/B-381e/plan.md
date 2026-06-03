# B-381e Plan: Host-Neutral Observability M1

## Execution Model

M1 is a CLI-first, read-only implementation slice. It does not build the multi-page UI and does not convert `packages/main/src/dashboard.ts` into the new console. Development should use three fresh Claude Code workers after PLAN passes:

- Worker A owns CHK-001: resolver command and core resolver.
- Worker B owns CHK-002: observability snapshot adapter and dry-run JSON output.
- Worker C owns CHK-003 and CHK-004: L0 policy/process-fact registration plus focused smoke coverage.

Coordinator owns story flow, conflict resolution, review/test evidence, and final validation. Workers must commit their own scoped changes before marking checklist items done.

## Global Decisions

- Command names are fixed for M1: `story_authority_resolve` and `observability_snapshot`.
- Both commands are L0 read-only diagnostics.
- Both commands must expose JSON with conservative authority fields: `productionDone=false`, `receiptVerified=false`, `authorityChanged=false`.
- The adapter must not parse `session_brief` / `status` Markdown.
- The adapter must not directly read `.koala/story`, `docs/story`, or backing JSON files.
- Existing terminal dashboard remains out of scope.

## CHK-001

### Goal
Implement `lattice story_authority_resolve --format=json` as the machine-readable resolver surface for active story authority.

### Files
- Create: `packages/main/src/core/story-authority-resolver.ts`
- Create: `packages/main/src/handlers/story-authority-resolve.ts`
- Modify: `packages/main/src/cli-engine.ts`
- Test: `packages/main/src/tasks/story-authority-resolve-smoke.ts`

### DependsOn
None. CHK-003 may register policy in parallel, but CHK-001 defines the command output contract.

### Verify
- Happy: command returns `schemaVersion=lattice.story_authority_resolve.v1`, `readOnly=true`, and rows containing `storyId/title/authority/mirrorPhase/authoritativePhase/authoritativeCwd/worktreePath`.
- Edge: a worktree-authoritative story with stale main mirror resolves to the worktree phase and cwd.
- Adversarial: output cannot set `productionDone`, `receiptVerified`, or `authorityChanged` true.

## CHK-002

### Goal
Implement `lattice observability_snapshot --format=json` as a read-only adapter dry-run that assembles the data shape needed by future UI surfaces.

### Files
- Create: `packages/main/src/core/observability-snapshot.ts`
- Create: `packages/main/src/handlers/observability-snapshot.ts`
- Modify: `packages/main/src/cli-engine.ts`
- Test: `packages/main/src/tasks/observability-snapshot-smoke.ts`

### DependsOn
Depends on CHK-001 resolver contract. If developed in parallel, Worker B may stub against the agreed resolver interface and rebase once Worker A lands.

### Verify
- Happy: snapshot JSON includes sections for authority ladder, story board, capability matrix, recovery, and parallel planning inputs.
- Edge: snapshot runs `story_export` from each row's `authoritativeCwd`, not blindly from repo root.
- Adversarial: snapshot does not read backing story JSON directly and does not touch terminal dashboard UI.

## CHK-003

### Goal
Register both M1 commands as L0 read-only diagnostics in command policy and process fact levels.

### Files
- Modify: `packages/main/src/core/command-policy.ts`
- Modify: `packages/main/src/core/process-fact-levels.ts`
- Modify: `packages/main/src/cli-engine.ts`
- Test: `packages/main/src/tasks/observability-contract-smoke.ts`

### DependsOn
Coordinate with CHK-001/CHK-002 command names. Policy can land after command names are fixed and before final test pass.

### Verify
- Happy: both commands are listed as L0/read-only diagnostics.
- Edge: outputs preserve conservative authority fields.
- Adversarial: invoking either command does not append lifecycle/evidence/receipt/authority process events and cannot satisfy gate evidence.

## CHK-004

### Goal
Add focused smoke coverage proving the resolver and adapter preserve host-neutral authority semantics.

### Files
- Modify: `packages/main/package.json` if new npm scripts are needed.
- Create/Test: `packages/main/src/tasks/story-authority-resolve-smoke.ts`
- Create/Test: `packages/main/src/tasks/observability-snapshot-smoke.ts`
- Create/Test: `packages/main/src/tasks/observability-contract-smoke.ts`

### DependsOn
Depends on CHK-001/CHK-002/CHK-003 implementation. Worker C may scaffold tests early, but final pass requires all command surfaces.

### Verify
- Happy: focused smoke tasks pass.
- Edge: stale main mirror vs authoritative worktree is covered.
- Adversarial: tests fail if implementation parses Markdown, directly reads backing story JSON from the adapter, or overclaims production authority.

## Parallel Dispatch Plan

After PLAN passes and story advances to DEV:

1. Dispatch Worker A for CHK-001.
2. Dispatch Worker B for CHK-002 after Worker A posts the resolver TypeScript interface, or in parallel with an explicit interface stub.
3. Dispatch Worker C for CHK-003/CHK-004 after command names are fixed; it can scaffold tests in parallel and finish once A/B land.

Workers should not use separate git worktree isolation. They should work in `.worktrees/B-381e` as required by the Lattice story flow.
