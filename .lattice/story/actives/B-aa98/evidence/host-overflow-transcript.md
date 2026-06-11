# Host Overflow Transcript — B-aa98

This transcript records the user-facing Host Overflow flow for a Codex owner
handing bounded work to Claude Code while Lattice keeps authority local and
diagnostic.

## 1. Check Claude Code Overflow Readiness

Command:

```bash
node packages/main/dist/cli.js host_status --host=claude-code --format=json
```

Observed fields:

```json
{
  "schemaVersion": "lattice.host_status.v1",
  "host": "claude-code",
  "status": "ready",
  "overflowReady": true,
  "nextAction": "Manual-first overflow is ready: create a handoff pack, project an isolated overflow worktree, then review any receipt locally before merging.",
  "readiness": {
    "edit": "available",
    "shell": "available",
    "test": "available",
    "worktree": "available",
    "review": "available",
    "receipt": "local-only"
  },
  "productionDone": false,
  "receiptVerified": false
}
```

## 2. Create A Bounded Claude Code Pack

Command:

```bash
node packages/main/dist/cli.js handoff_create \
  --storyId=B-aa98 \
  --fromHost=codex \
  --toHost=claude-code \
  --role=koala-review-quality \
  --objective='review docs' \
  --allowedPaths=README.md \
  --requiredCommands='npm test' \
  --format=json
```

Observed fields:

```json
{
  "schemaVersion": "handoff-pack-v0",
  "storyId": "B-aa98",
  "packId": "HP-56ee3ff5350c",
  "packHash": "sha256:877f97cf82371fc5d8b89970d966da607540e0fd19364c7680ec86579f286c0a",
  "fromHost": "codex",
  "toHost": "claude-code",
  "role": "koala-review-quality",
  "objective": "review docs",
  "allowedPaths": ["README.md"],
  "requiredCommands": ["npm test"],
  "productionDone": false,
  "receiptRefs": []
}
```

The pack also includes authority-boundary instructions: no hidden context
sharing, no auto-trust, no auto-merge, no evidence submit, no receipt verify,
and no productionDone claim.

## 3. Project An Isolated Overflow Worktree

Command:

```bash
node packages/main/dist/cli.js handoff_worktree_create --file="$pack" --format=json
```

Observed fields:

```json
{
  "schemaVersion": "lattice.handoff_worktree_create.v1",
  "status": "projected",
  "constraintStatus": "pass",
  "branch": "overflow/B-aa98/HP-56ee3ff5350c",
  "worktreePath": ".worktrees/overflow/B-aa98/HP-56ee3ff5350c",
  "created": false,
  "authorityChanged": false,
  "receiptVerified": false,
  "productionDone": false,
  "nextAction": "Create the isolated worktree manually, run the overflow host there, and keep the result outside the owner worktree until review."
}
```

## 4. Project Supervised Dispatch

Command:

```bash
node packages/main/dist/cli.js host_dispatch \
  --host=claude-code \
  --file="$pack" \
  --mode=supervised \
  --format=json
```

Observed fields:

```json
{
  "schemaVersion": "lattice.host_dispatch.v1",
  "status": "planned",
  "mode": "supervised",
  "host": "claude-code",
  "overflowReady": true,
  "authorityChanged": false,
  "receiptVerified": false,
  "productionDone": false,
  "nextAction": "Dispatch is planned only. Send HP-56ee3ff5350c to claude-code, use overflow/B-aa98/HP-56ee3ff5350c, then require local receipt review before merge."
}
```

The warning list explicitly states that supervised dispatch never auto-trusts
output, auto-merges diffs, submits evidence, verifies receipts, or claims
productionDone.

## 5. Submit Local Diagnostic Receipt

Command:

```bash
node packages/main/dist/cli.js handoff_receipt_submit --file="$receipt" --format=json
```

Observed fields:

```json
{
  "schemaVersion": "lattice.handoff_receipt_submit.v1",
  "status": "accepted-local",
  "host": "claude-code",
  "packId": "HP-56ee3ff5350c",
  "verdict": "pass",
  "scopeStatus": "pass",
  "freshness": "fresh",
  "authorityChanged": false,
  "receiptVerified": false,
  "productionDone": false,
  "nextAction": "Receipt accepted as local diagnostic evidence only. Review the overflow diff in an isolated worktree and merge manually if it passes local review.",
  "changedFiles": ["README.md"],
  "commands": ["npm test"]
}
```

## User-Visible Summary

Manual Claude Code overflow flow:

```text
pack created -> receipt accepted-local -> scopeStatus=pass -> productionDone=false -> nextAction=main agent reviews and merges
```

This proves the flow works without Mac App and without claiming server receipt
or production authority.
