# B-aa98 real-machine transcript diff

Timestamp: 2026-06-02T22:23Z

This transcript records a real local CLI pass for the Host Overflow commands after the
review fixes. The proof used a temporary git worktree and a temporary branch only to
create a locally resolvable `headSha` with a bounded `README.md` diff. The temporary
worktree and branch were removed after the receipt submission.

## Commands

```bash
lattice host_status --host=claude-code --json
lattice handoff_create \
  --storyId=B-aa98 \
  --fromHost=codex \
  --toHost=claude-code \
  --role=overflow-worker \
  --objective="Review host overflow CLI receipt behavior without editing owner worktree files" \
  --allowedPaths='["README.md"]' \
  --deniedPaths='[".koala/**","packages/server/**","packages/desktop/**"]' \
  --requiredCommands='["npm --prefix packages/main run test:host-overflow-smoke"]' \
  --successCriteria='["Report scopeStatus and productionDone=false"]' \
  --baseSha=a6df0b2211017f86b48f0c8ac7c50dbe15937a13 \
  --authorityBoundary="Lattice keeps story, scope, receipt, and merge authority; external host output is local diagnostic only." \
  --json \
  --output=/tmp/host-overflow-pack.json
lattice handoff_worktree_create --file=/tmp/host-overflow-pack.json --json
lattice host_dispatch --host=claude-code --file=/tmp/host-overflow-pack.json --mode=supervised --json
lattice handoff_receipt_submit --file=/tmp/host-overflow-receipt.json --json
```

## Observed result

```json
{
  "baseSha": "a6df0b2211017f86b48f0c8ac7c50dbe15937a13",
  "headSha": "889201514dbf1cf896cd38aaad39ab6674e924be",
  "hostStatus": {
    "host": "claude-code",
    "status": "ready",
    "overflowReady": true,
    "receiptVerified": false,
    "productionDone": false
  },
  "handoffCreate": {
    "packId": "HP-63e20ba9eaa0",
    "packHash": "sha256:42496a65a03189fb5895a4b4a6338ae3113b6ef3dcade41084ee77275b5a3560",
    "baseSha": "a6df0b2211017f86b48f0c8ac7c50dbe15937a13",
    "productionDone": false,
    "receiptRefs": []
  },
  "worktreeProjection": {
    "branch": "overflow/B-aa98/HP-63e20ba9eaa0",
    "receiptVerified": false,
    "productionDone": false
  },
  "dispatch": {
    "status": "planned",
    "host": "claude-code",
    "overflowReady": true,
    "receiptVerified": false,
    "productionDone": false,
    "authorityChanged": false
  },
  "receiptSubmit": {
    "status": "accepted-local",
    "scopeStatus": "pass",
    "freshness": "fresh",
    "receiptVerified": false,
    "productionDone": false,
    "authorityChanged": false,
    "validations": {
      "packId": "pass",
      "packHash": "pass",
      "baseSha": "pass",
      "headSha": "pass",
      "headCommit": "pass",
      "changedFiles": "pass"
    },
    "changedFiles": [
      "README.md"
    ],
    "warnings": []
  }
}
```

## Diff from expected behavior

Expected and actual behavior matched:

- `claude-code` is overflow-ready from capability semantics.
- `host_dispatch` remains a supervised projection, not an executor.
- A valid local receipt can become `accepted-local` when pack hash, base freshness,
  head commit, and changed-file scope all pass.
- The result still leaves `receiptVerified=false`, `authorityChanged=false`, and
  `productionDone=false`, so Lattice retains authority.
