# B-381e User-Value Transcript Diff

## Expected

- `story_authority_resolve` exposes a machine-readable resolver contract:
  `schemaVersion=lattice.story_authority_resolve.v1`, `readOnly=true`,
  `productionDone=false`, `receiptVerified=false`, `authorityChanged=false`.
- Active story rows include `storyId`, `authority`, `mirrorPhase`,
  `authoritativePhase`, and `authoritativeCwd`.
- `observability_snapshot` exposes a read-only adapter dry-run with
  `authorityLadder`, `storyBoard`, `capabilityMatrix`, `recovery`, and
  `parallel` inputs.
- Worktree authority wins over stale main mirror; local evidence is not rendered
  as production DONE.

## Actual Commands

```bash
lattice validate --json
node packages/main/dist/cli.js story_authority_resolve --format=json | jq '{schemaVersion,readOnly,productionDone,receiptVerified,authorityChanged,stories: [.stories[] | {storyId,authority,mirrorPhase,authoritativePhase,authoritativeCwd}]}'
node packages/main/dist/cli.js observability_snapshot --format=json | jq '{schemaVersion,readOnly,authority,sections:{authorityLadder:.sections.authorityLadder, storyBoard:[.sections.storyBoard[] | {storyId,authority,mirrorPhase,authoritativePhase,localDone,productionDone,topAuthorityImpact}], capabilityMatrix:.sections.capabilityMatrix, recoveryCount:(.sections.recovery|length), parallelCount:(.sections.parallel|length)}, warnings}'
```

## Actual Excerpts

`lattice validate --json` returned `allPass=true` and ran the project fallback
`npm test` successfully.

`story_authority_resolve` returned:

```json
{
  "schemaVersion": "lattice.story_authority_resolve.v1",
  "readOnly": true,
  "productionDone": false,
  "receiptVerified": false,
  "authorityChanged": false,
  "stories": [
    {
      "storyId": "B-381e",
      "authority": "worktree",
      "mirrorPhase": "TEST",
      "authoritativePhase": "TEST",
      "authoritativeCwd": "/Users/jek/Documents/Work/Orchestrate/.worktrees/B-381e"
    }
  ]
}
```

`observability_snapshot` returned:

```json
{
  "schemaVersion": "lattice.observability_snapshot.v1",
  "readOnly": true,
  "authority": {
    "productionDone": false,
    "receiptVerified": false,
    "authorityChanged": false
  },
  "sections": {
    "authorityLadder": {
      "serverReceipt": { "count": 0, "storyIds": [] },
      "serverRecord": { "count": 0, "storyIds": [] },
      "localEvidence": { "count": 3 },
      "productionDoneGap": 1
    },
    "storyBoard": [
      {
        "storyId": "B-b95c",
        "authority": "main",
        "mirrorPhase": "INIT_CHECK",
        "authoritativePhase": "INIT_CHECK",
        "localDone": true,
        "productionDone": false,
        "topAuthorityImpact": "blocks-production-done"
      }
    ],
    "recoveryCount": 3,
    "parallelCount": 3
  },
  "warnings": []
}
```

## Diff

- Expected resolver schema/read-only/conservative authority fields: matched.
- Expected worktree authority row for B-381e: matched (`authority=worktree`,
  `authoritativeCwd=.worktrees/B-381e`).
- Expected snapshot sections: matched; output included authority ladder, story
  board, capability matrix, recovery, and parallel projections.
- Expected localDone↔productionDone gap visibility: matched; B-b95c appears as
  `localDone=true`, `productionDone=false`, `blocks-production-done`.
- Expected no UI/dashboard work in M1: matched; contract smoke asserts
  `dashboard.ts` is not wired to `story_authority_resolve` or
  `observability_snapshot`.

## Note

The bare `lattice` binary in this machine currently points at the previously
installed global package, so the new command names are verified through the
project-local built CLI (`node packages/main/dist/cli.js`). After this package
version is installed or linked, the same command registry is exposed by the
`lattice` bin.
