# B-b750 Transcript Diff

Story: B-b750  
Phase: TEST  
Timestamp: 2026-06-12T17:07:10Z

## Expected

The expected user-visible outcome was:

- `story_resolve` exposes signed workspace resolution facts.
- Ordinary story worktrees resolve to a real signed workspace root.
- Non-git wrapper roots fail closed instead of being presented as executable REVIEW cwd.
- Explicit `gitRoot` is the only repair path for wrapper-root projects; nested repositories are not guessed.
- `review_run_start` and REVIEW evidence consumers bind to the resolved signed workspace facts.
- Local reviewer evidence is not upgraded into Authority receipt or production completion.

## Actual

The worktree CLI produced the expected signed workspace fields for B-b750:

```bash
node packages/main/dist/cli.js story_resolve --storyId=B-b750 --format=json
```

Observed summary:

```text
resolved=true
authoritativeCwd=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-b750
metadataRoot=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-b750
signedWorkspaceRoot=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-b750
repoRoot=/Users/jek/Documents/Work/Orchestrate
resolutionSource=story-worktree
unresolvedReason=null
```

Full validation also passed:

```bash
lattice validate --story=B-b750 --json
```

Observed summary:

```text
status=pass
allPass=true
npm test passed
verification intent coverage: 12/12 covered
warnings=[]
```

## Diff Notes

- The expected signed-workspace fields are present when using the current worktree CLI build.
- The global fallback `lattice` binary may resolve from main and should not be treated as proof of the unmerged worktree implementation.
- The implementation remains host-neutral: it records local signed workspace evidence and does not claim Authority receipt verification or production DONE.
