# B-8f4c User-Value Transcript Diff

## Expected

- The user can open `docs/requirements/decisions/stash-split-execution-plan.md`
  and see an executable, bucketed plan for processing `stash@{0}` without
  applying the whole stash.
- The plan prevents the three reviewed correctness failures:
  - dev-memory data is not falsely treated as `.gitignore` evidence;
  - stale `docs/requirements/NAV.md` is not restored from the stash;
  - executable stash commands bind to a stable stash object before restore,
    diff, show, or inventory actions.
- `docs/requirements/NAV.md` includes the new decision and still matches the
  current decisions catalog.

## Actual Transcript

Command:

```bash
lattice validate --story=B-8f4c --json
```

Result:

```text
status: pass
allPass: true
summary: Project validation commands passed; validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery
npm test: pass
cli-e2e: ALL PASS
verification intent coverage: 9/9 covered
missing required evidence: 0
```

Additional real-machine checks run during review:

```text
STASH_OBJECT resolved to c4dcc3aff95fd999712d7f19dcf856f791cf0d05.
The resolved stash subject is "On main: park unrelated lattice path cleanup and layer4 doc before B-b5b2 DONE".
The stash inventory still contains the 12 documented paths.
The untracked third parent still contains only:
  .lattice/dev-memory/experience.jsonl
  docs/requirements/decisions/unlock-layer4-production-safety-suite.md
NAV contains 37 decision links for 37 decision markdown files.
Reviewer lanes concept, quality, test-coverage, and docs all passed after the final stable stash object fix.
```

## Diff Notes

- Expected and actual match for the executable plan: the document now uses
  `EXPECTED_STASH_OBJECT` plus `STASH_OBJECT` for executable stash access.
- Expected and actual match for NAV: the current NAV remains 37, and the future
  Layer 4 bucket must hand-merge the Layer 4 link/count from current state.
- Expected and actual match for safety: no stash content was restored, applied,
  popped, committed, or dropped by this story.
- No product-facing gap remains for this story: the deliverable is a decision
  document plus NAV entry, not execution of the parked stash buckets.
