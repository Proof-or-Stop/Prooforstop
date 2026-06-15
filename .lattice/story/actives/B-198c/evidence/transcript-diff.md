# B-198c real-machine transcript ↔ PLAN-outcome diff

Verified by running the **worktree's freshly-built CLI** (`node .worktrees/B-198c/packages/main/dist/cli.js`), NOT the global `lattice` binary (which resolves to the main-repo dist).

## Expected (understanding.outcome)

> Running `lattice doctor` on a wrapper-root project prints up front:
> `✗ storyDir resolves OUTSIDE the resolved gitRoot` + the storyDir & gitRoot abs paths + `→ configure storyDir so story metadata lives inside the gitRoot.`
> Normal case (metadataRoot == gitRoot / storyDir inside gitRoot): no violation.

## Actual #1 — VIOLATION (synthetic wrapper-root fixture = the ClawCreek scenario)

Fixture: metadataRoot=`/tmp/wrfix-b198c`, `gitRoot=repo`, `storyDir=.lattice/story/actives` (resolves OUTSIDE `repo/`).

```
storyDir / gitRoot scan:
  ✗ storyDir resolves OUTSIDE the resolved gitRoot
      storyDir: /private/tmp/wrfix-b198c/.lattice/story/actives
      gitRoot:  /private/tmp/wrfix-b198c/repo
      The git-backed lifecycle cannot commit story metadata from here.
      → configure storyDir so story metadata lives inside the gitRoot.
```

## Actual #2 — NORMAL (this repo: storyDir inside gitRoot)

```
storyDir / gitRoot scan:
  ✓ storyDir resolves inside the resolved gitRoot
```

## Diff notes

- **Match.** The violation block and remediation text match the PLAN outcome verbatim, with both absolute paths shown. The normal case is a healthy pass line (no false positive), satisfying the "no advisory/violation in the normal case" intent.
- This is precisely the situation the user originally hit on ClawCreek: previously it only surfaced LATE at `story_advance INIT_CHECK`; now `lattice doctor` reports it up front with the fix.
- The story_create / session_brief warn-only advisory (CHK-003) and the helper totality (CHK-002 fix) are covered by the consolidated suite `packages/main/src/tasks/storydir-inside-gitroot-suite.ts` (20 checks, `lattice validate` GREEN) and were re-verified by the Round-2 quality + test-coverage reviewers.
- The two late guards (`worktree.ts:754`, `cli-engine.ts:3367`) were left untouched (purely additive), per the plan.md scope banner.
