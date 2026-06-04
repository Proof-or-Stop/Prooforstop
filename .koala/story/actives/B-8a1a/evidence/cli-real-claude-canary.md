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

## Negative Launcher Refusal

The same CLI canary also created a policy with
`allowRealHostSubprocess=true` but without the canonical launcher entry
`claude --print <prompt-file>` in `commandAllowlist`, then attempted
`dispatch_auto` with fake `claude` on `PATH`.

```bash
node packages/main/dist/cli.js --root <tmp-repo> dispatch_policy_create \
  --policy=no-launcher \
  --allowedHosts=claude-code \
  --allowedPaths=packages/main/src/generated/cli-claude.txt \
  --maxParallel=1 \
  --maxRuntimeMinutes=1 \
  --maxBudgetUSD=1 \
  --network=restricted \
  --commandAllowlist='node -e "process.exit(0)"' \
  --allowRealHostSubprocess=true \
  --json

PATH="<fake-claude-bin>:$PATH" \
node packages/main/dist/cli.js --root <tmp-repo> dispatch_auto \
  --storyId=B-cli-canary \
  --policy=no-launcher \
  --host=claude-code \
  --allowedPaths=packages/main/src/generated/cli-claude.txt \
  --objective='CLI canary launcher refusal' \
  --json
```

Result: `dispatch_auto` exited non-zero, the output mentioned
`commandAllowlist` and `claude --print <prompt-file>`, and the dispatch
record count stayed unchanged. This proves the real Claude subprocess path
is bound by the canonical launcher allowlist before dispatch artifacts are
created.

## Result Summary

```json
{
  "refusedMissingLauncher": true,
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
- `refusedMissingLauncher=true` confirms a policy missing `claude --print <prompt-file>` in `commandAllowlist` is rejected before dispatch record creation.
- `changedFiles=["packages/main/src/generated/cli-claude.txt"]` confirms the fake binary stayed inside the allowed scope.
- `manualOnly=true` and all authority fields staying `false` confirm merge/review boundaries did not change.
- The fake binary stands in for the real provider intentionally, so this artifact is auditable without consuming user Claude quota.
