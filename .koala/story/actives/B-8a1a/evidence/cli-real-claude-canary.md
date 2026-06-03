# CLI Real Claude Canary

Date: `2026-06-04`

Purpose: audit the real `dist/cli.js` entrypoint for the Claude-only unattended path without spending user Claude quota. The canary injects a fake `claude` binary on `PATH`, so the CLI exercises the real `dispatch_auto -> dispatch_status/watch/review/merge_plan` flow while remaining deterministic and local-only.

## Command

```bash
node packages/main/dist/cli.js --root <tmp-repo> dispatch_policy_create \
  --policy=cli-canary \
  --allowedHosts=claude-code \
  --allowedPaths=packages/main/src/generated/cli-claude.txt \
  --maxParallel=1 \
  --maxRuntimeMinutes=5 \
  --maxBudgetUSD=5 \
  --network=restricted \
  --envAllowlist=LATTICE_FAKE_CLAUDE_MODE \
  --commandAllowlist='claude --print <prompt-file>' \
  --requireReceipt=true \
  --requireReview=true \
  --allowAutoMerge=false \
  --allowProductionDone=false \
  --allowRealHostSubprocess=true \
  --json

PATH="<fake-claude-bin>:$PATH" \
node packages/main/dist/cli.js --root <tmp-repo> dispatch_auto \
  --storyId=B-cli-canary \
  --policy=cli-canary \
  --host=claude-code \
  --allowedPaths=packages/main/src/generated/cli-claude.txt \
  --objective='CLI canary fake claude real-host path' \
  --json

node packages/main/dist/cli.js --root <tmp-repo> dispatch_status --dispatchId=<dispatch-id> --json
node packages/main/dist/cli.js --root <tmp-repo> dispatch_watch --dispatchId=<dispatch-id> --json
node packages/main/dist/cli.js --root <tmp-repo> dispatch_review --dispatchId=<dispatch-id> --json
node packages/main/dist/cli.js --root <tmp-repo> dispatch_merge_plan --dispatchId=<dispatch-id> --json
```

## Result Summary

```json
{
  "dispatchId": "D-B-cli-canary-claude-code-mpypr4vk",
  "policy": {
    "policy": "cli-canary",
    "allowRealHostSubprocess": true,
    "commandAllowlist": ["claude --print <prompt-file>"]
  },
  "auto": {
    "status": "accepted_local",
    "host": "claude-code",
    "authorityChanged": false,
    "receiptVerified": false,
    "productionDone": false
  },
  "status": {
    "runnerKind": "claude-code-real",
    "changedFiles": ["packages/main/src/generated/cli-claude.txt"],
    "exitCode": 0,
    "timedOut": false
  },
  "watch": {
    "status": "accepted_local",
    "runnerKind": "claude-code-real",
    "authorityChanged": false
  },
  "review": {
    "localReceiptStatus": "accepted-local",
    "changedFiles": ["packages/main/src/generated/cli-claude.txt"],
    "runnerKind": "claude-code-real",
    "authorityChanged": false,
    "receiptVerified": false,
    "productionDone": false
  },
  "merge": {
    "manualOnly": true,
    "authorityChanged": false,
    "receiptVerified": false,
    "productionDone": false
  }
}
```

## Notes

- `runnerKind=claude-code-real` confirms the real-host launcher path was exercised through the CLI entrypoint.
- `changedFiles=["packages/main/src/generated/cli-claude.txt"]` confirms the fake binary stayed inside the allowed scope.
- `manualOnly=true` and all authority fields staying `false` confirm merge/review boundaries did not change.
- The fake binary stands in for the real provider intentionally, so this artifact is auditable without consuming user Claude quota.
