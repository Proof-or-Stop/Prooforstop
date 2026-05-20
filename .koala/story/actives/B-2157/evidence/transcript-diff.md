# User Acceptance Transcript Diff

Story: B-2157
Feature: Verification Context Pack CLI authority flow

## Expected

Running the built CLI against a real git worktree with one modified tracked file, one new untracked file, and one deleted tracked file should produce a context pack that:

- reports all three files in `changedFiles`
- reports one stable hunk per changed file
- includes source snippets for modified, added, and deleted files
- keeps deleted-file source context readable by deriving it from the diff
- preserves `requiredCommands`
- returns a user-visible `summary` with changed file, hunk, snippet, token, and truncation counts

## Actual

Command shape used from a temporary git repository:

```bash
node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-2157/packages/main/dist/cli.js verification_context_pack_create \
  --producerRunId=run-user-acceptance \
  --storyId=B-2157 \
  '--requiredCommands=[{"command":["npm","run","test:verification-context-pack"],"required":true}]' \
  --tokenBudget=2000
```

Observed output summary:

```json
{
  "changedFiles": ["alpha.ts", "beta.ts", "gamma.ts"],
  "changedHunks": ["alpha.ts:1", "gamma.ts:1", "beta.ts:1"],
  "sourceSnippets": [
    {"file": "alpha.ts", "reason": "changed hunk context"},
    {"file": "gamma.ts", "reason": "deleted hunk context from diff"},
    {"file": "beta.ts", "reason": "changed hunk context"}
  ],
  "requiredCommands": [
    {"command": ["npm", "run", "test:verification-context-pack"], "required": true}
  ],
  "summary": {
    "changedFiles": 3,
    "changedHunks": 3,
    "sourceSnippets": 3,
    "estimatedTokens": 23,
    "truncated": false
  }
}
```

## Diff

No user-visible mismatch found. The actual CLI output covers the expected modified, added, and deleted-file cases, including readable deleted-file context and the required command constraint.
