# B-99d4 User-Value Transcript Diff

## Expected

- A completed/accepted worker dispatch can be reassigned with an explicit worker role.
- The new follow-up dispatch starts in fresh-context mode and does not require a full-history fork.
- The output names the previous dispatch, new dispatch, requested role, prompt file, and parent lineage.
- The generated prompt uses the requested role consistently and does not retain a conflicting previous worker role.

## Actual Run

Commands were run from `/Users/jek/Documents/Work/proofbound/.worktrees/B-99d4` using the current worktree build:

```bash
node packages/main/dist/cli.js dispatch_prepare --forceTakeover \
  --storyId=B-99d4 \
  --dispatchId=D-B-99d4-user-acceptance-final \
  --host=fake \
  --role=overflow-worker \
  --objective='Initial worker has completed local fake work for reassignment acceptance.' \
  --allowedPaths='["packages/main/src/generated/user-acceptance-final.txt"]' \
  --requiredCommands='["true"]' \
  --successCriteria='["Local fake receipt is accepted before reassignment"]' \
  --format=json

node packages/main/dist/cli.js dispatch_run \
  --dispatchId=D-B-99d4-user-acceptance-final \
  --format=json

node packages/main/dist/cli.js dispatch_reassign --forceTakeover \
  --dispatchId=D-B-99d4-user-acceptance-final \
  --role=lattice-implementer \
  --objective='Continue this completed worker with explicit fresh-context follow-up instructions.' \
  --format=text
```

Observed result:

```text
Worker reassignment ready (lattice.dispatch_reassign.v1)
mode: fresh-context
previousDispatchId: D-B-99d4-user-acceptance-final
dispatchId: D-B-99d4-fake-mrcz2hq3
storyId: B-99d4
role: lattice-implementer
roleSource: requested
objective: Continue this completed worker with explicit fresh-context follow-up instructions.
parentDispatchId: D-B-99d4-user-acceptance-final
promptFile: .lattice/dispatches/D-B-99d4-fake-mrcz2hq3/prompt.md
nextAction: Worker reassignment ready. Open .lattice/dispatches/D-B-99d4-fake-mrcz2hq3/prompt.md and launch role=lattice-implementer with fresh context; no full-history fork is required.

warnings:
  - Reassignment uses summary-only fresh-context continuity; no full-history fork is required.
```

Prompt check:

```text
Role: lattice-implementer
- Work in role: lattice-implementer.
- Use this summary-only continuity block plus the new handoff pack; no full-history fork is required.
- This prompt does not inherit conversation history, verify receipts, claim release readiness, mark release completion, or change authority.
```

## Diff Notes

- Expected explicit role reassignment: observed `role: lattice-implementer` and `roleSource: requested`.
- Expected fresh context: observed `mode: fresh-context` and `no full-history fork is required`.
- Expected lineage: observed both `previousDispatchId` and `parentDispatchId` pointing to `D-B-99d4-user-acceptance-final`.
- Expected prompt consistency: observed `Role: lattice-implementer` and `Work in role: lattice-implementer.`
- Previous BUG-001 role conflict is fixed: the prompt no longer contains `Work in role: overflow-worker.`

Acceptance verdict: accepted.
