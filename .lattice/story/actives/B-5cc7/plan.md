# B-5cc7 Plan

## CHK-001 Restore Bucket A Dev-Memory Code Paths Only

Execute a tracked-path-only restore from the pinned stash object:

```bash
EXPECTED_STASH_OBJECT=c4dcc3aff95fd999712d7f19dcf856f791cf0d05
STASH_OBJECT=$(git rev-parse 'stash@{0}')
test "$STASH_OBJECT" = "$EXPECTED_STASH_OBJECT"
git restore --source "$STASH_OBJECT" -- \
  packages/main/src/core/dev-memory.ts \
  packages/main/src/handlers/dev-memory.ts
```

Stop if the stash object hash differs, if any non-Bucket-A path changes, or if
`.lattice/dev-memory/experience.jsonl` appears in `git status`.

## CHK-002 Add Focused Dev-Memory Legacy-Read Verification

Add one smoke task under `packages/main/src/tasks/` that seeds temporary
`.lattice` and legacy `.koala` dev-memory files, proves read fallback and
dedupe behavior, proves writes still target `.lattice`, and checks all entries
remain `gateEvidence=false` and `authority="non_authoritative"`.

Run:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/dev-memory-legacy-read-smoke.js
```

Stop if the smoke requires a broad package script change or touches unrelated
runtime artifact, planner, NAV, Layer 4, or smoke expectation files.

## CHK-003 Verify No Stashed Dev-Memory Data File Was Restored

Inspect the stashed data file only through the third stash parent:

```bash
git show "${STASH_OBJECT}^3:.lattice/dev-memory/experience.jsonl" | wc -l
git status --short --untracked-files=all
git diff --name-only main...HEAD
```

Pass only if `.lattice/dev-memory/experience.jsonl` is absent from the worktree,
index, and final material diff. Do not drop, pop, or whole-apply the stash.
