# B-3a4d Plan: Persist DONE closeout snapshots

## Problem

B-bfba added milestone closeout snapshot capture, but the first real DONE run
left canonical main without `.lattice/story/actives/B-bfba/milestone-closeout.json`.
That means the helper path can write a worktree-local snapshot while the user
still sees `Snapshot: missing` after DONE merge cleanup.

## Goal

After a real DONE transition and worktree cleanup, the canonical main checkout
must be able to run:

```bash
lattice milestone_closeout --storyId=B-xxxx
```

and read a `proofbound.milestone_closeout.v1` snapshot when the story had a
completed, risk-free milestone ledger at DONE time.

## Milestones

### M1 Durable closeout handoff

- Verify where `transition-orchestrator` captures the closeout.
- Ensure the captured snapshot is included in the DONE metadata commit and
  survives merge/worktree cleanup.
- Preserve existing fail-closed behavior for incomplete or risky milestone
  reports.

Evidence: focused logic test that exercises the real DONE path.

### M2 Canonical-root regression

- Extend the DONE transition fixture so it models a story worktree and a
  canonical main root.
- After DONE cleanup, assert the canonical root can read
  `milestone-closeout.json`.
- Ensure the test would fail if the only copy lived in the removed worktree.

Evidence: `node packages/main/tests/milestone-status.test.mjs`.

### M3 No fabricated closeout

- Keep no-ledger stories on the existing missing/not-applicable diagnostic.
- Do not recompute historical closeout from live `milestone_status`.
- Keep `milestone_closeout` read-only.

Evidence: existing missing snapshot tests plus updated docs if wording changes.

## Implementation Touchpoints

- `packages/main/src/handlers/transition-orchestrator.ts`
- `packages/main/src/handlers/done-effects.ts`
- `packages/main/src/core/store.ts`
- `packages/main/tests/milestone-status.test.mjs`
- `docs/CLI.md`

## Verification

Run:

```bash
npm --prefix packages/main run build
node packages/main/tests/milestone-status.test.mjs
lattice validate --story=B-3a4d
```

Acceptance requires B-3a4d to reach DONE, merge to local main, and leave
`lattice milestone_closeout --storyId=B-3a4d` readable from the canonical root
if its DONE closeout preconditions are met.
