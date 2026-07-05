# B-bfba Real-Machine Transcript Diff

Story: B-bfba
Phase when captured: TEST

## Expected

- `milestone_status` remains a live, read-only progress view.
- All three closeout milestones are complete and risk-free before DONE.
- `milestone_closeout` is a historical DONE snapshot reader.
- Before DONE creates `.lattice/story/actives/B-bfba/milestone-closeout.json`, `milestone_closeout` must not fabricate success; it must show a missing-snapshot diagnostic and next action.
- The real DONE capture path is covered by the focused integration test in `packages/main/tests/milestone-status.test.mjs`, which drives `createStoryAdvanceHandlers(...).story_advance({ phase: 'DONE' })` in a temp repo and asserts `milestone-closeout.json` is written before DONE phase metadata persistence.

## Actual Commands

```bash
lattice validate --story=B-bfba --json
node packages/main/dist/cli.js milestone_status --root /Users/jek/Documents/Work/proofbound/.worktrees/B-bfba --storyId B-bfba --json
node packages/main/dist/cli.js milestone_closeout --root /Users/jek/Documents/Work/proofbound/.worktrees/B-bfba --storyId B-bfba
```

## Actual Results

- `lattice validate --story=B-bfba --json` passed all 33 configured validation commands in 136.8s.
- `milestone_status` returned `schemaVersion: proofbound.milestone_status.v1`, `phase: TEST`, `groups.completed: ["M1","M2","M3"]`, `groups.current: []`, `groups.remaining: []`, `risks: []`.
- `milestone_closeout` returned `Snapshot: missing` and did not claim DONE closeout success before DONE:

```text
Milestone Closeout - B-bfba
Mode: read-only historical snapshot
Snapshot: missing
Expected path: /Users/jek/Documents/Work/proofbound/.worktrees/B-bfba/.lattice/story/actives/B-bfba/milestone-closeout.json
Diagnostic: No milestone-closeout.json snapshot exists for B-bfba.
Next action: Run `lattice milestone_status --storyId=B-bfba` to inspect the live report, then complete a risk-free DONE path so Proofbound can capture milestone-closeout.json.
```

## Diff Notes

- Expected and actual match for TEST-phase behavior.
- No final DONE closeout snapshot is expected before DONE; the missing-snapshot diagnostic is correct.
- The story includes an executable DONE-path regression test so removing the `transition-orchestrator` closeout capture wiring would fail `node packages/main/tests/milestone-status.test.mjs`.
