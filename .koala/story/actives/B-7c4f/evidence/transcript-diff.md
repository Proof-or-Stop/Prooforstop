# B-7c4f Transcript Diff

## Expected

- `koala session_brief` works from the story worktree in recovery contexts.
- `koala validate` passes using discovered project validation commands.
- `cd packages/main && npm run test:flow-stability-smoke` covers all-phase `session_brief`, opt-in reviewer gates, and global `@koala-agent/core` link cleanup behavior.

## Actual

```text
$ koala session_brief
# koala session brief
Story: B-7c4f
Phase: TEST
DONE pre-check:
  test evidence: PASS
  bugs: all fixed
  branch synced with main: yes
```

```text
$ koala validate
Project validation commands passed
cli-e2e: story-lifecycle PASS
cli-e2e: gap-convergence PASS
ALL PASS
warning: validate.ts not found; used language/project validation command discovery
```

```text
$ cd packages/main && npm run test:flow-stability-smoke
✓ flow stability smoke passed
```

## Diff

No product-facing mismatch found. The `validate.ts not found` warning is expected for this repository because Koala now discovers and runs the project validation command instead of requiring a TypeScript-only validation entrypoint.
